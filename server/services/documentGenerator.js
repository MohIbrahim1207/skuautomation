/**
 * =========================================================================
 * PR DOCUMENT GENERATOR - EXCEL (.xlsx) & PDF (.pdf)
 * Flow Force White Enterprise Document Standard
 * =========================================================================
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const { query } = require('../db/pool');
require('dotenv').config();

const BASE_STORAGE_DIR = process.env.STORAGE_DIR || './storage';

/**
 * Ensures project folder hierarchy exists:
 * storage/projects/[project_code]/purchase-requests/
 */
function ensureStorageDirectory(projectCode) {
  const cleanCode = (projectCode || 'GENERAL').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(process.cwd(), BASE_STORAGE_DIR, 'projects', cleanCode, 'purchase-requests');
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
 * stores them in the project library, and registers them in the database.
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
    `SELECT * FROM pr_items WHERE purchase_request_id = $1 ORDER BY id ASC`,
    [prId]
  );
  const items = itemsRes.rows;

  const { dir, cleanCode } = ensureStorageDirectory(pr.project_code);

  const excelFileName = `${pr.pr_number}.xlsx`;
  const pdfFileName = `${pr.pr_number}.pdf`;

  const excelFilePath = path.join(dir, excelFileName);
  const pdfFilePath = path.join(dir, pdfFileName);

  // Relative storage keys for portable database storage
  const excelStorageKey = path.relative(process.cwd(), excelFilePath).replace(/\\/g, '/');
  const pdfStorageKey = path.relative(process.cwd(), pdfFilePath).replace(/\\/g, '/');

  // 2. Generate Excel (.xlsx) using SheetJS
  generateExcelFile(pr, items, excelFilePath);

  // 3. Generate PDF (.pdf) using PDFKit
  await generatePdfFile(pr, items, pdfFilePath);

  // 4. Save metadata into documents table (Allowed document types: PR_EXCEL, PR_PDF)
  // Delete existing records if regenerated
  await query(`DELETE FROM documents WHERE purchase_request_id = $1`, [prId]);

  await query(
    `INSERT INTO documents (project_id, purchase_request_id, document_type, file_name, file_path_or_storage_key, uploaded_by_user_id)
     VALUES ($1, $2, 'PR_EXCEL', $3, $4, $5)`,
    [pr.project_id, prId, excelFileName, excelStorageKey, pr.created_by_user_id]
  );

  await query(
    `INSERT INTO documents (project_id, purchase_request_id, document_type, file_name, file_path_or_storage_key, uploaded_by_user_id)
     VALUES ($1, $2, 'PR_PDF', $3, $4, $5)`,
    [pr.project_id, prId, pdfFileName, pdfStorageKey, pr.created_by_user_id]
  );

  return { excelFilePath, pdfFilePath, excelFileName, pdfFileName };
}

/**
 * Internal helper: Build Excel Workbook
 */
function generateExcelFile(pr, items, filePath) {
  if (!Array.isArray(items) && pr && Array.isArray(pr.items)) {
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

  const rows = [
    ['FLOW FORCE'],
    ['PURCHASE REQUEST DOCUMENT'],
    ['Bulk Material Handling & Processing Equipment Specialists'],
    [],
    ['PROJECT / REQUEST INFORMATION', '', '', ''],
    ['PR Number:', pr.pr_number || pr.prNumber, 'Status:', pr.status],
    ['Project / PID:', pr.project_code || pr.projectId || '-', 'Job Location:', pr.job_location || pr.jobLocation || '-'],
    ['Project Name:', pr.project_name || pr.projectName || '-', 'Request Date:', reqDate],
    ['Created By:', pr.requester_name || pr.requestedBy || '-', 'Username:', pr.requester_username || '-'],
    ['Department:', pr.department || '-', 'Required Date:', needDate],
    ['Urgency:', pr.urgency || 'Standard'],
    [],
    ['ITEM DETAILS', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['#', 'SKU', 'Product Name', 'Item Description', 'Material / Grade', 'Original Dimensions', 'Supply Type', 'Required Cut Size', 'Remarks', 'Unit', 'Quantity', 'Unit Price (IDR)', 'Estimated Total Cost (IDR)']
  ];

  let allHaveCost = true;
  let grandTotal = 0;
  items.forEach((it, idx) => {
    const rawPrice = (it.unit_price !== undefined && it.unit_price !== null) ? it.unit_price : it.unitPrice;
    const hasPrice = rawPrice !== null && rawPrice !== undefined && rawPrice !== '' && !isNaN(Number(rawPrice)) && Number(rawPrice) >= 0;
    const rawEstTotal = (it.estimated_total_cost !== undefined && it.estimated_total_cost !== null) ? it.estimated_total_cost : it.estimatedTotalCost;
    const cost = hasPrice ? (parseFloat(rawEstTotal) || (parseFloat(it.quantity) * parseFloat(rawPrice))) : null;
    if (cost !== null) {
      grandTotal += cost;
    } else {
      allHaveCost = false;
    }

    const isCut = (it.supply_type === 'Cut Size' || it.supplyType === 'Cut Size' || it.purchase_type === 'PROJECT-SPECIFIC CUT SIZE' || it.purchaseType === 'PROJECT-SPECIFIC CUT SIZE');
    const origDims = it.size_dimensions || it.originalDimensions || it.size || '-';
    let cutDims = '—';
    if (isCut) {
      const cLen = it.cut_length || it.cutLength;
      const cWid = it.cut_width || it.cutWidth;
      const rawCut = it.required_cut_size || it.requiredCutSize;
      if (rawCut) {
        cutDims = rawCut;
      } else if (cLen) {
        cutDims = cWid ? `${cLen} × ${cWid} mm` : `${cLen} mm`;
      }
    }

    rows.push([
      idx + 1,
      it.sku,
      it.product_name || it.productName || '-',
      it.item_description || it.itemDescription || '-',
      it.material_grade || it.material || it.materialGrade || '-',
      origDims,
      isCut ? 'CUT SIZE' : 'FULL SIZE',
      cutDims,
      it.remarks || '',
      it.unit || 'Sheet',
      it.quantity,
      hasPrice ? formatIdr(rawPrice) : 'Not Available',
      cost !== null ? formatIdr(cost) : '—'
    ]);
  });

  rows.push([]);
  rows.push([
    '', '', '', '', '', '', '', '', '', '',
    'GRAND TOTAL (IDR):',
    allHaveCost ? formatIdr(grandTotal) : '—'
  ]);

  rows.push([]);
  rows.push(['REASON / REQUIREMENT', '', '', '']);
  rows.push(['Reason for Purchase:', pr.reason_for_purchase || pr.reasonForPurchase || '-']);
  rows.push(['General Remarks:', pr.remarks || '-']);

  if (pr.status === 'APPROVED') {
    rows.push([]);
    rows.push(['APPROVAL RECORD', '', '', '']);
    rows.push(['Approved By:', pr.approver_name || '-', 'Date Approved:', appDate]);
    if (pr.approval_notes) rows.push(['Notes:', pr.approval_notes]);
  } else if (pr.status === 'REJECTED') {
    rows.push([]);
    rows.push(['REJECTION RECORD', '', '', '']);
    rows.push(['Rejected By:', pr.rejecter_name || '-', 'Date Rejected:', rejDate]);
    if (pr.rejection_reason) rows.push(['Reason:', pr.rejection_reason]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 4 },  // #
    { wch: 10 }, // SKU
    { wch: 28 }, // Product Name
    { wch: 35 }, // Item Description
    { wch: 18 }, // Material / Grade
    { wch: 20 }, // Original Dimensions
    { wch: 14 }, // Supply Type
    { wch: 22 }, // Required Cut Size
    { wch: 25 }, // Remarks
    { wch: 10 }, // Unit
    { wch: 10 }, // Quantity
    { wch: 20 }, // Unit Price (IDR)
    { wch: 24 }  // Estimated Total Cost (IDR)
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Purchase Request');
  if (filePath) {
    XLSX.writeFile(wb, filePath);
    return filePath;
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Internal helper: Build PDF Document (PDFKit)
 * Clean Flow Force White Enterprise Design
 */
function generatePdfFile(pr, items, filePath) {
  return new Promise((resolve, reject) => {
    try {
      if (!Array.isArray(items) && pr && Array.isArray(pr.items)) {
        if (typeof items === 'string') {
          filePath = items;
        }
        items = pr.items;
      }
      items = items || [];
      pr = pr || {};

      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        compress: false,
        info: {
          Title: `Purchase Request ${pr.pr_number || pr.prNumber}`,
          Author: 'Flow Force System',
          Subject: 'Purchase Request Document'
        }
      });

      let writeStream;
      const buffers = [];
      if (filePath) {
        writeStream = fs.createWriteStream(filePath);
        doc.pipe(writeStream);
      } else {
        doc.on('data', b => buffers.push(b));
      }

      doc.on('end', () => {
        if (filePath) {
          resolve(filePath);
        } else {
          resolve(Buffer.concat(buffers));
        }
      });

      doc.on('error', err => reject(err));

      const primaryColor = '#0284c7';
      const textColor = '#0f172a';
      const mutedColor = '#64748b';
      const borderColor = '#cbd5e1';

      // Header: Flow Force Logo & Title
      doc.fontSize(18).font('Helvetica-Bold').fillColor(primaryColor).text('FLOW FORCE', 36, 36);
      doc.fontSize(8).font('Helvetica').fillColor('#64748b').text('Bulk Material Handling & Processing Equipment Specialists', 36, 56);

      doc.fontSize(16).font('Helvetica-Bold').fillColor(textColor).text('PURCHASE REQUEST', 340, 36, { align: 'right' });
      doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(`PR No: ${pr.pr_number}`, 340, 56, { align: 'right' });

      // Divider
      doc.moveTo(36, 76).lineTo(559, 76).strokeColor(primaryColor).lineWidth(1.5).stroke();

      // Section: Request Details Grid
      let y = 88;
      const reqDate = pr.created_at ? new Date(pr.created_at).toLocaleDateString('en-GB') : '-';
      const needDate = pr.required_date ? new Date(pr.required_date).toLocaleDateString('en-GB') : '-';

      // Left column
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(textColor).text('PR Number: ', 36, y, { continued: true })
         .font('Helvetica').text(pr.pr_number);
      doc.font('Helvetica-Bold').text('Project / PID: ', 36, y + 14, { continued: true })
         .font('Helvetica').text(`${pr.project_code || '-'} — ${pr.project_name || '-'}`);
      doc.font('Helvetica-Bold').text('Job Location: ', 36, y + 28, { continued: true })
         .font('Helvetica').text(pr.job_location || '-');
      doc.font('Helvetica-Bold').text('Created By: ', 36, y + 42, { continued: true })
         .font('Helvetica').text(`${pr.requester_name || '-'} (${pr.requester_username || '-'})`);

      // Right column
      const rightX = 340;
      doc.font('Helvetica-Bold').text('Status: ', rightX, y, { continued: true });
      const statusColor = pr.status === 'APPROVED' ? '#059669' : (pr.status === 'REJECTED' ? '#e11d48' : '#d97706');
      doc.fillColor(statusColor).text(pr.status).fillColor(textColor);

      doc.font('Helvetica-Bold').text('Request Date: ', rightX, y + 14, { continued: true })
         .font('Helvetica').text(reqDate);
      doc.font('Helvetica-Bold').text('Required Date: ', rightX, y + 28, { continued: true })
         .font('Helvetica').text(needDate);
      doc.font('Helvetica-Bold').text('Urgency: ', rightX, y + 42, { continued: true })
         .font('Helvetica').text(pr.urgency || 'Standard');

      y += 62;

      // Divider
      doc.moveTo(36, y).lineTo(559, y).strokeColor(borderColor).lineWidth(1).stroke();
      y += 10;

      // Section: Item Details
      doc.fontSize(10).font('Helvetica-Bold').fillColor(primaryColor).text('ITEM SPECIFICATIONS & QUANTITIES', 36, y);
      y += 16;

      // Table Header: 8 Columns across 523pt total width
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155');
      doc.text('#', 36, y, { width: 18 });
      doc.text('SKU', 56, y, { width: 50 });
      doc.text('Product Name & Description', 108, y, { width: 145 });
      doc.text('Material & Orig. Size', 256, y, { width: 80 });
      doc.text('Supply Type & Cut Size', 338, y, { width: 84 });
      doc.text('Qty / Unit', 424, y, { width: 44 });
      doc.text('Unit Price', 470, y, { width: 44, align: 'right' });
      doc.text('Est. Total', 516, y, { width: 43, align: 'right' });

      y += 12;
      doc.moveTo(36, y).lineTo(559, y).strokeColor(borderColor).stroke();
      y += 8;

      let allHaveCost = true;
      let grandTotal = 0;

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

        if (y > 690) {
          doc.addPage();
          y = 36;
        }

        const startY = y;
        const pName = it.product_name || it.productName || '-';
        const pDesc = it.item_description || it.itemDescription || '';
        const matGrade = it.material_grade || it.material || it.materialGrade || '-';

        const isCut = (it.supply_type === 'Cut Size' || it.supplyType === 'Cut Size' || it.purchase_type === 'PROJECT-SPECIFIC CUT SIZE' || it.purchaseType === 'PROJECT-SPECIFIC CUT SIZE');
        const origDims = it.size_dimensions || it.originalDimensions || it.size || '-';
        let cutDims = '—';
        if (isCut) {
          const cLen = it.cut_length || it.cutLength;
          const cWid = it.cut_width || it.cutWidth;
          const rawCut = it.required_cut_size || it.requiredCutSize;
          if (rawCut) {
            cutDims = rawCut;
          } else if (cLen) {
            cutDims = cWid ? `${cLen} × ${cWid} mm` : `${cLen} mm`;
          }
        }

        // Col 1: #
        doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text(String(idx + 1), 36, y, { width: 18 });

        // Col 2: SKU
        doc.font('Helvetica-Bold').fontSize(8).fillColor(textColor).text(it.sku, 56, y, { width: 50 });

        // Col 3: Product Name & Description & Item Remarks
        doc.font('Helvetica-Bold').fontSize(8).fillColor(textColor).text(pName, 108, y, { width: 145 });
        let descY = y + doc.heightOfString(pName, { width: 145 }) + 2;
        if (pDesc) {
          doc.font('Helvetica').fontSize(7).fillColor('#475569').text(pDesc, 108, descY, { width: 145 });
          descY += doc.heightOfString(pDesc, { width: 145 }) + 2;
        }
        if (it.remarks) {
          const remText = `Remarks: ${it.remarks}`;
          doc.font('Helvetica-Bold').fontSize(7).fillColor('#0284c7').text(remText, 108, descY, { width: 145 });
          descY += doc.heightOfString(remText, { width: 145 }) + 2;
        }

        // Col 4: Material / Grade & Original Dimensions
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(textColor).text(matGrade, 256, y, { width: 80 });
        const matH = doc.heightOfString(matGrade, { width: 80 });
        doc.font('Helvetica').fontSize(7).fillColor('#64748b').text(`Original: ${origDims}`, 256, y + matH + 2, { width: 80 });
        const origH = matH + 2 + doc.heightOfString(`Original: ${origDims}`, { width: 80 });

        // Col 5: Supply Type & Required Cut Size
        if (isCut) {
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#c2410c').text('[ CUT SIZE ]', 338, y, { width: 84 });
          doc.font('Helvetica-Bold').fontSize(7).fillColor('#9a3412').text(`Required Cut:\n${cutDims}`, 338, y + 10, { width: 84 });
        } else {
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#0284c7').text('[ FULL SIZE ]', 338, y, { width: 84 });
          doc.font('Helvetica').fontSize(7).fillColor('#64748b').text('Required Cut: —', 338, y + 10, { width: 84 });
        }
        const supplyH = 26;

        // Col 6: Qty & Unit
        doc.font('Helvetica-Bold').fontSize(8).fillColor(textColor).text(String(it.quantity), 424, y, { width: 44 });
        doc.font('Helvetica').fontSize(7).fillColor('#64748b').text(it.unit || 'Sheet', 424, y + 10, { width: 44 });

        // Col 7: Unit Price
        doc.font('Helvetica').fontSize(7.5).fillColor(textColor).text(hasPrice ? formatIdr(rawPrice).replace('IDR ', '') : '—', 470, y, { width: 44, align: 'right' });

        // Col 8: Estimated Total
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#059669').text(cost !== null ? formatIdr(cost).replace('IDR ', '') : '—', 516, y, { width: 43, align: 'right' });

        const rowHeight = Math.max(descY - startY, origH, supplyH, 24);
        y = startY + rowHeight + 6;
        doc.moveTo(36, y).lineTo(559, y).strokeColor('#f1f5f9').stroke();
        y += 6;
      });

      // Grand Total Line
      doc.font('Helvetica-Bold').fontSize(9).fillColor(textColor);
      doc.text('ESTIMATED GRAND TOTAL (IDR):', 290, y, { width: 185, align: 'right' });
      doc.fillColor(primaryColor).text((allHaveCost && grandTotal > 0) ? formatIdr(grandTotal) : '—', 480, y, { width: 79, align: 'right' });

      y += 24;
      if (y > 680) {
        doc.addPage();
        y = 36;
      }

      // Reason & Remarks
      doc.moveTo(36, y).lineTo(559, y).strokeColor(borderColor).stroke();
      y += 10;
      doc.fontSize(9).font('Helvetica-Bold').fillColor(primaryColor).text('REQUISITION REASON & REMARKS', 36, y);
      y += 14;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(textColor).text('Reason: ', 36, y, { continued: true })
         .font('Helvetica').text(pr.reason_for_purchase || '(No reason specified)');
      y += 14;
      if (pr.remarks) {
        doc.font('Helvetica-Bold').text('Remarks: ', 36, y, { continued: true })
           .font('Helvetica').text(pr.remarks);
        y += 16;
      }

      // Formal Approval Block
      y += 10;
      if (y > 700) {
        doc.addPage();
        y = 36;
      }
      doc.moveTo(36, y).lineTo(559, y).strokeColor(borderColor).stroke();
      y += 12;
      doc.fontSize(9).font('Helvetica-Bold').fillColor(primaryColor).text('APPROVAL & AUDIT RECORD', 36, y);
      y += 16;

      const appDate = pr.approved_at ? new Date(pr.approved_at).toLocaleDateString('en-GB') : '-';
      const rejDate = pr.rejected_at ? new Date(pr.rejected_at).toLocaleDateString('en-GB') : '-';

      doc.fontSize(8).font('Helvetica-Bold').fillColor(textColor);
      doc.text('Requisitioned By:', 36, y);
      doc.font('Helvetica').text(`${pr.requester_name || '-'} (${pr.requester_username || '-'})`, 36, y + 12);
      doc.text(`Date: ${reqDate}`, 36, y + 24);

      const appBlockX = 340;
      if (pr.status === 'APPROVED') {
        doc.font('Helvetica-Bold').fillColor('#059669').text('Approved By (Admin):', appBlockX, y);
        doc.font('Helvetica').fillColor(textColor).text(`${pr.approver_name || 'Admin'} (${pr.approver_username || 'admin'})`, appBlockX, y + 12);
        doc.text(`Approval Date: ${appDate}`, appBlockX, y + 24);
      } else if (pr.status === 'REJECTED') {
        doc.font('Helvetica-Bold').fillColor('#e11d48').text('Rejected By (Admin):', appBlockX, y);
        doc.font('Helvetica').fillColor(textColor).text(`${pr.rejecter_name || 'Admin'} (${pr.rejecter_username || 'admin'})`, appBlockX, y + 12);
        doc.text(`Rejection Date: ${rejDate}`, appBlockX, y + 24);
        doc.font('Helvetica-Bold').text(`Reason: `, appBlockX, y + 36, { continued: true })
           .font('Helvetica').text(pr.rejection_reason || '-');
      } else {
        doc.font('Helvetica-Bold').fillColor('#d97706').text('Pending Administrative Review', appBlockX, y);
        doc.font('Helvetica').fillColor(mutedColor).text('Awaiting verification by System Administrator', appBlockX, y + 12);
      }

      doc.end();

      if (filePath && writeStream) {
        writeStream.on('finish', () => resolve(filePath));
        writeStream.on('error', (err) => reject(err));
      }
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generatePrDocuments,
  generateExcelFile,
  generatePdfFile,
  formatIdr
};
