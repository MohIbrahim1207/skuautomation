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
    ['PR Number:', pr.pr_number, 'Status:', pr.status],
    ['Project / PID:', pr.project_code || '-', 'Job Location:', pr.job_location || '-'],
    ['Project Name:', pr.project_name || '-', 'Request Date:', reqDate],
    ['Created By:', pr.requester_name || '-', 'Username:', pr.requester_username || '-'],
    ['Department:', pr.department || '-', 'Required Date:', needDate],
    ['Urgency:', pr.urgency || 'Standard', 'Purchase Type:', pr.purchase_type || 'STANDARD STOCK ITEM'],
    ...(pr.purchase_type === 'PROJECT-SPECIFIC CUT SIZE' ? [['Required Cut Size:', pr.required_cut_size || '-', '', '']] : []),
    [],
    ['ITEM DETAILS', '', '', '', '', '', '', '', '', '', ''],
    ['#', 'SKU', 'Product Name', 'Item Description', 'Material / Grade', 'Size / Dimensions', 'Specification', 'Unit', 'Quantity', 'Unit Price (IDR)', 'Estimated Total Cost (IDR)']
  ];

  let allHaveCost = true;
  let grandTotal = 0;
  items.forEach((it, idx) => {
    const hasPrice = it.unit_price !== null && it.unit_price !== undefined && it.unit_price !== '' && !isNaN(Number(it.unit_price)) && Number(it.unit_price) >= 0;
    const cost = hasPrice ? (parseFloat(it.estimated_total_cost) || (parseFloat(it.quantity) * parseFloat(it.unit_price))) : null;
    if (cost !== null) {
      grandTotal += cost;
    } else {
      allHaveCost = false;
    }
    rows.push([
      idx + 1,
      it.sku,
      it.product_name,
      it.item_description, // Preserves multiline linebreaks in cell
      it.material_grade || '-',
      it.size_dimensions || '-',
      it.specification || '-',
      it.unit || 'Sheet',
      parseFloat(it.quantity) || 1,
      hasPrice ? `IDR ${Number(it.unit_price).toLocaleString('id-ID')}` : '—',
      cost !== null ? `IDR ${Number(cost).toLocaleString('id-ID')}` : '—'
    ]);
  });

  rows.push([]);
  rows.push(['', '', '', '', '', '', '', '', 'GRAND TOTAL (IDR):', '', (allHaveCost && grandTotal > 0) ? `IDR ${Number(grandTotal).toLocaleString('id-ID')}` : '—']);
  rows.push([]);
  rows.push(['REASON / REQUIREMENT']);
  rows.push(['Reason for Purchase:', pr.reason_for_purchase || '-']);
  rows.push(['Remarks / Notes:', pr.remarks || '-']);
  rows.push([]);
  rows.push(['APPROVAL SECTION']);
  rows.push(['Created By:', `${pr.requester_name || '-'} (${pr.requester_username || '-'})`, 'Created Date:', reqDate]);

  if (pr.status === 'APPROVED') {
    rows.push(['Approved By:', `${pr.approver_name || '-'} (${pr.approver_username || 'admin'})`, 'Approved Date:', appDate]);
    rows.push(['Status:', 'APPROVED']);
  } else if (pr.status === 'REJECTED') {
    rows.push(['Rejected By:', `${pr.rejecter_name || '-'} (${pr.rejecter_username || 'admin'})`, 'Rejected Date:', rejDate]);
    rows.push(['Rejection Reason:', pr.rejection_reason || '-']);
    rows.push(['Status:', 'REJECTED']);
  } else {
    rows.push(['Status:', 'PENDING APPROVAL']);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Column width configuration
  ws['!cols'] = [
    { wch: 5 },  // #
    { wch: 14 }, // SKU
    { wch: 28 }, // Product Name
    { wch: 45 }, // Item Description
    { wch: 18 }, // Material
    { wch: 22 }, // Dimensions
    { wch: 25 }, // Specification
    { wch: 8 },  // Unit
    { wch: 10 }, // Qty
    { wch: 18 }, // Price IDR
    { wch: 24 }  // Total IDR
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Purchase Request');
  XLSX.writeFile(wb, filePath);
}

/**
 * Internal helper: Build PDF Document (PDFKit)
 * Clean Flow Force White Enterprise Design
 */
function generatePdfFile(pr, items, filePath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        info: {
          Title: `Purchase Request ${pr.pr_number}`,
          Author: 'Flow Force Enterprise Portal',
          Subject: `${pr.project_code} - ${pr.job_location}`
        }
      });

      const writeStream = fs.createWriteStream(filePath);
      doc.pipe(writeStream);

      const primaryColor = '#0284c7';
      const textColor = '#0f172a';
      const mutedColor = '#64748b';
      const borderColor = '#cbd5e1';

      // Header Banner
      doc.fontSize(16).fillColor(primaryColor).text('FLOW FORCE', { continued: true });
      doc.fontSize(10).fillColor(mutedColor).text('   |   PURCHASE REQUEST', { align: 'left' });
      doc.fontSize(8).fillColor(mutedColor).text('Bulk Material Handling & Processing Equipment Specialists', { align: 'left' });

      doc.moveTo(36, 68).lineTo(559, 68).strokeColor(borderColor).stroke();

      // Top Meta Box
      let y = 78;
      doc.fontSize(9).fillColor(textColor);

      const reqDate = pr.created_at ? new Date(pr.created_at).toLocaleDateString('en-GB') : '-';
      const needDate = pr.required_date ? new Date(pr.required_date).toLocaleDateString('en-GB') : '-';

      // Left column
      doc.font('Helvetica-Bold').text('PR Number: ', 36, y, { continued: true })
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
      if (pr.purchase_type === 'PROJECT-SPECIFIC CUT SIZE') {
        doc.font('Helvetica-Bold').fillColor('#b45309').text(`Purchase Type: PROJECT-SPECIFIC CUT SIZE (Required: ${pr.required_cut_size || '-'})`, 36, y);
        y += 16;
      }

      // Divider
      doc.moveTo(36, y).lineTo(559, y).strokeColor(borderColor).stroke();
      y += 10;

      // Section: Item Details
      doc.fontSize(10).font('Helvetica-Bold').fillColor(primaryColor).text('ITEM SPECIFICATIONS & QUANTITIES', 36, y);
      y += 16;

      // Table Header
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155');
      doc.text('#', 36, y, { width: 20 });
      doc.text('SKU', 58, y, { width: 55 });
      doc.text('Product Name & Item Description', 115, y, { width: 225 });
      doc.text('Qty & Unit', 345, y, { width: 55 });
      doc.text('Unit Price (IDR)', 405, y, { width: 75, align: 'right' });
      doc.text('Est. Total (IDR)', 485, y, { width: 74, align: 'right' });

      y += 12;
      doc.moveTo(36, y).lineTo(559, y).strokeColor(borderColor).stroke();
      y += 8;

      let allHaveCost = true;
      let grandTotal = 0;
      doc.font('Helvetica').fontSize(8).fillColor(textColor);

      items.forEach((it, idx) => {
        const hasPrice = it.unit_price !== null && it.unit_price !== undefined && it.unit_price !== '' && !isNaN(Number(it.unit_price)) && Number(it.unit_price) >= 0;
        const cost = hasPrice ? (parseFloat(it.estimated_total_cost) || (parseFloat(it.quantity) * parseFloat(it.unit_price))) : null;
        if (cost !== null) {
          grandTotal += cost;
        } else {
          allHaveCost = false;
        }

        if (y > 700) {
          doc.addPage();
          y = 36;
        }

        const startY = y;
        doc.text(String(idx + 1), 36, y, { width: 20 });
        doc.font('Helvetica-Bold').text(it.sku, 58, y, { width: 55 }).font('Helvetica');

        // Product name and multiline item description
        const descText = `${it.product_name}\n${it.item_description || ''}`;
        doc.text(descText, 115, y, { width: 225 });
        const descHeight = doc.heightOfString(descText, { width: 225 });

        doc.text(`${it.quantity} ${it.unit || 'Sheet'}`, 345, y, { width: 55 });
        doc.text(hasPrice ? formatIdr(it.unit_price).replace('IDR ', '') : '—', 405, y, { width: 75, align: 'right' });
        doc.font('Helvetica-Bold').text(cost !== null ? formatIdr(cost).replace('IDR ', '') : '—', 485, y, { width: 74, align: 'right' }).font('Helvetica');

        y = startY + Math.max(descHeight, 18) + 6;
        doc.moveTo(36, y).lineTo(559, y).strokeColor('#f1f5f9').stroke();
        y += 6;
      });

      // Grand Total Line
      doc.font('Helvetica-Bold').fontSize(9).fillColor(textColor);
      doc.text('ESTIMATED GRAND TOTAL (IDR):', 300, y, { width: 175, align: 'right' });
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

      writeStream.on('finish', () => resolve(filePath));
      writeStream.on('error', (err) => reject(err));
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
