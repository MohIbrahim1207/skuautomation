/**
 * =========================================================================
 * FLOW FORCE ENTERPRISE SKU AUTOMATION - TEMPLATE SERVICE
 * Generates, validates, and serves the standard Master Item Excel template
 * =========================================================================
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const TEMPLATE_FILE_NAME = 'Flow_Force_New_SKU_Input_Template.xlsx';

const EXPECTED_HEADERS = [
  'SKU (Leave Blank)',
  'Product Name',
  'Item Description',
  'Category',
  'Subcategory',
  'Material / Grade',
  'Size / Dimensions',
  'Specification / Standard',
  'Unit / UOM',
  'Weight (kg)',
  'Brand / Manufacturer',
  'Supplier Name',
  'Current Unit Price (IDR)',
  'Material Type',
  'Project / PID (if cut size)',
  'Remarks'
];

/**
 * Validate an XLSX buffer to ensure it is a valid, uncorrupted ZIP/Excel container
 * containing the required Flow Force worksheet structure.
 */
function validateXlsxBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { valid: false, error: 'File payload is not a valid binary buffer.' };
  }

  if (buffer.length < 500) {
    return { valid: false, error: `File buffer size (${buffer.length} bytes) is too small for a valid XLSX package.` };
  }

  // Check standard ZIP signature (0x50, 0x4B, 0x03, 0x04) -> "PK\x03\x04"
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    // Check if it's accidentally HTML or JSON
    const textPrefix = buffer.slice(0, 100).toString('utf8').trim();
    if (textPrefix.startsWith('<!DOCTYPE') || textPrefix.startsWith('<html') || textPrefix.startsWith('{')) {
      return { valid: false, error: `File contains text/HTML/JSON instead of binary XLSX: "${textPrefix.slice(0, 40)}..."` };
    }
    return { valid: false, error: 'Invalid file signature: Missing OpenXML ZIP "PK" magic bytes.' };
  }

  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length === 0) {
      return { valid: false, error: 'XLSX workbook contains no readable sheets.' };
    }

    // Verify "New SKU Input" sheet exists
    const hasInputSheet = wb.SheetNames.some(name => name.trim().toLowerCase() === 'new sku input');
    if (!hasInputSheet) {
      return { valid: false, error: `Workbook missing required "New SKU Input" sheet. Found: ${wb.SheetNames.join(', ')}` };
    }

    const ws = wb.Sheets['New SKU Input'] || wb.Sheets[wb.SheetNames.find(n => n.trim().toLowerCase() === 'new sku input')];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows || rows.length === 0) {
      return { valid: false, error: '"New SKU Input" worksheet is empty.' };
    }

    const headers = (rows[0] || []).map(h => String(h || '').trim());
    const lowerHeaders = headers.map(h => h.toLowerCase());

    const hasProductName = lowerHeaders.some(h => h.includes('product name'));
    const hasCategory = lowerHeaders.some(h => h.includes('category'));
    const hasPrice = lowerHeaders.some(h => h.includes('price'));

    if (!hasProductName || !hasCategory || !hasPrice) {
      return { valid: false, error: 'Worksheet headers do not contain mandatory columns (Product Name, Category, Price).' };
    }

    return { valid: true, workbook: wb, sheetNames: wb.SheetNames, headers };
  } catch (err) {
    return { valid: false, error: `Failed to parse XLSX workbook: ${err.message}` };
  }
}

/**
 * Generate a pristine standard Flow Force New SKU Input Template workbook as a binary Buffer.
 */
function generateStandardTemplateWorkbook() {
  const wb = XLSX.utils.book_new();

  // 1. Instructions Sheet
  const instructionsData = [
    ['FLOW FORCE SKU & PURCHASE REQUEST AUTOMATION - INSTRUCTIONS'],
    ['1. Enter material details in the "New SKU Input" worksheet.'],
    ['2. Leave the "SKU (Leave Blank)" column empty. The system will auto-allocate the next FF-series SKU (starting at FF4236).'],
    ['3. "Current Unit Price (IDR)" is strictly mandatory for all rows.'],
    ['4. Save and upload directly to Flow Force via "+ Import Excel".']
  ];
  const wsInstructions = XLSX.utils.aoa_to_sheet(instructionsData);
  wsInstructions['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, wsInstructions, 'Instructions');

  // 2. New SKU Input Sheet
  const inputData = [
    EXPECTED_HEADERS,
    [
      '',
      'Marine Grade Steel Plate AH36 16mm',
      'High-Tensile Structural Marine Steel Plate\nGrade: AH36\nDimensions: 16mm x 2000mm x 6000mm\nStandard: ASTM A131 / ABS Grade AH36',
      'Raw Materials',
      'Steel Plates',
      'AH36 Marine Grade',
      '16mm x 2000mm x 6000mm',
      'ASTM A131 / ABS AH36',
      'Sheet',
      3014.4,
      'PT Persada Nusantara Steel',
      'PT Persada Nusantara Steel',
      21500000,
      'Standard Stock',
      'PID-1892',
      'Certified mill test report required'
    ],
    [
      '',
      'Heavy Structural Steel H-Beam 300x300',
      'Structural Wide Flange H-Beam\nDimensions: 300 x 300 x 10 x 15mm\nGrade: SM490B\nLength: 6000mm',
      'Raw Materials',
      'Structural Beams',
      'SM490B',
      '300 x 300 x 10 x 15mm',
      'JIS G3101 / SM490B',
      'Length',
      564,
      'PT Persada Nusantara Steel',
      'PT Persada Nusantara Steel',
      14200000,
      'Standard Stock',
      'PID-1892',
      'Primary frame member'
    ]
  ];
  const wsInput = XLSX.utils.aoa_to_sheet(inputData);
  wsInput['!cols'] = [
    { wch: 18 }, // SKU (Leave Blank)
    { wch: 36 }, // Product Name
    { wch: 45 }, // Item Description
    { wch: 18 }, // Category
    { wch: 20 }, // Subcategory
    { wch: 22 }, // Material / Grade
    { wch: 26 }, // Size / Dimensions
    { wch: 26 }, // Specification / Standard
    { wch: 14 }, // Unit / UOM
    { wch: 14 }, // Weight (kg)
    { wch: 28 }, // Brand / Manufacturer
    { wch: 28 }, // Supplier Name
    { wch: 24 }, // Current Unit Price (IDR)
    { wch: 18 }, // Material Type
    { wch: 24 }, // Project / PID (if cut size)
    { wch: 35 }  // Remarks
  ];
  XLSX.utils.book_append_sheet(wb, wsInput, 'New SKU Input');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  return buf;
}

/**
 * Retrieve the validated template buffer from disk, or dynamically regenerate
 * and persist a fresh, compliant template if missing or corrupted.
 */
function getOrGenerateTemplateBuffer() {
  const candidatePaths = [
    path.resolve(process.cwd(), TEMPLATE_FILE_NAME),
    path.resolve(__dirname, '../../', TEMPLATE_FILE_NAME),
    path.resolve(__dirname, '../', TEMPLATE_FILE_NAME)
  ];

  for (const filePath of candidatePaths) {
    if (fs.existsSync(filePath)) {
      try {
        const fileBuf = fs.readFileSync(filePath);
        const check = validateXlsxBuffer(fileBuf);
        if (check.valid) {
          return fileBuf;
        } else {
          console.warn(`[TemplateService] Warning: Disk template at ${filePath} is invalid (${check.error}). Will regenerate.`);
        }
      } catch (readErr) {
        console.warn(`[TemplateService] Error reading disk template at ${filePath}:`, readErr.message);
      }
    }
  }

  // Generate fresh compliant template
  const freshBuf = generateStandardTemplateWorkbook();
  const writeTarget = path.resolve(process.cwd(), TEMPLATE_FILE_NAME);
  try {
    fs.writeFileSync(writeTarget, freshBuf);
    console.log(`✅ [TemplateService] Saved fresh, verified Excel template to ${writeTarget} (${freshBuf.length} bytes)`);
  } catch (writeErr) {
    console.warn(`[TemplateService] Notice: Could not save fresh template to ${writeTarget}:`, writeErr.message);
  }

  return freshBuf;
}

/**
 * Express handler to serve the template download with 100% binary safety,
 * explicit OpenXML MIME types, attachment disposition, and no-cache policies.
 */
function serveTemplateDownload(req, res) {
  try {
    const buffer = getOrGenerateTemplateBuffer();
    const validation = validateXlsxBuffer(buffer);

    if (!validation.valid) {
      console.error('[TemplateService] Critical: Generated template buffer failed validation:', validation.error);
      return res.status(500).json({
        error: 'Server failed to generate a valid Excel template.',
        details: validation.error
      });
    }

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${TEMPLATE_FILE_NAME}"`,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-cache, no-store, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    return res.status(200).send(buffer);
  } catch (err) {
    console.error('[TemplateService] Error serving template download:', err);
    return res.status(500).json({
      error: 'An internal error occurred while preparing the template download.',
      message: err.message
    });
  }
}

module.exports = {
  TEMPLATE_FILE_NAME,
  EXPECTED_HEADERS,
  validateXlsxBuffer,
  generateStandardTemplateWorkbook,
  getOrGenerateTemplateBuffer,
  serveTemplateDownload
};
