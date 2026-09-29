/**
 * =========================================================================
 * PR DOCUMENT GENERATOR - EXCEL (.xlsx) & PDF (.pdf)
 * Flow Force Enterprise Grade Document Standard
 * =========================================================================
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { query } = require('../db/pool');
const { logActivity } = require('./activityLogger');
require('dotenv').config();

const BASE_STORAGE_DIR = process.env.STORAGE_DIR || './storage';

function getDocumentStorageDir() {
  return path.isAbsolute(BASE_STORAGE_DIR)
    ? BASE_STORAGE_DIR
    : path.resolve(process.cwd(), BASE_STORAGE_DIR);
}

/**
 * Ensures project folder hierarchy exists:
 * storage/projects/[project_code]/purchase-requests/
 */
function ensureStorageDirectory(projectCode) {
  const cleanCode = (projectCode || 'GENERAL').replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseStorage = getDocumentStorageDir();
  const dir = path.join(baseStorage, 'projects', cleanCode, 'purchase-requests');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { dir, cleanCode };
}

/**
 * Format currency IDR helper
 */
function formatIdr(amount) {
  if (amount === null || amount === undefined || amount === '' || isNaN(amount) || Number(amount) < 0) return '—';
  return `IDR ${Number(amount).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/**
 * Generates both Excel (.xlsx) and PDF (.pdf) documents for a Purchase Request,
 * stores them in the project library, calculates SHA-256 checksums, and registers them in the database.
 */
async function generatePrDocuments(prId) {
  // 1. Fetch complete PR data with project, requester, approver, and items
  const prRes = await query(
    `SELECT pr.*, 
            p.project_code, p.project_name, p.job_location,
            u_req.full_name AS requester_name, u_req.username AS requester_username,
            u_app.full_name AS approver_name, u_app.username AS approver_username,
            u_rej.full_name AS rejecter_name, u_rej.username AS rejecter_username
     FROM purchase_requests pr
     LEFT JOIN projects p ON p.id = pr.project_id
     LEFT JOIN users u_req ON u_req.id = pr.created_by_user_id
     LEFT JOIN users u_app ON u_app.id = pr.approved_by_user_id
     LEFT JOIN users u_rej ON u_rej.id = pr.rejected_by_user_id
     WHERE pr.id = $1`,
    [prId]
  );

  if (prRes.rowCount === 0) throw new Error(`Purchase Request ID ${prId} not found.`);
  const pr = prRes.rows[0];

  const itemsRes = await query(
    `SELECT it.*,
            sd.id AS std_id,
            sd.version AS std_version,
            sd.file_name AS std_file_name,
            sd.original_file_name AS std_orig_file_name,
            sd.file_path_or_storage_key AS std_storage_key,
            sd.mime_type AS std_mime_type,
            pdoc.id AS prj_id,
            pdoc.file_name AS prj_file_name,
            pdoc.original_file_name AS prj_orig_file_name,
            pdoc.file_path_or_storage_key AS prj_storage_key,
            pdoc.mime_type AS prj_mime_type,
            doc.id AS drawing_id,
            doc.file_name AS drawing_file_name,
            doc.original_file_name AS drawing_orig_file_name,
            doc.file_path_or_storage_key AS drawing_storage_key,
            doc.mime_type AS drawing_mime_type,
            doc.file_size_bytes AS drawing_file_size
     FROM pr_items it
     LEFT JOIN standard_drawings sd ON sd.id = it.standard_drawing_id
     LEFT JOIN documents pdoc ON pdoc.id = it.project_drawing_document_id
     LEFT JOIN documents doc ON (doc.id = it.drawing_document_id OR (doc.purchase_request_item_id = it.id AND doc.document_type = 'ENGINEERING_DRAWING'))
     WHERE it.purchase_request_id = $1
     ORDER BY it.id ASC`,
    [prId]
  );
  const items = itemsRes.rows;

  const { dir, cleanCode } = ensureStorageDirectory(pr.project_code);

  const revNum = pr.revision !== undefined && pr.revision !== null ? pr.revision : 0;
  const revStr = String(revNum).padStart(2, '0');

  // Professional file naming with revision support: PR-2026-0001_Rev-00.pdf
  const pdfFileName = `${pr.pr_number}_Rev-${revStr}.pdf`;
  const excelFileName = `${pr.pr_number}_Rev-${revStr}.xlsx`;
  const legacyPdfFileName = `${pr.pr_number}.pdf`;
  const legacyExcelFileName = `${pr.pr_number}.xlsx`;

  const pdfFilePath = path.join(dir, pdfFileName);
  const excelFilePath = path.join(dir, excelFileName);
  const legacyPdfFilePath = path.join(dir, legacyPdfFileName);
  const legacyExcelFilePath = path.join(dir, legacyExcelFileName);

  // Relative storage keys for portable database storage
  const excelStorageKey = path.relative(process.cwd(), excelFilePath).replace(/\\/g, '/');
  const pdfStorageKey = path.relative(process.cwd(), pdfFilePath).replace(/\\/g, '/');

  // 2. Generate Excel (.xlsx) using SheetJS
  generateExcelFile(pr, items, excelFilePath);
  try { fs.copyFileSync(excelFilePath, legacyExcelFilePath); } catch (e) {}

  // 3. Generate PDF (.pdf) using PDFKit
  const pdfBuffer = await generatePdfFile(pr, items, pdfFilePath);
  try { fs.copyFileSync(pdfFilePath, legacyPdfFilePath); } catch (e) {}

  // 4. Calculate SHA-256 Checksum and file size
  const sha256Checksum = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const fileSizeBytes = pdfBuffer.length;

  // 5. Save metadata into documents table (Preserve historical versions, update idempotently)
  const existingPdfDoc = await query(
    `SELECT id FROM documents WHERE purchase_request_id = $1 AND document_type = 'PR_PDF' AND revision = $2`,
    [prId, revNum]
  );
  let pdfDocId;
  if (existingPdfDoc.rowCount > 0) {
    pdfDocId = existingPdfDoc.rows[0].id;
    await query(
      `UPDATE documents 
       SET file_name = $1, file_path_or_storage_key = $2, sha256_checksum = $3, file_size_bytes = $4
       WHERE id = $5`,
      [pdfFileName, pdfStorageKey, sha256Checksum, fileSizeBytes, pdfDocId]
    );
  } else {
    const ins = await query(
      `INSERT INTO documents (project_id, purchase_request_id, document_type, file_name, file_path_or_storage_key, uploaded_by_user_id, revision, sha256_checksum, file_size_bytes)
       VALUES ($1, $2, 'PR_PDF', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [pr.project_id, prId, pdfFileName, pdfStorageKey, pr.created_by_user_id, revNum, sha256Checksum, fileSizeBytes]
    );
    pdfDocId = ins.rows[0].id;
  }

  // Also manage Excel document record
  const existingXlsDoc = await query(
    `SELECT id FROM documents WHERE purchase_request_id = $1 AND document_type = 'PR_EXCEL' AND revision = $2`,
    [prId, revNum]
  );
  if (existingXlsDoc.rowCount > 0) {
    await query(
      `UPDATE documents 
       SET file_name = $1, file_path_or_storage_key = $2
       WHERE id = $3`,
      [excelFileName, excelStorageKey, existingXlsDoc.rows[0].id]
    );
  } else {
    await query(
      `INSERT INTO documents (project_id, purchase_request_id, document_type, file_name, file_path_or_storage_key, uploaded_by_user_id, revision)
       VALUES ($1, $2, 'PR_EXCEL', $3, $4, $5, $6)`,
      [pr.project_id, prId, excelFileName, excelStorageKey, pr.created_by_user_id, revNum]
    );
  }

  // 6. Record Activity Log: DOCUMENT_GENERATED
  await logActivity({
    entityType: 'PURCHASE_REQUEST',
    entityId: pr.pr_number,
    action: 'DOCUMENT_GENERATED',
    userId: pr.created_by_user_id,
    username: pr.requester_username,
    metadata: {
      prNumber: pr.pr_number,
      documentId: pdfDocId,
      revision: revNum,
      revisionString: `Rev ${revStr}`,
      fileType: 'PR_PDF',
      fileName: pdfFileName,
      sha256Checksum,
      fileSizeBytes
    }
  });
  const result = {
    excelFilePath,
    pdfFilePath,
    excelPath: excelFilePath,
    pdfPath: pdfFilePath,
    excelFileName,
    pdfFileName,
    sha256Checksum,
    revision: revNum,
    pdfDoc: {
      id: pdfDocId,
      fileName: pdfFileName,
      filePath: pdfStorageKey,
      absolutePath: pdfFilePath,
      sha256Checksum,
      revision: revNum,
      fileSizeBytes
    },
    excelDoc: {
      fileName: excelFileName,
      filePath: excelStorageKey,
      absolutePath: excelFilePath,
      revision: revNum
    }
  };

  return result;
}

/**
 * Internal helper: Build Excel Workbook
 */
function generateExcelFile(pr, items, filePath) {
  if (pr && pr.pr && Array.isArray(pr.items) && !items) {
    items = pr.items;
    pr = pr.pr;
  } else if (!Array.isArray(items) && pr && Array.isArray(pr.items)) {
    if (typeof items === 'string') {
      filePath = items;
    }
    items = pr.items;
  }
  items = items || [];
  pr = pr || {};

  const wb = XLSX.utils.book_new();

  const reqDate = pr.created_at ? new Date(pr.created_at).toLocaleDateString('en-GB') : '-';
  const needDate = pr.required_date ? new Date(pr.required_date).toLocaleDateString('en-GB') : '-';
  const appDate = pr.approved_at ? new Date(pr.approved_at).toLocaleDateString('en-GB') : '-';
  const rejDate = pr.rejected_at ? new Date(pr.rejected_at).toLocaleDateString('en-GB') : '-';
  const revStr = String(pr.revision || 0).padStart(2, '0');

  const rows = [
    ['PT. FLOW FORCE INDONESIA'],
    ['Kawasan Industri Delta Silicon 5, Jl. Kenari 1 Blok G1 No. 23D, Cikarang, Bekasi, Indonesia'],
    ['Phone: +62 21 2961 7055 | Email: flowforce@flow-force.com | www.flow-force.com'],
    [],
    ['PURCHASE REQUISITION', '', '', '', '', '', '', `Revision: Rev ${revStr}`],
    [],
    ['PROJECT / REQUEST INFORMATION', '', '', ''],
    ['PR Number:', pr.pr_number || pr.prNumber, 'Status:', pr.status],
    ['Project / PID:', pr.project_code || pr.projectId || '-', 'Job Location:', pr.job_location || pr.jobLocation || '-'],
    ['Project Name:', pr.project_name || pr.projectName || '-', 'Request Date:', reqDate],
    ['Created By:', pr.requester_name || pr.requestedBy || '-', 'Username:', pr.requester_username || '-'],
    ['Department:', pr.department || '-', 'Required Date:', needDate],
    ['Urgency:', pr.urgency || 'Standard', 'Revision:', `Rev ${revStr}`],
    [],
    [
      '#',
      'SKU',
      'Product Name',
      'Item Description',
      'Specification',
      'Material / Grade',
      'Original Dimensions',
      'Supply Type',
      'Required Cut Size',
      'Unit',
      'Quantity',
      'Unit Price (IDR)',
      'Estimated Total (IDR)',
      'Remarks',
      'Ducting Type',
      'Ducting Dimensions',
      'Standard Drawing Version',
      'Standard Drawing Reference'
    ]
  ];

  let grandTotal = 0;
  let allHaveCost = true;

  items.forEach((it, idx) => {
    const rawPrice = (it.unit_price !== undefined && it.unit_price !== null) ? it.unit_price : it.unitPrice;
    const rawCost = (it.estimated_total_cost !== undefined && it.estimated_total_cost !== null) ? it.estimated_total_cost : it.estimatedTotalCost;
    const hasPrice = rawPrice !== null && rawPrice !== undefined && rawPrice !== '' && !isNaN(Number(rawPrice)) && Number(rawPrice) >= 0;
    const cost = hasPrice ? (parseFloat(rawCost) || (parseFloat(it.quantity) * parseFloat(rawPrice))) : null;
    if (cost !== null) {
      grandTotal += cost;
    } else {
      allHaveCost = false;
    }

    const isCut = (it.supply_type === 'Cut Size' || it.supplyType === 'Cut Size' || it.purchase_type === 'PROJECT-SPECIFIC CUT SIZE');
    let cutSizeText = '—';
    if (isCut) {
      const cLen = it.cut_length || it.cutLength;
      const cWid = it.cut_width || it.cutWidth;
      const rawCut = it.required_cut_size || it.requiredCutSize;
      if (rawCut) cutSizeText = rawCut;
      else if (cLen) cutSizeText = cWid ? `${cLen} × ${cWid} mm` : `${cLen} mm`;
    }

    const ductDims = [];
    if (it.dim_a) ductDims.push(`Ø A: ${it.dim_a} mm`);
    if (it.dim_b) ductDims.push(`Ø B: ${it.dim_b} mm`);
    if (it.dim_c) ductDims.push(`Ø C: ${it.dim_c} mm`);
    if (it.angle_d) ductDims.push(`Angle D: ${it.angle_d}°`);
    if (it.angle_b) ductDims.push(`Angle B: ${it.angle_b}°`);
    if (it.radius) ductDims.push(`Radius: ${it.radius} mm`);
    if (it.dim_l1) ductDims.push(`L1: ${it.dim_l1} mm`);
    if (it.dim_l2) ductDims.push(`L2: ${it.dim_l2} mm`);
    if (it.thickness) ductDims.push(`Thickness: ${it.thickness} mm`);

    rows.push([
      idx + 1,
      it.sku || (it.ducting_type ? 'DUCTING' : '—'),
      it.product_name || it.productName || '-',
      it.item_description || it.itemDescription || '',
      it.specification || '',
      it.material_grade || it.material || it.materialGrade || '-',
      it.size_dimensions || it.originalDimensions || it.size || '-',
      it.ducting_type ? 'PROJECT-SPECIFIC DUCTING' : (isCut ? 'CUT SIZE' : 'FULL SIZE'),
      cutSizeText,
      it.unit || (it.ducting_type ? 'Pcs' : 'Sheet'),
      it.quantity,
      hasPrice ? Number(rawPrice) : '—',
      cost !== null ? cost : '—',
      it.remarks || '',
      it.ducting_type || '',
      ductDims.join(', '),
      it.standard_drawing_version ? (`V${it.standard_drawing_version}`) : (it.std_version ? `V${it.std_version}` : '—'),
      it.std_orig_file_name || it.std_file_name || '—'
    ]);
  });

  rows.push([]);
  rows.push([
    '', '', '', '', '', '', '', '', '', '',
    'GRAND TOTAL (IDR):',
    allHaveCost ? grandTotal : '—'
  ]);

  rows.push([]);
  rows.push(['REASON FOR PURCHASE:', pr.reason_for_purchase || pr.reasonForPurchase || '']);
  rows.push(['REMARKS:', pr.remarks || '']);

  rows.push([]);
  rows.push(['APPROVAL RECORD', '', '', '']);
  rows.push(['Requested By:', pr.requester_name || pr.requestedBy || '-', 'Date:', reqDate]);
  if (pr.status === 'APPROVED') {
    rows.push(['Approved By:', pr.approver_name || 'Admin', 'Approval Date:', appDate]);
  } else if (pr.status === 'REJECTED') {
    rows.push(['Rejected By:', pr.rejecter_name || 'Admin', 'Rejection Date:', rejDate]);
    rows.push(['Rejection Reason:', pr.rejection_reason || '-']);
  } else {
    rows.push(['Approval Status:', 'Pending Administrative Review']);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);

  ws['!cols'] = [
    { wch: 5 },  // #
    { wch: 14 }, // SKU
    { wch: 30 }, // Product Name
    { wch: 45 }, // Description
    { wch: 20 }, // Specification
    { wch: 18 }, // Material
    { wch: 22 }, // Dimensions
    { wch: 15 }, // Supply Type
    { wch: 20 }, // Required Cut
    { wch: 10 }, // Unit
    { wch: 12 }, // Quantity
    { wch: 18 }, // Unit Price
    { wch: 20 }, // Total Cost
    { wch: 25 }, // Remarks
    { wch: 18 }, // Ducting Type
    { wch: 30 }  // Ducting Dimensions
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Purchase Requisition');

  if (filePath) {
    XLSX.writeFile(wb, filePath);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Internal helper: Build PDF Document (PDFKit)
 * Flow Force Enterprise Grade Corporate Document
 */
async function generatePdfFile(pr, items, filePath) {
  if (pr && pr.pr && Array.isArray(pr.items) && !items) {
    items = pr.items;
    pr = pr.pr;
  } else if (!Array.isArray(items) && pr && Array.isArray(pr.items)) {
    if (typeof items === 'string') {
      filePath = items;
    }
    items = pr.items;
  }
  items = items || [];
  pr = pr || {};

  const revNum = pr.revision !== undefined && pr.revision !== null ? pr.revision : 0;
  const revStr = String(revNum).padStart(2, '0');

  // Build verification URL for QR code
  const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
  const verifyUrl = `${baseUrl}/pr/${encodeURIComponent(pr.pr_number || pr.prNumber)}/verify`;
  let qrBuffer = null;
  try {
    qrBuffer = await QRCode.toBuffer(verifyUrl, { width: 90, margin: 0 });
  } catch (qrErr) {
    console.warn('[DocumentGenerator] Failed to generate QR code:', qrErr.message);
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        bufferPages: true,
        autoFirstPage: true,
        info: {
          Title: `Purchase Requisition ${pr.pr_number || pr.prNumber} Rev ${revStr}`,
          Author: 'PT. Flow Force Indonesia',
          Subject: `Purchase Requisition ${pr.pr_number || pr.prNumber}`
        }
      });

      const buffers = [];
      doc.on('data', b => buffers.push(b));
      doc.on('end', async () => {
        try {
          let finalBuffer = Buffer.concat(buffers);

          // Append Engineering Drawings Appendix using pdf-lib if any items have drawings
          const hasAnyDrawings = items.some(it => 
            it.std_storage_key || it.standard_drawing_id || it.standardDrawingId ||
            it.prj_storage_key || it.project_drawing_document_id ||
            it.drawing_storage_key || it.drawingDocumentId || it.drawing_document_id
          );

          if (hasAnyDrawings) {
            try {
              const { PDFDocument: PDFLibDoc, rgb, StandardFonts } = require('pdf-lib');
              const mainPdf = await PDFLibDoc.load(finalBuffer);
              const fontBold = await mainPdf.embedFont(StandardFonts.HelveticaBold);
              const fontRegular = await mainPdf.embedFont(StandardFonts.Helvetica);

              const appendSingleDrawing = async (item, itemIdx, drwCategory, storageKey, fileName, mimeType) => {
                if (!storageKey) return;
                const { resolveStoragePath } = require('../routes/documents');
                const physicalPath = resolveStoragePath ? resolveStoragePath(storageKey) : path.resolve(process.cwd(), storageKey);
                if (!physicalPath || !fs.existsSync(physicalPath)) {
                  console.warn(`[DocumentGenerator] Drawing file not found at ${physicalPath} for item ${item.id}`);
                  return;
                }

                const fileBytes = fs.readFileSync(physicalPath);
                const isPdf = (mimeType && mimeType.includes('pdf')) || String(fileName || physicalPath).toLowerCase().endsWith('.pdf');
                const isImg = (mimeType && mimeType.startsWith('image/')) || /\.(png|jpe?g|webp|svg)$/i.test(fileName || physicalPath);

                if (isPdf) {
                  const appendixPage = mainPdf.addPage([595.28, 841.89]); // A4
                  const { width, height } = appendixPage.getSize();

                  appendixPage.drawRectangle({
                    x: 36,
                    y: height - 60,
                    width: width - 72,
                    height: 24,
                    color: rgb(0.008, 0.518, 0.78)
                  });

                  appendixPage.drawText(drwCategory, {
                    x: 48,
                    y: height - 52,
                    size: 10,
                    font: fontBold,
                    color: rgb(1, 1, 1)
                  });

                  appendixPage.drawRectangle({
                    x: 36,
                    y: height - 195,
                    width: width - 72,
                    height: 125,
                    borderColor: rgb(0.8, 0.835, 0.882),
                    borderWidth: 1,
                    color: rgb(0.973, 0.98, 0.988)
                  });

                  appendixPage.drawText(`PR Number: ${pr.pr_number || pr.prNumber || '-'}`, {
                    x: 50,
                    y: height - 90,
                    size: 9.5,
                    font: fontBold,
                    color: rgb(0.06, 0.09, 0.16)
                  });

                  appendixPage.drawText(`Item: #${itemIdx + 1} — ${item.product_name || item.productName || 'Ducting'}`, {
                    x: 50,
                    y: height - 110,
                    size: 9,
                    font: fontBold,
                    color: rgb(0.06, 0.09, 0.16)
                  });

                  appendixPage.drawText(`Type: ${item.ducting_type || item.ductingType || 'Custom'} | Category: ${drwCategory}`, {
                    x: 50,
                    y: height - 130,
                    size: 8.5,
                    font: fontRegular,
                    color: rgb(0.28, 0.33, 0.41)
                  });

                  appendixPage.drawText(`Drawing Reference: ${fileName || path.basename(physicalPath)}`, {
                    x: 50,
                    y: height - 150,
                    size: 8.5,
                    font: fontBold,
                    color: rgb(0.008, 0.518, 0.78)
                  });

                  appendixPage.drawText('Note: Original drawing specification appended below preserving 100% vector fidelity.', {
                    x: 50,
                    y: height - 175,
                    size: 8,
                    font: fontRegular,
                    color: rgb(0.39, 0.45, 0.55)
                  });

                  const drwPdf = await PDFLibDoc.load(fileBytes);
                  const copiedPages = await mainPdf.copyPages(drwPdf, drwPdf.getPageIndices());
                  copiedPages.forEach(cp => mainPdf.addPage(cp));
                } else if (isImg) {
                  const appendixPage = mainPdf.addPage([595.28, 841.89]);
                  const { width, height } = appendixPage.getSize();

                  appendixPage.drawRectangle({
                    x: 36,
                    y: height - 60,
                    width: width - 72,
                    height: 24,
                    color: rgb(0.008, 0.518, 0.78)
                  });

                  appendixPage.drawText(drwCategory, {
                    x: 48,
                    y: height - 52,
                    size: 10,
                    font: fontBold,
                    color: rgb(1, 1, 1)
                  });

                  appendixPage.drawText(`PR: ${pr.pr_number || pr.prNumber || '-'} | Item #${itemIdx + 1} | ${fileName || path.basename(physicalPath)}`, {
                    x: 36,
                    y: height - 76,
                    size: 8,
                    font: fontRegular,
                    color: rgb(0.28, 0.33, 0.41)
                  });

                  let embeddedImg = null;
                  if (/\.png$/i.test(physicalPath) || (mimeType && mimeType.includes('png'))) {
                    embeddedImg = await mainPdf.embedPng(fileBytes);
                  } else {
                    embeddedImg = await mainPdf.embedJpg(fileBytes);
                  }

                  const maxWidth = width - 72;
                  const maxHeight = height - 120;
                  const scale = Math.min(maxWidth / embeddedImg.width, maxHeight / embeddedImg.height, 1);
                  const imgW = embeddedImg.width * scale;
                  const imgH = embeddedImg.height * scale;
                  const imgX = 36 + (maxWidth - imgW) / 2;
                  const imgY = 36 + (maxHeight - imgH) / 2;

                  appendixPage.drawImage(embeddedImg, {
                    x: imgX,
                    y: imgY,
                    width: imgW,
                    height: imgH
                  });
                }
              };

              for (let i = 0; i < items.length; i++) {
                const item = items[i];

                // 1. Standard Reference Drawing
                let stdStorageKey = item.std_storage_key;
                let stdFileName = item.std_orig_file_name || item.std_file_name;
                let stdMimeType = item.std_mime_type;
                if (!stdStorageKey && item.standard_drawing_id) {
                  const sRes = await query('SELECT * FROM standard_drawings WHERE id = $1', [item.standard_drawing_id]);
                  if (sRes.rowCount > 0) {
                    stdStorageKey = sRes.rows[0].file_path_or_storage_key;
                    stdFileName = sRes.rows[0].original_file_name || sRes.rows[0].file_name;
                    stdMimeType = sRes.rows[0].mime_type;
                  }
                }
                if (stdStorageKey) {
                  const verStr = item.standard_drawing_version || item.std_version || 1;
                  await appendSingleDrawing(item, i, `STANDARD DUCTING DRAWING (VERSION ${verStr})`, stdStorageKey, stdFileName, stdMimeType);
                }
              }

              const mergedBytes = await mainPdf.save();
              finalBuffer = Buffer.from(mergedBytes);
            } catch (pdfMergeErr) {
              console.error('[DocumentGenerator] Failed to merge drawing into PDF:', pdfMergeErr);
            }
          }

          if (filePath) {
            try {
              fs.writeFileSync(filePath, finalBuffer);
            } catch (writeErr) {
              return reject(writeErr);
            }
          }
          resolve(finalBuffer);
        } catch (endErr) {
          reject(endErr);
        }
      });
      doc.on('error', err => reject(err));

      const primaryColor = '#0284c7';
      const textColor = '#0f172a';
      const mutedColor = '#64748b';
      const borderColor = '#cbd5e1';

      const logoPath = path.resolve(__dirname, '../../assets/flow-force-logo.png');

      // =========================================================================
      // 1. FLOW FORCE OFFICIAL LETTERHEAD
      // =========================================================================
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 36, 30, { width: 155 });
      } else {
        doc.fontSize(16).font('Helvetica-Bold').fillColor(primaryColor).text('FLOW FORCE', 36, 32);
        doc.fontSize(7.5).font('Helvetica').fillColor(mutedColor).text('Bulk Material Handling & Processing Equipment Specialists', 36, 52);
      }

      // Company Contact Info (Right aligned, exactly matching official letterhead)
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(textColor).text('PT. Flow Force Indonesia', 300, 26, { align: 'right', width: 259 });
      doc.fontSize(7).font('Helvetica').fillColor('#475569');
      doc.text('Kawasan Industri Delta Silicon 5', 300, 38, { align: 'right', width: 259 });
      doc.text('Jl. Kenari 1 Blok G1 No. 23D', 300, 48, { align: 'right', width: 259 });
      doc.text('Cikarang, Bekasi, Indonesia', 300, 58, { align: 'right', width: 259 });
      doc.text('Phone : +62 21 2961 7055 | Fax : +62 21 2961 7056', 300, 68, { align: 'right', width: 259 });
      doc.text('Email : flowforce@flow-force.com | Website : www.flow-force.com', 300, 78, { align: 'right', width: 259 });

      // Clean divider line below letterhead
      doc.moveTo(36, 92).lineTo(559, 92).strokeColor(primaryColor).lineWidth(1.5).stroke();

      // =========================================================================
      // 2. DOCUMENT TITLE & IDENTIFIERS
      // =========================================================================
      let y = 99;
      doc.fontSize(14).font('Helvetica-Bold').fillColor(textColor).text('PURCHASE REQUISITION', 36, y);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(primaryColor).text(`PR No: ${pr.pr_number || pr.prNumber}`, 320, y, { align: 'right', width: 239 });
      doc.fontSize(8).font('Helvetica-Bold').fillColor(mutedColor).text(`Revision: Rev ${revStr}`, 320, y + 13, { align: 'right', width: 239 });

      y += 28;

      // =========================================================================
      // 3. STRUCTURED DOCUMENT INFORMATION CARD
      // =========================================================================
      const reqDate = pr.created_at ? new Date(pr.created_at).toLocaleDateString('en-GB') : '—';
      const needDate = pr.required_date ? new Date(pr.required_date).toLocaleDateString('en-GB') : '—';
      const cardHeight = 60;
      doc.rect(36, y, 523, cardHeight).fillAndStroke('#f8fafc', '#e2e8f0');

      const colLeftX = 46;
      const colRightX = 310;
      const infoY = y + 7;

      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(mutedColor).text('PR NUMBER: ', colLeftX, infoY, { continued: true })
         .font('Helvetica-Bold').fillColor(primaryColor).text(pr.pr_number || pr.prNumber);
      doc.font('Helvetica-Bold').fillColor(mutedColor).text('PROJECT / PID: ', colLeftX, infoY + 13, { continued: true })
         .font('Helvetica').fillColor(textColor).text(`${pr.project_code || '—'} — ${pr.project_name || 'General'}`);
      doc.font('Helvetica-Bold').fillColor(mutedColor).text('DEPARTMENT: ', colLeftX, infoY + 26, { continued: true })
         .font('Helvetica').fillColor(textColor).text(pr.department || 'Engineering');
      doc.font('Helvetica-Bold').fillColor(mutedColor).text('JOB LOCATION: ', colLeftX, infoY + 39, { continued: true })
         .font('Helvetica').fillColor(textColor).text(pr.job_location || '—');

      // Right column
      const statusColor = pr.status === 'APPROVED' ? '#059669' : (pr.status === 'REJECTED' ? '#e11d48' : '#d97706');
      doc.font('Helvetica-Bold').fillColor(mutedColor).text('REQUESTED BY: ', colRightX, infoY, { continued: true })
         .font('Helvetica').fillColor(textColor).text(`${pr.requester_name || pr.requestedBy || '—'} (${pr.requester_username || '—'})`);
      doc.font('Helvetica-Bold').fillColor(mutedColor).text('REQUEST DATE: ', colRightX, infoY + 13, { continued: true })
         .font('Helvetica').fillColor(textColor).text(reqDate);
      doc.font('Helvetica-Bold').fillColor(mutedColor).text('REQUIRED DATE: ', colRightX, infoY + 26, { continued: true })
         .font('Helvetica').fillColor(textColor).text(needDate);
      doc.font('Helvetica-Bold').fillColor(mutedColor).text('STATUS / URGENCY: ', colRightX, infoY + 39, { continued: true })
         .font('Helvetica-Bold').fillColor(statusColor).text(pr.status || 'PENDING', { continued: true })
         .font('Helvetica').fillColor(mutedColor).text(` | ${pr.urgency || 'Standard'}`);

      y += cardHeight + 10;

      // =========================================================================
      // 4. PR ITEM TABLE WITH REPEATING HEADER
      // =========================================================================
      function renderTableHeader(curY) {
        doc.rect(36, curY, 523, 16).fillAndStroke('#f1f5f9', '#cbd5e1');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#334155');
        doc.text('#', 38, curY + 4, { width: 16, align: 'center' });
        doc.text('SKU', 56, curY + 4, { width: 55 });
        doc.text('Product Name & Specification', 113, curY + 4, { width: 165 });
        doc.text('Material / Orig. Size', 280, curY + 4, { width: 80 });
        doc.text('Supply / Cut Size', 362, curY + 4, { width: 68 });
        doc.text('Qty / Unit', 432, curY + 4, { width: 40, align: 'center' });
        doc.text('Unit Price (IDR)', 474, curY + 4, { width: 42, align: 'right' });
        doc.text('Est. Total (IDR)', 518, curY + 4, { width: 38, align: 'right' });
        return curY + 16;
      }

      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(primaryColor).text('MATERIAL ITEMS & SPECIFICATIONS', 36, y);
      y += 13;
      y = renderTableHeader(y);

      let grandTotal = 0;
      let hasPrices = false;

      items.forEach((it, idx) => {
        const rawPrice = (it.unit_price !== undefined && it.unit_price !== null) ? it.unit_price : it.unitPrice;
        const rawCost = (it.estimated_total_cost !== undefined && it.estimated_total_cost !== null) ? it.estimated_total_cost : it.estimatedTotalCost;
        const priceNum = (rawPrice !== null && rawPrice !== undefined && rawPrice !== '' && !isNaN(Number(rawPrice))) ? Number(rawPrice) : null;
        const q = parseFloat(it.quantity) || 1;
        const costNum = priceNum !== null ? (rawCost !== null && rawCost !== undefined ? Number(rawCost) : (priceNum * q)) : null;

        if (costNum !== null) {
          grandTotal += costNum;
          hasPrices = true;
        }

        const pName = it.product_name || it.productName || '—';
        const pDesc = it.item_description || it.itemDescription || '';
        const pSpec = it.specification || '';
        const matGrade = it.material_grade || it.material || it.materialGrade || '—';
        const origDims = it.size_dimensions || it.sizeDimensions || it.size || '—';

        const isDucting = Boolean(it.ducting_type);
        const isFastener = !isDucting && ((it.category || '').toLowerCase() === 'fasteners' || /fastener|bolt|screw|nut|stud/i.test(`${pName} ${pDesc}`));
        const isCut = !isDucting && !isFastener && (it.supply_type === 'Cut Size' || it.supplyType === 'Cut Size' || it.purchase_type === 'PROJECT-SPECIFIC CUT SIZE');

        let cutDisplay = '—';
        if (isCut) {
          const rawCut = it.required_cut_size || it.requiredCutSize;
          if (rawCut) cutDisplay = rawCut;
          else if (it.cut_length) cutDisplay = it.cut_width ? `${it.cut_length} × ${it.cut_width} mm` : `${it.cut_length} mm`;
        }

        // Measure row height
        doc.fontSize(7.5).font('Helvetica-Bold');
        const nameH = doc.heightOfString(pName, { width: 165 });
        doc.fontSize(6.5).font('Helvetica');
        const descH = pDesc ? doc.heightOfString(pDesc, { width: 165 }) : 0;
        const specH = pSpec ? doc.heightOfString(`Spec: ${pSpec}`, { width: 165 }) : 0;
        const remH = it.remarks ? doc.heightOfString(`Remarks: ${it.remarks}`, { width: 165 }) : 0;
        const col3H = nameH + (descH ? descH + 2 : 0) + (specH ? specH + 2 : 0) + (remH ? remH + 2 : 0);

        const rowH = Math.max(col3H + 6, 22);

        // Check page overflow
        if (y + rowH > 730) {
          doc.addPage();
          // Top runner on page 2+
          doc.fontSize(7).font('Helvetica-Bold').fillColor(mutedColor).text(
            `PT. FLOW FORCE INDONESIA  —  PURCHASE REQUISITION ${pr.pr_number || pr.prNumber} (Rev ${revStr})`,
            36, 24
          );
          y = renderTableHeader(36);
        }

        const rowStartY = y;
        // Col 1: #
        doc.fontSize(7).font('Helvetica').fillColor(mutedColor).text(String(idx + 1), 38, rowStartY + 3, { width: 16, align: 'center' });

        // Col 2: SKU
        doc.fontSize(7).font('Helvetica-Bold').fillColor(textColor).text(it.sku || (isDucting ? 'DUCTING' : '—'), 56, rowStartY + 3, { width: 55 });

        // Col 3: Product Name & Specs (preserve multiline)
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(textColor).text(pName, 113, rowStartY + 3, { width: 165 });
        let textY = rowStartY + 3 + nameH + 2;
        if (pDesc) {
          doc.fontSize(6.5).font('Helvetica').fillColor('#475569').text(pDesc, 113, textY, { width: 165 });
          textY += descH + 2;
        }
        if (pSpec) {
          doc.fontSize(6).font('Helvetica-Oblique').fillColor(mutedColor).text(`Spec: ${pSpec}`, 113, textY, { width: 165 });
          textY += specH + 2;
        }
        if (it.remarks) {
          doc.fontSize(6).font('Helvetica-Bold').fillColor(primaryColor).text(`Remarks: ${it.remarks}`, 113, textY, { width: 165 });
        }

        // Col 4: Material & Orig Size
        doc.fontSize(7).font('Helvetica-Bold').fillColor(textColor).text(matGrade, 280, rowStartY + 3, { width: 80 });
        doc.fontSize(6.5).font('Helvetica').fillColor(mutedColor).text(`Size: ${origDims}`, 280, rowStartY + 13, { width: 80 });

        // Col 5: Supply Type
        if (isDucting) {
          doc.fontSize(6.5).font('Helvetica-Bold').fillColor(primaryColor).text('DUCTING SPEC', 362, rowStartY + 3, { width: 68 });
        } else if (isCut) {
          doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#c2410c').text('CUT SIZE', 362, rowStartY + 3, { width: 68 });
          doc.fontSize(6).font('Helvetica').fillColor('#9a3412').text(cutDisplay, 362, rowStartY + 12, { width: 68 });
        } else {
          doc.fontSize(6.5).font('Helvetica').fillColor('#475569').text('FULL SIZE', 362, rowStartY + 3, { width: 68 });
        }

        // Col 6: Qty & Unit
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(textColor).text(String(q), 432, rowStartY + 3, { width: 40, align: 'center' });
        doc.fontSize(6.5).font('Helvetica').fillColor(mutedColor).text(it.unit || (isDucting ? 'Pcs' : 'Sheet'), 432, rowStartY + 13, { width: 40, align: 'center' });

        // Col 7: Unit Price (IDR)
        doc.fontSize(7).font('Helvetica').fillColor(textColor).text(priceNum !== null ? formatIdr(priceNum).replace('IDR ', '') : '—', 474, rowStartY + 3, { width: 42, align: 'right' });

        // Col 8: Total Cost (IDR)
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#059669').text(costNum !== null ? formatIdr(costNum).replace('IDR ', '') : '—', 518, rowStartY + 3, { width: 38, align: 'right' });

        y = rowStartY + rowH;
        doc.moveTo(36, y).lineTo(559, y).strokeColor('#f1f5f9').lineWidth(0.5).stroke();
      });

      // =========================================================================
      // 5. TOTALS
      // =========================================================================
      y += 6;
      doc.rect(290, y, 269, 20).fillAndStroke('#f8fafc', '#e2e8f0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155').text('ESTIMATED GRAND TOTAL (IDR):', 295, y + 5, { width: 140, align: 'right' });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#059669').text(hasPrices ? formatIdr(grandTotal) : '—', 440, y + 4, { width: 114, align: 'right' });

      y += 28;

      // =========================================================================
      // 6. ENGINEERING / DUCTING SPECIFICATIONS
      // =========================================================================
      const ductingItems = items.filter(it => it.ducting_type);
      if (ductingItems.length > 0) {
        if (y + 60 > 720) {
          doc.addPage();
          y = 36;
        }
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor(primaryColor).text('ENGINEERING & DUCTING SPECIFICATIONS', 36, y);
        y += 12;

        ductingItems.forEach((dItem, dIdx) => {
          const dBoxH = 42;
          doc.rect(36, y, 523, dBoxH).fillAndStroke('#f0f9ff', '#bae6fd');
          doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#0369a1')
             .text(`Item #${dIdx + 1}: ${dItem.product_name || 'Ducting'} (${dItem.ducting_type})`, 44, y + 6);

          const dims = [];
          if (dItem.dim_a) dims.push(`Ø A: ${dItem.dim_a} mm`);
          if (dItem.dim_b) dims.push(`Ø B: ${dItem.dim_b} mm`);
          if (dItem.dim_c) dims.push(`Ø C: ${dItem.dim_c} mm`);
          if (dItem.angle_d) dims.push(`Angle D: ${dItem.angle_d}°`);
          if (dItem.angle_b) dims.push(`Angle B: ${dItem.angle_b}°`);
          if (dItem.radius) dims.push(`Radius: ${dItem.radius} mm`);
          if (dItem.dim_l1 || dItem.l1) dims.push(`L1: ${dItem.dim_l1 || dItem.l1} mm`);
          if (dItem.dim_l2 || dItem.l2) dims.push(`L2: ${dItem.dim_l2 || dItem.l2} mm`);
          if (dItem.thickness) dims.push(`Thickness: ${dItem.thickness} mm`);

          doc.fontSize(7).font('Helvetica').fillColor(textColor).text(dims.join('  |  '), 44, y + 20, { width: 505 });
          y += dBoxH + 8;
        });
      }

      // =========================================================================
      // 7. REQUISITION REASON & REMARKS
      // =========================================================================
      if (y + 45 > 720) {
        doc.addPage();
        y = 36;
      }
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(primaryColor).text('REQUISITION REASON & REMARKS', 36, y);
      y += 12;

      doc.rect(36, y, 523, 40).fillAndStroke('#f8fafc', '#e2e8f0');
      doc.fontSize(7).font('Helvetica-Bold').fillColor(mutedColor).text('REASON FOR PURCHASE: ', 44, y + 6, { continued: true })
         .font('Helvetica').fillColor(textColor).text(pr.reason_for_purchase || pr.reasonForPurchase || '(No reason specified)');
      if (pr.remarks) {
        doc.font('Helvetica-Bold').fillColor(mutedColor).text('REMARKS / INSTRUCTIONS: ', 44, y + 20, { continued: true })
           .font('Helvetica').fillColor(textColor).text(pr.remarks);
      }
      y += 48;

      // =========================================================================
      // 8. APPROVAL BLOCK & QR VERIFICATION
      // =========================================================================
      if (y + 80 > 720) {
        doc.addPage();
        y = 36;
      }
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(primaryColor).text('APPROVAL & DOCUMENT VERIFICATION', 36, y);
      y += 12;

      const appBoxH = 72;
      doc.rect(36, y, 523, appBoxH).fillAndStroke('#ffffff', borderColor);

      // Col 1: Requisitioned By
      doc.fontSize(7).font('Helvetica-Bold').fillColor(mutedColor).text('REQUISITIONED BY', 46, y + 7);
      doc.fontSize(8).font('Helvetica-Bold').fillColor(textColor).text(pr.requester_name || pr.requestedBy || 'Requester', 46, y + 18);
      doc.fontSize(6.5).font('Helvetica').fillColor(mutedColor).text(`Dept: ${pr.department || 'Engineering'}`, 46, y + 29);
      doc.text(`Date: ${reqDate}`, 46, y + 39);
      doc.text('Signature: ___________________', 46, y + 54);

      // Col 2: Management / Procurement Approval
      const appColX = 220;
      doc.fontSize(7).font('Helvetica-Bold').fillColor(mutedColor).text('MANAGEMENT / APPROVAL', appColX, y + 7);
      if (pr.status === 'APPROVED') {
        const appDate = pr.approved_at ? new Date(pr.approved_at).toLocaleDateString('en-GB') : '—';
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#059669').text(`✓ APPROVED`, appColX, y + 18);
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(textColor).text(pr.approver_name || 'System Administrator', appColX, y + 29);
        doc.fontSize(6.5).font('Helvetica').fillColor(mutedColor).text(`Approval Date: ${appDate}`, appColX, y + 40);
        doc.text('Status: Officially Approved for Procurement', appColX, y + 54);
      } else if (pr.status === 'REJECTED') {
        const rejDate = pr.rejected_at ? new Date(pr.rejected_at).toLocaleDateString('en-GB') : '—';
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#e11d48').text(`✕ REJECTED`, appColX, y + 18);
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(textColor).text(pr.rejecter_name || 'System Administrator', appColX, y + 29);
        doc.fontSize(6.5).font('Helvetica').fillColor(mutedColor).text(`Rejection Date: ${rejDate}`, appColX, y + 40);
        doc.text(`Reason: ${pr.rejection_reason || '-'}`, appColX, y + 54);
      } else {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#d97706').text('⏳ PENDING APPROVAL', appColX, y + 18);
        doc.fontSize(6.5).font('Helvetica').fillColor(mutedColor).text('Awaiting Administrative Review & Signature', appColX, y + 32);
        doc.text('Signature: ___________________', appColX, y + 54);
      }

      // Col 3: QR Code Verification
      const qrColX = 430;
      if (qrBuffer) {
        doc.image(qrBuffer, qrColX + 35, y + 6, { width: 52 });
        doc.fontSize(6).font('Helvetica-Bold').fillColor(primaryColor).text('SCAN TO VERIFY', qrColX + 25, y + 60, { width: 72, align: 'center' });
      }

      // =========================================================================
      // 9. TWO-PASS DOCUMENT CONTROL FOOTER ACROSS ALL PAGES
      // =========================================================================
      const range = doc.bufferedPageRange();
      const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 16);

      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc.moveTo(36, 804).lineTo(559, 804).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
        doc.fontSize(6.5).font('Helvetica').fillColor(mutedColor);
        doc.text(
          `Document: ${pr.pr_number || pr.prNumber}  |  Rev: ${revStr}  |  Status: ${pr.status || 'PENDING'}  |  Generated: ${nowStr}  |  Flow Force Indonesia`,
          36, 808, { width: 420 }
        );
        doc.text(`Page ${i + 1} of ${range.count}`, 460, 808, { width: 99, align: 'right' });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Safely checks all approved PRs, identifies any whose physical files
 * are missing on server storage, and regenerates them into persistent storage.
 */
async function restoreMissingApprovedPrDocuments() {
  const prRes = await query(
    `SELECT id, pr_number, status, project_id, created_by_user_id 
     FROM purchase_requests 
     WHERE status = 'APPROVED'
     ORDER BY id ASC`
  );

  const missingPrs = [];

  for (const pr of prRes.rows) {
    const docRes = await query(
      `SELECT * FROM documents WHERE purchase_request_id = $1`,
      [pr.id]
    );

    let needsRegen = docRes.rowCount === 0;
    for (const doc of docRes.rows) {
      const candidates = [
        path.resolve(process.cwd(), doc.file_path_or_storage_key),
        path.resolve(process.cwd(), doc.file_path_or_storage_key.replace(/^app[/\\]/, '')),
        path.resolve('/', doc.file_path_or_storage_key)
      ];
      const exists = candidates.some(c => fs.existsSync(c));
      if (!exists) {
        needsRegen = true;
        break;
      }
    }

    if (needsRegen) {
      missingPrs.push(pr);
    }
  }

  const restored = [];
  for (const pr of missingPrs) {
    console.log(`[Storage Recovery] Regenerating missing documents for approved PR #${pr.id} (${pr.pr_number})...`);
    await generatePrDocuments(pr.id);
    restored.push({ prId: pr.id, prNumber: pr.pr_number });
  }

  return {
    totalApprovedPrs: prRes.rowCount,
    missingPrCount: missingPrs.length,
    restoredPrs: restored
  };
}

module.exports = {
  generatePrDocuments,
  generateExcelFile,
  generatePdfFile,
  formatIdr,
  restoreMissingApprovedPrDocuments,
  getDocumentStorageDir
};
