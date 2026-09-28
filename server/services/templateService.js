/**
 * =========================================================================
 * FLOW FORCE ENTERPRISE SKU AUTOMATION - FAMILY-SPECIFIC TEMPLATE SERVICE
 * Generates, validates, and serves family-specific Excel import templates
 * =========================================================================
 * 
 * ROOT CAUSE OF PREVIOUS CORRUPTION:
 * The browser <a href="/api/import-submissions/template" download> link
 * does NOT send Authorization headers. When the running server had auth
 * middleware on the route, it returned 401 JSON which got saved as .xlsx.
 * 
 * FIX: Template endpoints are public (no auth). Templates are dynamically
 * generated per-family with correct binary XLSX output.
 * =========================================================================
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

// =========================================================================
// FAMILY DEFINITIONS
// =========================================================================
const TEMPLATE_VERSION = '1.0';

/**
 * Canonical family registry. Keys are URL-safe slugs.
 * Each family defines:
 *   - name: Display name (also the worksheet tab name)
 *   - category: The exact value written to master_items.category
 *   - filename: Download filename
 *   - headers: Array of column headers for the data sheet
 *   - sampleRows: Array of sample data rows (arrays matching headers)
 *   - colWidths: Array of column widths
 */
const FAMILY_REGISTRY = {
  'raw-materials': {
    name: 'Raw Materials',
    category: 'Raw Materials',
    filename: 'Flow_Force_Raw_Materials_Template.xlsx',
    headers: [
      'SKU (Leave Blank)',
      'Product Name',
      'Item Description',
      'Sub-Category',
      'Material / Grade',
      'Size / Dimensions',
      'A (mm)',
      'B (mm)',
      'C (mm)',
      'D (mm)',
      'L1 (mm)',
      'L2 (mm)',
      'Specification / Standard',
      'Unit / UOM',
      'Weight (kg)',
      'Brand / Manufacturer',
      'Supplier Name',
      'Current Unit Price (IDR)',
      'Supply Type',
      'Project / PID (if cut size)',
      'Remarks'
    ],
    sampleRows: [
      [
        '', 'Marine Grade Steel Plate AH36 16mm',
        'High-Tensile Structural Marine Steel Plate\nGrade: AH36\nDimensions: 16mm x 2000mm x 6000mm',
        'Marine Plates', 'AH36 Marine Grade', '16mm x 2000mm x 6000mm',
        '2000', '6000', '', '', '', '',
        'ASTM A131 / ABS AH36', 'Sheet', 3014.4,
        'PT Persada Nusantara Steel', 'PT Persada Nusantara Steel',
        21500000, 'Full Size', '', 'Certified mill test report required'
      ],
      [
        '', 'Flat Bar 50 x 6mm SS400',
        'Mild Steel Flat Bar\nDimensions: 50 x 6mm\nGrade: SS400\nLength: 6000mm',
        'Flat Bar', 'SS400', '50 x 6mm',
        '50', '6', '', '', '6000', '',
        'JIS G3101 SS400', 'Length', 14.1,
        '', '', 850000, 'Full Size', '', ''
      ]
    ],
    colWidths: [18, 36, 45, 20, 22, 26, 12, 12, 12, 12, 12, 12, 26, 14, 14, 28, 28, 24, 16, 24, 35]
  },

  'fasteners': {
    name: 'Fasteners',
    category: 'Fasteners',
    filename: 'Flow_Force_Fasteners_Template.xlsx',
    headers: [
      'SKU (Leave Blank)',
      'Product Name',
      'Item Description',
      'Sub-Category',
      'Material / Grade',
      'Size / Dimensions',
      'Specification / Standard',
      'Unit / UOM',
      'Weight (kg)',
      'Brand / Manufacturer',
      'Supplier Name',
      'Current Unit Price (IDR)',
      'Supply Type',
      'Remarks'
    ],
    sampleRows: [
      [
        '', 'Hex Bolt M16 x 50mm Grade 8.8',
        'High-Tensile Hex Head Bolt\nSize: M16 x 50mm\nGrade: 8.8\nHot Dip Galvanized',
        'Bolts', 'Grade 8.8', 'M16 x 50mm',
        'ISO 4014 / DIN 931', 'Nos', 0.115,
        '', '', 12500, 'Full Size', 'Hot Dip Galvanized finish'
      ],
      [
        '', 'Hex Nut M16 Grade 8',
        'High-Tensile Hex Nut\nSize: M16\nGrade: 8\nZinc Plated',
        'Bolts', 'Grade 8', 'M16',
        'ISO 4032 / DIN 934', 'Nos', 0.032,
        '', '', 3500, 'Full Size', ''
      ]
    ],
    colWidths: [18, 36, 45, 20, 22, 22, 26, 14, 14, 28, 28, 24, 16, 35]
  },

  'piping-materials': {
    name: 'Piping Materials',
    category: 'Piping Materials',
    aliases: ['Piping & Fittings', 'Piping', 'Piping Materials'],
    filename: 'Flow_Force_Piping_Materials_Template.xlsx',
    headers: [
      'SKU (Leave Blank)',
      'Product Name',
      'Item Description',
      'Sub-Category',
      'Material / Grade',
      'Size / Dimensions',
      'Specification / Standard',
      'Unit / UOM',
      'Weight (kg)',
      'Brand / Manufacturer',
      'Supplier Name',
      'Current Unit Price (IDR)',
      'Supply Type',
      'Remarks'
    ],
    sampleRows: [
      [
        '', 'Seamless Pipe 6" SCH 40 A106 Gr.B',
        'Carbon Steel Seamless Pipe\nSize: 6" (168.3mm OD)\nSchedule: 40\nWT: 7.11mm\nGrade: A106 Gr.B',
        'Seamless Pipes', 'A106 Gr.B', '6" SCH 40',
        'ASTM A106 / ASME B36.10', 'Length', 68.3,
        '', '', 8500000, 'Full Size', 'Hydro tested, MTR required'
      ],
      [
        '', '90° Elbow 6" SCH 40 A234 WPB',
        'Butt Weld 90° Long Radius Elbow\nSize: 6"\nSchedule: 40\nGrade: A234 WPB',
        'Seamless Pipes', 'A234 WPB', '6" SCH 40',
        'ASTM A234 / ASME B16.9', 'Nos', 5.2,
        '', '', 1250000, 'Full Size', ''
      ]
    ],
    colWidths: [18, 36, 45, 20, 22, 22, 26, 14, 14, 28, 28, 24, 16, 35]
  },

  'bought-out-items': {
    name: 'Bought Out Items',
    category: 'Bought Out Items',
    filename: 'Flow_Force_Bought_Out_Items_Template.xlsx',
    headers: [
      'SKU (Leave Blank)',
      'Product Name',
      'Item Description',
      'Sub-Category',
      'Material / Grade',
      'Size / Dimensions',
      'Specification / Standard',
      'Unit / UOM',
      'Weight (kg)',
      'Brand / Manufacturer',
      'Supplier Name',
      'Current Unit Price (IDR)',
      'Supply Type',
      'Remarks'
    ],
    sampleRows: [
      [
        '', 'Hydraulic Cylinder 100mm Bore x 600mm Stroke',
        'Double-Acting Hydraulic Cylinder\nBore: 100mm\nStroke: 600mm\nRod: 56mm\nPressure: 210 bar',
        'Hydraulic Components', 'Carbon Steel', '100mm Bore x 600mm Stroke',
        'ISO 6020-2', 'Nos', 35,
        'Parker Hannifin', 'PT Hydraulic Solutions', 28500000, 'Full Size', 'Include mounting brackets'
      ]
    ],
    colWidths: [18, 36, 45, 22, 22, 26, 26, 14, 14, 28, 28, 24, 16, 35]
  },

  'electrical-materials': {
    name: 'Electrical Materials',
    category: 'Electrical Materials',
    filename: 'Flow_Force_Electrical_Materials_Template.xlsx',
    headers: [
      'SKU (Leave Blank)',
      'Product Name',
      'Item Description',
      'Sub-Category',
      'Material / Grade',
      'Size / Dimensions',
      'Specification / Standard',
      'Unit / UOM',
      'Weight (kg)',
      'Brand / Manufacturer',
      'Supplier Name',
      'Current Unit Price (IDR)',
      'Supply Type',
      'Remarks'
    ],
    sampleRows: [
      [
        '', 'Cable Tray 300mm x 100mm Hot Dip Galvanized',
        'Perforated Cable Tray\nWidth: 300mm\nHeight: 100mm\nThickness: 1.6mm\nFinish: Hot Dip Galvanized',
        'Cable Management', 'Hot Dip Galvanized Steel', '300mm x 100mm x 2400mm',
        'IEC 61537', 'Length', 8.5,
        '', '', 650000, 'Full Size', 'Include cover and joints'
      ]
    ],
    colWidths: [18, 36, 45, 22, 22, 26, 26, 14, 14, 28, 28, 24, 16, 35]
  },

  'ducting': {
    name: 'Ducting',
    category: 'Ducting',
    filename: 'Flow_Force_Ducting_Template.xlsx',
    headers: [
      'SKU (Leave Blank)',
      'Product Name',
      'Item Description',
      'Sub-Category',
      'Material / Grade',
      'Size / Dimensions',
      'Specification / Standard',
      'Unit / UOM',
      'Weight (kg)',
      'Brand / Manufacturer',
      'Supplier Name',
      'Current Unit Price (IDR)',
      'Supply Type',
      'Remarks'
    ],
    sampleRows: [
      [
        '', 'Straight Duct 400mm x 300mm x 1200mm',
        'Rectangular Straight Duct Section\nWidth: 400mm\nHeight: 300mm\nLength: 1200mm\nMaterial: Galvanized Steel 0.8mm',
        'Straight Duct', 'Galvanized Steel 0.8mm', '400 x 300 x 1200mm',
        'SMACNA / ASHRAE', 'Nos', 12.5,
        '', '', 850000, 'Full Size', 'Include flanges'
      ]
    ],
    colWidths: [18, 36, 45, 22, 22, 26, 26, 14, 14, 28, 28, 24, 16, 35]
  },

  'flat-bar': {
    name: 'Flat Bar',
    category: 'Flat Bar',
    aliases: ['Raw Materials', 'Flat Bar'],
    filename: 'Flow_Force_Flat_Bar_Template.xlsx',
    headers: [
      'SKU (Leave Blank)',
      'Product Name',
      'Item Description',
      'Sub-Category',
      'Material / Grade',
      'Size / Dimensions',
      'A (mm)',
      'B (mm)',
      'L1 (mm)',
      'Specification / Standard',
      'Unit / UOM',
      'Weight (kg)',
      'Brand / Manufacturer',
      'Supplier Name',
      'Current Unit Price (IDR)',
      'Supply Type',
      'Project / PID (if cut size)',
      'Remarks'
    ],
    sampleRows: [
      [
        '', 'Flat Bar 75 x 10mm SS400',
        'Mild Steel Flat Bar\nWidth: 75mm\nThickness: 10mm\nLength: 6000mm\nGrade: SS400',
        'Flat Bar', 'SS400', '75 x 10mm',
        '75', '10', '6000',
        'JIS G3101 SS400', 'Length', 35.3,
        '', '', 1250000, 'Full Size', '', ''
      ]
    ],
    colWidths: [18, 36, 45, 20, 22, 22, 12, 12, 12, 26, 14, 14, 28, 28, 24, 16, 24, 35]
  },

  'cut-paint-materials': {
    name: 'Cut/Paint Materials',
    category: 'Cut/Paint Materials',
    sheetName: 'Cut-Paint Materials',
    filename: 'Flow_Force_Cut_Paint_Materials_Template.xlsx',
    headers: [
      'SKU (Leave Blank)',
      'Product Name',
      'Item Description',
      'Sub-Category',
      'Material / Grade',
      'Size / Dimensions',
      'Specification / Standard',
      'Unit / UOM',
      'Weight (kg)',
      'Brand / Manufacturer',
      'Supplier Name',
      'Current Unit Price (IDR)',
      'Supply Type',
      'Project / PID (if cut size)',
      'Remarks'
    ],
    sampleRows: [
      [
        '', 'Marine Paint Epoxy Primer 20L',
        'Two-Component Epoxy Primer\nColor: Red Oxide\nVolume: 20 Liters\nDFT: 125 microns',
        'Marine Coatings', 'Epoxy', '20L',
        'SSPC-SP10 / ISO 8501-1 Sa 2.5', 'Can', 25,
        'International Paint', 'PT Marine Coatings', 4500000, 'Full Size', '', 'Store in cool dry area'
      ]
    ],
    colWidths: [18, 36, 45, 22, 22, 22, 26, 14, 14, 28, 28, 24, 16, 24, 35]
  }
};

// Legacy generic headers (kept for backward compatibility validation)
const LEGACY_EXPECTED_HEADERS = [
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
 * Get list of all available family slugs.
 */
function getFamilySlugs() {
  return Object.keys(FAMILY_REGISTRY);
}

/**
 * Get family definition by slug. Returns null if not found.
 */
function getFamilyBySlug(slug) {
  if (!slug) return null;
  const clean = String(slug).toLowerCase().trim().replace(/\s+/g, '-');
  return FAMILY_REGISTRY[clean] || null;
}

/**
 * Get family definition by category name. Returns null if not found.
 */
function getFamilyByCategory(categoryName) {
  if (!categoryName) return null;
  const lower = categoryName.toLowerCase().trim();
  for (const [slug, family] of Object.entries(FAMILY_REGISTRY)) {
    if (family.category.toLowerCase() === lower || family.name.toLowerCase() === lower) {
      return { slug, ...family };
    }
    if (family.aliases && family.aliases.some(a => a.toLowerCase() === lower)) {
      return { slug, ...family };
    }
  }
  return null;
}

// =========================================================================
// TEMPLATE GENERATION
// =========================================================================

/**
 * Generate a family-specific Excel template workbook as a binary Buffer.
 * @param {string} familySlug - Family slug (e.g. 'raw-materials', 'fasteners')
 * @returns {{ buffer: Buffer, filename: string, family: object }}
 */
function generateFamilyTemplate(familySlug) {
  const family = getFamilyBySlug(familySlug);
  if (!family) {
    throw new Error(`Unknown material family: "${familySlug}". Available: ${getFamilySlugs().join(', ')}`);
  }

  const wb = XLSX.utils.book_new();

  // 1. Instructions Sheet
  const instructionsData = [
    ['FLOW FORCE SKU & PURCHASE REQUEST AUTOMATION'],
    [''],
    ['MATERIAL FAMILY IMPORT TEMPLATE'],
    [''],
    [`Material Family: ${family.name}`],
    [`Category: ${family.category}`],
    [`Template Version: ${TEMPLATE_VERSION}`],
    [''],
    ['INSTRUCTIONS:'],
    ['1. Enter material details in the worksheet tab named after your material family.'],
    ['2. Leave the "SKU (Leave Blank)" column empty. The system will auto-allocate the next FF-series SKU upon Admin approval.'],
    ['3. Do NOT modify column headers or rename the worksheet tabs.'],
    ['4. Do NOT merge cells in the data area.'],
    ['5. One item per row.'],
    ['6. Save this file as .xlsx before uploading to Flow Force.'],
    ['7. Do NOT change the material family/category — it must match this template.'],
    [''],
    ['IMPORTANT NOTES:'],
    ['• "Current Unit Price (IDR)" is recommended for all rows.'],
    ['• The first data row below the headers is a SAMPLE ROW — delete it and replace with your real data.'],
    ['• Save and upload directly to Flow Force via the "+ Import Excel" button.'],
    [''],
    ['TEMPLATE METADATA (DO NOT EDIT):'],
    [`family_slug=${familySlug}`],
    [`family_name=${family.name}`],
    [`category=${family.category}`],
    [`version=${TEMPLATE_VERSION}`]
  ];

  const wsInstructions = XLSX.utils.aoa_to_sheet(instructionsData);
  wsInstructions['!cols'] = [{ wch: 90 }];

  // Style: Bold the title rows
  XLSX.utils.book_append_sheet(wb, wsInstructions, 'Instructions');

  // 2. Family Data Sheet
  const dataRows = [family.headers, ...family.sampleRows];
  const wsData = XLSX.utils.aoa_to_sheet(dataRows);

  // Set column widths
  wsData['!cols'] = family.colWidths.map(w => ({ wch: w }));

  // Freeze first row (headers)
  wsData['!freeze'] = { xSplit: 0, ySplit: 1 };

  // AutoFilter on header row
  if (family.headers.length > 0) {
    const lastCol = XLSX.utils.encode_col(family.headers.length - 1);
    wsData['!autofilter'] = { ref: `A1:${lastCol}1` };
  }

  const sheetName = family.sheetName || family.name.replace(/[\/\\?*:[\]]/g, '-');
  XLSX.utils.book_append_sheet(wb, wsData, sheetName);

  // Generate buffer
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

  return {
    buffer: buf,
    filename: family.filename,
    family: family
  };
}

/**
 * Generate the legacy generic template (backward compatible).
 */
function generateLegacyTemplate() {
  const wb = XLSX.utils.book_new();

  const instructionsData = [
    ['FLOW FORCE SKU & PURCHASE REQUEST AUTOMATION - INSTRUCTIONS'],
    ['1. Enter material details in the "New SKU Input" worksheet.'],
    ['2. Leave the "SKU (Leave Blank)" column empty. The system will auto-allocate the next FF-series SKU.'],
    ['3. Save and upload directly to Flow Force via "+ Import Excel".'],
    [''],
    [`Template Version: ${TEMPLATE_VERSION}`],
    ['family_slug=generic'],
    ['family_name=All Categories'],
    [`version=${TEMPLATE_VERSION}`]
  ];
  const wsInstructions = XLSX.utils.aoa_to_sheet(instructionsData);
  wsInstructions['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, wsInstructions, 'Instructions');

  const inputData = [
    LEGACY_EXPECTED_HEADERS,
    [
      '', 'Marine Grade Steel Plate AH36 16mm',
      'High-Tensile Structural Marine Steel Plate\nGrade: AH36\nDimensions: 16mm x 2000mm x 6000mm',
      'Raw Materials', 'Marine Plates', 'AH36 Marine Grade',
      '16mm x 2000mm x 6000mm', 'ASTM A131 / ABS AH36',
      'Sheet', 3014.4, 'PT Persada Nusantara Steel',
      'PT Persada Nusantara Steel', 21500000, 'Standard Stock',
      '', 'Certified mill test report required'
    ]
  ];
  const wsInput = XLSX.utils.aoa_to_sheet(inputData);
  wsInput['!cols'] = [
    { wch: 18 }, { wch: 36 }, { wch: 45 }, { wch: 18 }, { wch: 20 },
    { wch: 22 }, { wch: 26 }, { wch: 26 }, { wch: 14 }, { wch: 14 },
    { wch: 28 }, { wch: 28 }, { wch: 24 }, { wch: 18 }, { wch: 24 }, { wch: 35 }
  ];
  XLSX.utils.book_append_sheet(wb, wsInput, 'New SKU Input');

  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

// =========================================================================
// VALIDATION
// =========================================================================

/**
 * Validate an XLSX buffer for basic structural integrity.
 */
function validateXlsxBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { valid: false, error: 'File payload is not a valid binary buffer.' };
  }

  if (buffer.length < 500) {
    return { valid: false, error: `Buffer size (${buffer.length} bytes) too small for XLSX.` };
  }

  // Check ZIP signature
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    const textPrefix = buffer.slice(0, 100).toString('utf8').trim();
    if (textPrefix.startsWith('<!DOCTYPE') || textPrefix.startsWith('<html') || textPrefix.startsWith('{')) {
      return { valid: false, error: `File contains text/HTML/JSON instead of binary XLSX: "${textPrefix.slice(0, 60)}..."` };
    }
    return { valid: false, error: 'Invalid file signature: Missing OpenXML ZIP "PK" magic bytes.' };
  }

  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length === 0) {
      return { valid: false, error: 'XLSX workbook contains no readable sheets.' };
    }
    return { valid: true, workbook: wb, sheetNames: wb.SheetNames };
  } catch (err) {
    return { valid: false, error: `Failed to parse XLSX: ${err.message}` };
  }
}

/**
 * Detect the family slug from an uploaded workbook by reading Instructions sheet metadata.
 * Returns { familySlug, familyName, category, version } or null.
 */
function detectTemplateFamily(workbook) {
  if (!workbook || !workbook.SheetNames) return null;

  // Look for Instructions sheet
  const instrSheet = workbook.SheetNames.find(n => n.trim().toLowerCase() === 'instructions');
  if (!instrSheet) return null;

  const ws = workbook.Sheets[instrSheet];
  if (!ws) return null;

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const metadata = {};

  for (const row of rows) {
    const cell = String(row[0] || '').trim();
    const match = cell.match(/^(family_slug|family_name|category|version)=(.+)$/i);
    if (match) {
      metadata[match[1].toLowerCase()] = match[2].trim();
    }
    // Also check "Material Family: XXX" format
    const familyMatch = cell.match(/^Material Family:\s*(.+)$/i);
    if (familyMatch) {
      metadata['family_name'] = familyMatch[1].trim();
    }
    const catMatch = cell.match(/^Category:\s*(.+)$/i);
    if (catMatch) {
      metadata['category'] = catMatch[1].trim();
    }
    const verMatch = cell.match(/^Template Version:\s*(.+)$/i);
    if (verMatch) {
      metadata['version'] = verMatch[1].trim();
    }
  }

  if (metadata.family_slug || metadata.family_name) {
    return {
      familySlug: metadata.family_slug || null,
      familyName: metadata.family_name || null,
      category: metadata.category || null,
      version: metadata.version || null
    };
  }

  // Fallback: detect from sheet names
  for (const [slug, family] of Object.entries(FAMILY_REGISTRY)) {
    const targetSheet = (family.sheetName || family.name).toLowerCase();
    const cleanName = family.name.replace(/[\/\\?*:[\]]/g, '-').toLowerCase();
    if (workbook.SheetNames.some(n => {
      const lower = n.trim().toLowerCase();
      return lower === targetSheet || lower === family.name.toLowerCase() || lower === cleanName;
    })) {
      return {
        familySlug: slug,
        familyName: family.name,
        category: family.category,
        version: null
      };
    }
  }

  // Legacy template detection
  if (workbook.SheetNames.some(n => n.trim().toLowerCase() === 'new sku input')) {
    return {
      familySlug: 'generic',
      familyName: 'All Categories',
      category: null,
      version: null
    };
  }

  return null;
}

// =========================================================================
// EXPRESS HANDLERS
// =========================================================================

/**
 * Express handler: Serve a family-specific template download.
 * GET /api/import-submissions/template?family=fasteners
 * GET /api/import-submissions/template (defaults to raw-materials)
 * 
 * NO AUTHENTICATION REQUIRED — templates are public downloads.
 */
function serveFamilyTemplateDownload(req, res) {
  try {
    const familySlug = req.query.family || 'raw-materials';

    // Validate against allowlist — never accept arbitrary strings
    const validSlugs = getFamilySlugs();
    if (!validSlugs.includes(familySlug)) {
      return res.status(400).json({
        error: `Unknown material family: "${familySlug}".`,
        availableFamilies: validSlugs
      });
    }

    const result = generateFamilyTemplate(familySlug);
    const validation = validateXlsxBuffer(result.buffer);

    if (!validation.valid) {
      console.error(`[TemplateService] Generated ${familySlug} template failed validation:`, validation.error);
      return res.status(500).json({
        error: 'Server failed to generate a valid Excel template.',
        details: validation.error
      });
    }

    console.log(`[TemplateService] Serving ${familySlug} template: ${result.filename} (${result.buffer.length} bytes)`);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length': String(result.buffer.length),
      'Cache-Control': 'no-cache, no-store, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Template-Family': familySlug,
      'X-Template-Version': TEMPLATE_VERSION
    });

    return res.status(200).end(result.buffer);
  } catch (err) {
    console.error('[TemplateService] Error serving family template:', err);
    return res.status(500).json({
      error: 'Internal error generating template.',
      message: err.message
    });
  }
}

/**
 * Express handler: List available template families.
 * GET /api/import-submissions/template-families
 */
function listTemplateFamilies(req, res) {
  const families = Object.entries(FAMILY_REGISTRY).map(([slug, family]) => ({
    slug,
    name: family.name,
    category: family.category,
    filename: family.filename,
    columnCount: family.headers.length,
    downloadUrl: `/api/import-submissions/template?family=${slug}`
  }));

  res.json({
    templateVersion: TEMPLATE_VERSION,
    families
  });
}

/**
 * Legacy backward-compatible handler: serves generic template.
 * Used for /Flow_Force_New_SKU_Input_Template.xlsx
 */
function serveLegacyTemplateDownload(req, res) {
  try {
    const buffer = generateLegacyTemplate();
    const validation = validateXlsxBuffer(buffer);

    if (!validation.valid) {
      console.error('[TemplateService] Legacy template failed validation:', validation.error);
      return res.status(500).json({ error: 'Failed to generate template.', details: validation.error });
    }

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Flow_Force_New_SKU_Input_Template.xlsx"',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-cache, no-store, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    return res.status(200).end(buffer);
  } catch (err) {
    console.error('[TemplateService] Legacy template error:', err);
    return res.status(500).json({ error: 'Internal error.', message: err.message });
  }
}

module.exports = {
  TEMPLATE_VERSION,
  FAMILY_REGISTRY,
  LEGACY_EXPECTED_HEADERS,
  getFamilySlugs,
  getFamilyBySlug,
  getFamilyByCategory,
  generateFamilyTemplate,
  generateLegacyTemplate,
  validateXlsxBuffer,
  detectTemplateFamily,
  serveFamilyTemplateDownload,
  listTemplateFamilies,
  serveLegacyTemplateDownload,
  // Backward compat aliases
  serveTemplateDownload: serveFamilyTemplateDownload,
  EXPECTED_HEADERS: LEGACY_EXPECTED_HEADERS,
  getOrGenerateTemplateBuffer: () => generateLegacyTemplate(),
  generateStandardTemplateWorkbook: () => generateLegacyTemplate()
};
