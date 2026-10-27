/**
 * =========================================================================
 * IMPORT SUBMISSIONS ROUTER
 * Controlled Excel/CSV Import Staging, Employee Submissions & Admin Review
 * =========================================================================
 */
const express = require('express');
const router = express.Router();
const { query, pool } = require('../db/pool');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  serveFamilyTemplateDownload,
  listTemplateFamilies,
  detectTemplateFamily,
  getFamilyBySlug,
  TEMPLATE_VERSION
} = require('../services/templateService');
const {
  isTextPlaceholder,
  isNumericPlaceholder,
  parseIndonesianNumber,
  normalizeTextForMatching,
  getItemMatchKey
} = require('../services/numberUtils');

// Helper: Format Import ID (e.g. IMP-0001)
function formatImportId(seq) {
  return `IMP-${String(seq).padStart(4, '0')}`;
}

/**
 * GET /api/import-submissions/template?family=fasteners
 * Download a family-specific Excel import template.
 * PUBLIC — NO AUTHENTICATION REQUIRED (browser <a download> cannot send JWT).
 * Defaults to family=raw-materials if no family query param.
 */
router.get('/template', serveFamilyTemplateDownload);

/**
 * GET /api/import-submissions/template-families
 * List all available material families with download URLs.
 * PUBLIC — used by the UI to populate the family selector.
 */
router.get('/template-families', listTemplateFamilies);

/**
 * POST /api/import-submissions
 * Submit an Excel import for Admin review.
 * Available to both EMPLOYEE and ADMIN.
 * Creates an Import Submission record in PENDING_REVIEW status.
 * NEVER writes directly to master_items.
 */
router.post('/', authenticateToken, async (req, res) => {
  const { fileName, items, materialFamily, templateVersion } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided for import.' });
  }

  // Determine target family & category
  let familyDef = null;
  if (materialFamily) {
    familyDef = getFamilyBySlug(materialFamily);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Determine next import sequence number
    const maxSubRes = await client.query(`
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(import_id FROM '^IMP-([0-9]+)$') AS INTEGER)),
        0
      ) AS max_seq
      FROM import_submissions
      WHERE import_id ~ '^IMP-[0-9]+$'
    `);
    const nextSeq = parseInt(maxSubRes.rows[0].max_seq, 10) + 1;
    const importId = formatImportId(nextSeq);

    // 2. Fetch existing active master items to check duplicates/updates
    const existingSkusRes = await client.query('SELECT id, sku, product_name, item_description FROM master_items');
    const existingSkuMap = new Map();
    const existingNameDescMap = new Map();

    existingSkusRes.rows.forEach(r => {
      if (r.sku) {
        const s = r.sku.trim().toUpperCase();
        if (!existingSkuMap.has(s)) existingSkuMap.set(s, []);
        existingSkuMap.get(s).push(r);
      }
      const key = getItemMatchKey(r.product_name, r.item_description);
      if (!existingNameDescMap.has(key)) existingNameDescMap.set(key, []);
      existingNameDescMap.get(key).push(r);
    });

    // In-file duplicate trackers
    const fileSkuMap = new Map();
    const fileKeyMap = new Map();

    // 3. Create Import Submission Header
    const subInsertRes = await client.query(`
      INSERT INTO import_submissions (
        import_id,
        file_name,
        uploaded_by_user_id,
        uploaded_by_username,
        status,
        total_rows,
        material_family,
        template_version
      ) VALUES ($1, $2, $3, $4, 'PENDING_REVIEW', $5, $6, $7)
      RETURNING *
    `, [
      importId,
      fileName || 'Import.xlsx',
      req.user.id,
      req.user.username,
      items.length,
      familyDef ? familyDef.name : (materialFamily || null),
      templateVersion || TEMPLATE_VERSION || '1.0'
    ]);

    const submission = subInsertRes.rows[0];

    // 4. Validate and insert each row into import_submission_items
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rowNum = it.rowNumber || (i + 1);
      const rawSku = isTextPlaceholder(it.sku) ? '' : String(it.sku || '').trim();
      const isBlankSku = !rawSku;
      const cleanProdName = isTextPlaceholder(it.productName) ? '' : String(it.productName).trim();
      const cleanDesc = isTextPlaceholder(it.itemDescription) ? '' : String(it.itemDescription).trim();

      let isDuplicate = false;
      let matchedSku = null;
      let isAmbiguous = false;

      // 1. Matching existing items:
      // Match by SKU only (case-insensitive, trimmed).
      // If no SKU, match only on Product Name + Item Description together (normalized).
      // If one row matches more than one existing item, show warning ("Ambiguous match — will create new") and don't update anything.
      if (!isBlankSku) {
        const matches = existingSkuMap.get(rawSku.toUpperCase()) || [];
        if (matches.length === 1) {
          isDuplicate = true;
          matchedSku = matches[0].sku;
        } else if (matches.length > 1) {
          isAmbiguous = true;
        }
      } else if (cleanProdName) {
        const key = getItemMatchKey(cleanProdName, cleanDesc);
        const matches = existingNameDescMap.get(key) || [];
        if (matches.length === 1) {
          isDuplicate = true;
          matchedSku = matches[0].sku;
        } else if (matches.length > 1) {
          isAmbiguous = true;
        }
      }

      // 2. In-file duplicate check:
      // Rows with same Product Name but different Description are separate new items.
      // Only flag exact duplicates (same name + same description, or same non-blank SKU).
      let isFileDuplicate = false;
      if (!isBlankSku) {
        if (fileSkuMap.has(rawSku.toUpperCase())) {
          isFileDuplicate = true;
        } else {
          fileSkuMap.set(rawSku.toUpperCase(), rowNum);
        }
      } else if (cleanProdName) {
        const key = getItemMatchKey(cleanProdName, cleanDesc);
        if (fileKeyMap.has(key)) {
          isFileDuplicate = true;
        } else {
          fileKeyMap.set(key, rowNum);
        }
      }

      // Validation logic: Only Product Name and UOM are mandatory
      const errors = [];
      if (!cleanProdName) {
        errors.push('Missing Product Name');
      }

      const cleanUnit = isTextPlaceholder(it.unit) ? '' : String(it.unit).trim();
      if (!cleanUnit) {
        errors.push('Missing UOM');
      }

      // Parse unit price (Indonesian format aware; null if empty/placeholder)
      const parsedPrice = parseIndonesianNumber(it.unitPrice, true);
      if (!parsedPrice.isValid) {
        errors.push('Invalid Unit Price');
      }
      const price = parsedPrice.value; // null or numeric

      // Parse weight (null if empty/placeholder)
      const parsedWeight = parseIndonesianNumber(it.weightKg, false);
      if (!parsedWeight.isValid) {
        errors.push('Invalid Weight');
      }
      const weight = parsedWeight.value; // null or numeric

      // Check dimension A, B, C, D, L1, L2 if provided (skip numeric placeholders)
      const dims = ['dimA', 'dimB', 'dimC', 'dimD', 'dimL1', 'dimL2'];
      dims.forEach(d => {
        if (it[d] !== undefined && it[d] !== null && !isNumericPlaceholder(it[d])) {
          const val = String(it[d]).trim();
          if (/[<>{}\\]/.test(val)) {
            errors.push(`Invalid ${d.replace('dim', 'Dimension ')}`);
          }
        }
      });

      if (isAmbiguous) {
        errors.push('Ambiguous match — will create new');
      } else if (isDuplicate) {
        errors.push(`Existing item found (${matchedSku}) — will update record.`);
      }

      if (isFileDuplicate) {
        errors.push('Duplicate record within file (same name & description)');
      }

      const hasBlockingErrors = errors.some(e => 
        !e.startsWith('Existing item found') && 
        !e.startsWith('Ambiguous match') && 
        !e.startsWith('Duplicate record within file')
      );
      const isWarning = isDuplicate || isAmbiguous || isFileDuplicate;
      const validationStatus = hasBlockingErrors ? 'INVALID' : (isWarning ? 'WARNING' : 'VALID');
      const validationError = errors.join('; ');

      const cleanCategory = isTextPlaceholder(it.category) ? (familyDef ? familyDef.category : 'Raw Materials') : String(it.category).trim();
      const cleanSubCat = isTextPlaceholder(it.subCategory) ? '' : String(it.subCategory).trim();
      const cleanMaterial = isTextPlaceholder(it.material) ? '' : String(it.material).trim();
      const cleanSize = isTextPlaceholder(it.size) ? '' : String(it.size).trim();
      const cleanSpec = isTextPlaceholder(it.specification) ? '' : String(it.specification).trim();
      const cleanBrand = isTextPlaceholder(it.brand) ? '' : String(it.brand).trim();
      const cleanSupplier = isTextPlaceholder(it.supplierName) ? '' : String(it.supplierName).trim();
      const cleanRemarks = isTextPlaceholder(it.remarks) ? '' : String(it.remarks).trim();

      await client.query(`
        INSERT INTO import_submission_items (
          submission_id,
          row_number,
          source_sheet,
          sku,
          product_name,
          item_description,
          category,
          sub_category,
          material,
          size,
          specification,
          unit,
          weight_kg,
          unit_price,
          supply_type,
          brand,
          supplier_name,
          remarks,
          dim_a,
          dim_b,
          dim_c,
          dim_d,
          dim_l1,
          dim_l2,
          validation_status,
          validation_error,
          is_duplicate_sku
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27
        )
      `, [
        submission.id,
        rowNum,
        it.sourceSheet || 'Sheet1',
        rawSku || '',
        cleanProdName,
        cleanDesc,
        cleanCategory,
        cleanSubCat,
        cleanMaterial,
        cleanSize,
        cleanSpec,
        cleanUnit,
        weight,
        price,
        it.supplyType === 'Cut Size' ? 'Cut Size' : 'Full Size',
        cleanBrand,
        cleanSupplier,
        cleanRemarks,
        (it.dimA && !isNumericPlaceholder(it.dimA)) ? String(it.dimA).trim() : '',
        (it.dimB && !isNumericPlaceholder(it.dimB)) ? String(it.dimB).trim() : '',
        (it.dimC && !isNumericPlaceholder(it.dimC)) ? String(it.dimC).trim() : '',
        (it.dimD && !isNumericPlaceholder(it.dimD)) ? String(it.dimD).trim() : '',
        (it.dimL1 && !isNumericPlaceholder(it.dimL1)) ? String(it.dimL1).trim() : '',
        (it.dimL2 && !isNumericPlaceholder(it.dimL2)) ? String(it.dimL2).trim() : '',
        validationStatus,
        validationError,
        isDuplicate
      ]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      importId: submission.import_id,
      import_id: submission.import_id,
      message: `Import submission ${submission.import_id} created successfully and queued for Admin review.`,
      submission: {
        id: submission.id,
        importId: submission.import_id,
        import_id: submission.import_id,
        fileName: submission.file_name,
        file_name: submission.file_name,
        uploadedByUsername: submission.uploaded_by_username,
        uploaded_by_username: submission.uploaded_by_username,
        uploadedAt: submission.created_at,
        created_at: submission.created_at,
        totalRows: submission.total_rows,
        total_rows: submission.total_rows,
        materialFamily: submission.material_family,
        material_family: submission.material_family,
        templateVersion: submission.template_version,
        template_version: submission.template_version,
        status: submission.status
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Import Submissions] POST error:', err);
    res.status(500).json({ error: 'Failed to create import submission. Transaction rolled back.' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/import-submissions
 * List import submissions.
 * Admin sees all submissions.
 * Employee sees only their own submissions ("My Imports").
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let sql = `
      SELECT 
        s.id,
        s.import_id,
        s.file_name,
        s.uploaded_by_user_id,
        s.uploaded_by_username,
        s.status,
        s.total_rows,
        s.material_family,
        s.template_version,
        s.approved_by_user_id,
        s.approved_by_username,
        s.approved_at,
        s.rejected_by_user_id,
        s.rejected_by_username,
        s.rejected_at,
        s.rejection_reason,
        s.created_at,
        s.updated_at,
        u.full_name AS uploaded_by_full_name
      FROM import_submissions s
      LEFT JOIN users u ON u.id = s.uploaded_by_user_id
    `;
    const params = [];

    if (req.user.role !== 'ADMIN') {
      sql += ' WHERE s.uploaded_by_user_id = $1';
      params.push(req.user.id);
    }

    sql += ' ORDER BY s.id DESC';

    const result = await query(sql, params);

    const submissions = result.rows.map(r => ({
      id: r.id,
      importId: r.import_id,
      import_id: r.import_id,
      fileName: r.file_name,
      file_name: r.file_name,
      materialFamily: r.material_family,
      material_family: r.material_family,
      templateVersion: r.template_version,
      template_version: r.template_version,
      uploadedByUserId: r.uploaded_by_user_id,
      uploaded_by_user_id: r.uploaded_by_user_id,
      uploadedByUsername: r.uploaded_by_username,
      uploaded_by_username: r.uploaded_by_username,
      uploadedByFullName: r.uploaded_by_full_name || r.uploaded_by_username,
      uploaded_by_full_name: r.uploaded_by_full_name || r.uploaded_by_username,
      status: r.status,
      totalRows: r.total_rows,
      total_rows: r.total_rows,
      approvedByUserId: r.approved_by_user_id,
      approved_by_user_id: r.approved_by_user_id,
      approvedByUsername: r.approved_by_username,
      approved_by_username: r.approved_by_username,
      approvedAt: r.approved_at,
      approved_at: r.approved_at,
      rejectedByUserId: r.rejected_by_user_id,
      rejected_by_user_id: r.rejected_by_user_id,
      rejectedByUsername: r.rejected_by_username,
      rejected_by_username: r.rejected_by_username,
      rejectedAt: r.rejected_at,
      rejected_at: r.rejected_at,
      rejectionReason: r.rejection_reason,
      rejection_reason: r.rejection_reason,
      createdAt: r.created_at,
      created_at: r.created_at,
      updatedAt: r.updated_at,
      updated_at: r.updated_at
    }));

    res.json(submissions);
  } catch (err) {
    console.error('[Import Submissions] GET list error:', err);
    res.status(500).json({ error: 'Failed to fetch import submissions.' });
  }
});

/**
 * GET /api/import-submissions/:id
 * Get details and items of a specific submission.
 */
router.get('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const isNumeric = /^\d+$/.test(String(id).trim());

  try {
    const subRes = await query(`
      SELECT 
        s.*,
        u.full_name AS uploaded_by_full_name
      FROM import_submissions s
      LEFT JOIN users u ON u.id = s.uploaded_by_user_id
      WHERE ${isNumeric ? 's.id = $1' : 's.import_id = $1'}
    `, [isNumeric ? parseInt(id, 10) : id]);

    if (subRes.rowCount === 0) {
      return res.status(404).json({ error: 'Import submission not found.' });
    }

    const sub = subRes.rows[0];

    // Restrict non-admin from viewing others' submissions
    if (req.user.role !== 'ADMIN' && sub.uploaded_by_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access Denied — You can only view your own imports.' });
    }

    const itemsRes = await query(`
      SELECT * FROM import_submission_items
      WHERE submission_id = $1
      ORDER BY row_number ASC
    `, [sub.id]);

    res.json({
      submission: {
        id: sub.id,
        importId: sub.import_id,
        import_id: sub.import_id,
        fileName: sub.file_name,
        file_name: sub.file_name,
        uploadedByUserId: sub.uploaded_by_user_id,
        uploaded_by_user_id: sub.uploaded_by_user_id,
        uploadedByUsername: sub.uploaded_by_username,
        uploaded_by_username: sub.uploaded_by_username,
        uploadedByFullName: sub.uploaded_by_full_name || sub.uploaded_by_username,
        uploaded_by_full_name: sub.uploaded_by_full_name || sub.uploaded_by_username,
        status: sub.status,
        totalRows: sub.total_rows,
        total_rows: sub.total_rows,
        materialFamily: sub.material_family,
        material_family: sub.material_family,
        templateVersion: sub.template_version,
        template_version: sub.template_version,
        approvedByUserId: sub.approved_by_user_id,
        approved_by_user_id: sub.approved_by_user_id,
        approvedByUsername: sub.approved_by_username,
        approved_by_username: sub.approved_by_username,
        approvedAt: sub.approved_at,
        approved_at: sub.approved_at,
        rejectedByUserId: sub.rejected_by_user_id,
        rejected_by_user_id: sub.rejected_by_user_id,
        rejectedByUsername: sub.rejected_by_username,
        rejected_by_username: sub.rejected_by_username,
        rejectedAt: sub.rejected_at,
        rejected_at: sub.rejected_at,
        rejectionReason: sub.rejection_reason,
        rejection_reason: sub.rejection_reason,
        createdAt: sub.created_at,
        created_at: sub.created_at,
        updatedAt: sub.updated_at,
        updated_at: sub.updated_at
      },
      items: itemsRes.rows.map(it => ({
        id: it.id,
        rowNumber: it.row_number,
        row_number: it.row_number,
        sourceSheet: it.source_sheet,
        source_sheet: it.source_sheet,
        sku: it.sku,
        assignedMasterSku: it.assigned_master_sku,
        assigned_master_sku: it.assigned_master_sku,
        productName: it.product_name,
        product_name: it.product_name,
        itemDescription: it.item_description,
        item_description: it.item_description,
        category: it.category,
        subCategory: it.sub_category,
        sub_category: it.sub_category,
        material: it.material,
        size: it.size,
        specification: it.specification,
        unit: it.unit,
        weightKg: it.weight_kg ? parseFloat(it.weight_kg) : null,
        weight_kg: it.weight_kg ? parseFloat(it.weight_kg) : null,
        unitPrice: it.unit_price ? parseFloat(it.unit_price) : null,
        unit_price: it.unit_price ? parseFloat(it.unit_price) : null,
        supplyType: it.supply_type,
        supply_type: it.supply_type,
        brand: it.brand,
        supplierName: it.supplier_name,
        supplier_name: it.supplier_name,
        remarks: it.remarks,
        dimA: it.dim_a,
        dim_a: it.dim_a,
        dimB: it.dim_b,
        dim_b: it.dim_b,
        dimC: it.dim_c,
        dim_c: it.dim_c,
        dimD: it.dim_d,
        dim_d: it.dim_d,
        dimL1: it.dim_l1,
        dim_l1: it.dim_l1,
        dimL2: it.dim_l2,
        dim_l2: it.dim_l2,
        validationStatus: it.validation_status,
        validation_status: it.validation_status,
        validationError: it.validation_error,
        validation_error: it.validation_error,
        isDuplicateSku: it.is_duplicate_sku,
        is_duplicate_sku: it.is_duplicate_sku
      }))
    });
  } catch (err) {
    console.error('[Import Submissions] GET details error:', err);
    res.status(500).json({ error: 'Failed to fetch submission details.' });
  }
});

/**
 * PUT /api/import-submissions/:id/items/:itemId
 * Admin edit item row before approval.
 */
router.put('/:id/items/:itemId', authenticateToken, requireAdmin, async (req, res) => {
  const { id, itemId } = req.params;
  const isNumeric = /^\d+$/.test(String(id).trim());
  const updates = req.body;

  try {
    const subRes = await query(`SELECT * FROM import_submissions WHERE ${isNumeric ? 'id = $1' : 'import_id = $1'}`, [isNumeric ? parseInt(id, 10) : id]);
    if (subRes.rowCount === 0) return res.status(404).json({ error: 'Submission not found.' });
    const sub = subRes.rows[0];
    if (sub.status !== 'PENDING_REVIEW') {
      return res.status(400).json({ error: 'Cannot edit an import that is already approved or rejected.' });
    }

    const pName = updates.productName !== undefined ? updates.productName : updates.product_name;
    const mat = updates.material !== undefined ? updates.material : null;
    const sz = updates.size !== undefined ? updates.size : null;
    const priceVal = updates.unitPrice !== undefined ? updates.unitPrice : updates.unit_price;
    const weightVal = updates.weightKg !== undefined ? updates.weightKg : updates.weight_kg;
    const rem = updates.remarks !== undefined ? updates.remarks : null;
    const desc = updates.itemDescription !== undefined ? updates.itemDescription : updates.item_description;
    const subCat = updates.subCategory !== undefined ? updates.subCategory : updates.sub_category;
    const u = updates.unit !== undefined ? updates.unit : null;
    const supType = updates.supplyType !== undefined ? updates.supplyType : updates.supply_type;

    const price = (priceVal !== undefined && priceVal !== null && priceVal !== '')
      ? Number(priceVal) : null;
    const weight = (weightVal !== undefined && weightVal !== null && weightVal !== '')
      ? Number(weightVal) : null;

    const updateRes = await query(`
      UPDATE import_submission_items
      SET 
        product_name = COALESCE($1, product_name),
        material = COALESCE($2, material),
        size = COALESCE($3, size),
        unit_price = CASE WHEN $4::boolean THEN $5::numeric ELSE unit_price END,
        weight_kg = CASE WHEN $6::boolean THEN $7::numeric ELSE weight_kg END,
        remarks = COALESCE($8, remarks),
        item_description = COALESCE($9, item_description),
        sub_category = COALESCE($10, sub_category),
        unit = COALESCE($11, unit),
        supply_type = COALESCE($12, supply_type),
        validation_status = 'VALID',
        validation_error = ''
      WHERE id = $13 AND submission_id = $14
      RETURNING *
    `, [
      pName || null,
      mat || null,
      sz || null,
      priceVal !== undefined,
      price,
      weightVal !== undefined,
      weight,
      rem || null,
      desc || null,
      subCat || null,
      u || null,
      supType || null,
      itemId,
      sub.id
    ]);

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Item not found in submission.' });
    }

    res.json({ success: true, message: 'Item updated.', item: updateRes.rows[0] });
  } catch (err) {
    console.error('[Import Submissions] PUT item error:', err);
    res.status(500).json({ error: 'Failed to update item.' });
  }
});

/**
 * POST /api/import-submissions/:id/approve
 * Admin approves submission -> Atomic insertion into master_items.
 * Sequential FF SKUs generated.
 */
router.post('/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const isNumeric = /^\d+$/.test(String(id).trim());

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Advisory lock prevents concurrent SKU allocation race conditions
    await client.query('SELECT pg_advisory_xact_lock(987654321)');

    const subRes = await client.query(`SELECT * FROM import_submissions WHERE ${isNumeric ? 'id = $1' : 'import_id = $1'} FOR UPDATE`, [isNumeric ? parseInt(id, 10) : id]);
    if (subRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Import submission not found.' });
    }

    const submission = subRes.rows[0];
    if (submission.status !== 'PENDING_REVIEW') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot approve submission in status ${submission.status}.` });
    }

    const itemsRes = await client.query(`
      SELECT * FROM import_submission_items
      WHERE submission_id = $1
      ORDER BY row_number ASC
    `, [submission.id]);

    if (itemsRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Submission contains no items.' });
    }

    // Determine next starting sequential SKU
    const maxRes = await client.query(`
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(sku FROM '^FF([0-9]+)$') AS INTEGER)),
        4235
      ) AS max_seq
      FROM master_items
      WHERE sku ~ '^FF[0-9]+$'
    `);

    let currentSeq = Math.max(parseInt(maxRes.rows[0].max_seq, 10), 4235);
    const insertedMasterItems = [];

    // Fetch existing active master items for exact SKU or Product Name + Description matching
    const allExistingRes = await client.query('SELECT * FROM master_items');
    const existingSkuMap = new Map();
    const existingNameDescMap = new Map();

    allExistingRes.rows.forEach(r => {
      if (r.sku) {
        const s = r.sku.trim().toUpperCase();
        if (!existingSkuMap.has(s)) existingSkuMap.set(s, []);
        existingSkuMap.get(s).push(r);
      }
      const key = getItemMatchKey(r.product_name, r.item_description);
      if (!existingNameDescMap.has(key)) existingNameDescMap.set(key, []);
      existingNameDescMap.get(key).push(r);
    });

    for (const it of itemsRes.rows) {
      let existingMatch = null;
      const cleanSku = (it.sku && !isTextPlaceholder(it.sku)) ? it.sku.trim() : '';
      const cleanName = (it.product_name && !isTextPlaceholder(it.product_name)) ? it.product_name.trim() : '';
      const cleanDesc = (it.item_description && !isTextPlaceholder(it.item_description)) ? it.item_description.trim() : '';

      if (cleanSku) {
        const matches = existingSkuMap.get(cleanSku.toUpperCase()) || [];
        if (matches.length === 1) {
          existingMatch = matches[0];
        } else if (matches.length > 1) {
          existingMatch = null; // Ambiguous match — will create new
        }
      } else if (cleanName) {
        const key = getItemMatchKey(cleanName, cleanDesc);
        const matches = existingNameDescMap.get(key) || [];
        if (matches.length === 1) {
          existingMatch = matches[0];
        } else if (matches.length > 1) {
          existingMatch = null; // Ambiguous match — will create new
        }
      }

      if (existingMatch) {
        // Updates must never erase data: skip any blank or placeholder field, keep existing DB value
        const isReal = (v) => v !== undefined && v !== null && !isTextPlaceholder(v) && String(v).trim() !== '';

        const updatedDesc = isReal(it.item_description) ? String(it.item_description).trim() : existingMatch.item_description;
        const updatedCategory = isReal(it.category) ? String(it.category).trim() : existingMatch.category;
        const updatedSubCat = isReal(it.sub_category) ? String(it.sub_category).trim() : existingMatch.sub_category;
        const updatedMaterial = isReal(it.material) ? String(it.material).trim() : existingMatch.material;
        const updatedSize = isReal(it.size) ? String(it.size).trim() : existingMatch.size;
        const updatedSpec = isReal(it.specification) ? String(it.specification).trim() : existingMatch.specification;
        const updatedUnit = isReal(it.unit) ? String(it.unit).trim() : existingMatch.unit;
        const updatedWeight = (it.weight_kg !== null && it.weight_kg !== undefined) ? it.weight_kg : existingMatch.weight_kg;
        const updatedSupplyType = isReal(it.supply_type) ? String(it.supply_type).trim() : existingMatch.supply_type;
        const updatedRemarks = isReal(it.remarks) ? String(it.remarks).trim() : existingMatch.remarks;
        const updatedBrand = isReal(it.brand) ? String(it.brand).trim() : existingMatch.brand;
        const updatedPrice = (it.unit_price !== null && it.unit_price !== undefined) ? it.unit_price : existingMatch.unit_price;
        const updatedSourceSheet = isReal(it.source_sheet) ? String(it.source_sheet).trim() : existingMatch.source_sheet;

        const updateRes = await client.query(`
          UPDATE master_items SET
            item_description = $1,
            category = $2,
            sub_category = $3,
            material = $4,
            size = $5,
            specification = $6,
            unit = $7,
            weight_kg = $8,
            supply_type = $9,
            remarks = $10,
            brand = $11,
            unit_price = $12,
            source_sheet = $13,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $14
          RETURNING *
        `, [
          updatedDesc,
          updatedCategory,
          updatedSubCat,
          updatedMaterial,
          updatedSize,
          updatedSpec,
          updatedUnit,
          updatedWeight,
          updatedSupplyType,
          updatedRemarks,
          updatedBrand,
          updatedPrice,
          updatedSourceSheet,
          existingMatch.id
        ]);

        insertedMasterItems.push(updateRes.rows[0]);

        await client.query(`
          UPDATE import_submission_items
          SET assigned_master_sku = $1
          WHERE id = $2
        `, [existingMatch.sku, it.id]);
      } else {
        currentSeq++;
        const assignedSku = `FF${currentSeq}`;

        const insertRes = await client.query(`
          INSERT INTO master_items (
            sku,
            product_name,
            item_description,
            category,
            sub_category,
            material,
            size,
            specification,
            unit,
            weight_kg,
            status,
            supply_type,
            remarks,
            brand,
            unit_price,
            source_sheet
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16
          )
          RETURNING *
        `, [
          assignedSku,
          cleanName,
          cleanDesc,
          it.category || 'Raw Materials',
          it.sub_category || '',
          it.material || '',
          it.size || '',
          it.specification || 'PT Persada Nusantara Steel Standard',
          it.unit || 'Pcs',
          it.weight_kg !== null ? it.weight_kg : null,
          'Available',
          it.supply_type || 'Full Size',
          it.remarks || '',
          it.brand || '',
          it.unit_price !== null ? it.unit_price : null,
          it.source_sheet || submission.file_name
        ]);

        const insertedItem = insertRes.rows[0];
        insertedMasterItems.push(insertedItem);

        // Update in-memory index for subsequent items
        const newKey = getItemMatchKey(insertedItem.product_name, insertedItem.item_description);
        if (!existingNameDescMap.has(newKey)) existingNameDescMap.set(newKey, []);
        existingNameDescMap.get(newKey).push(insertedItem);
        if (!existingSkuMap.has(assignedSku)) existingSkuMap.set(assignedSku, []);
        existingSkuMap.get(assignedSku).push(insertedItem);

        await client.query(`
          UPDATE import_submission_items
          SET assigned_master_sku = $1
          WHERE id = $2
        `, [assignedSku, it.id]);
      }
    }

    // Update submission status to APPROVED
    await client.query(`
      UPDATE import_submissions
      SET 
        status = 'APPROVED',
        approved_by_user_id = $1,
        approved_by_username = $2,
        approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [req.user.id, req.user.username, submission.id]);

    await client.query('COMMIT');

    const startSku = insertedMasterItems[0].sku;
    const endSku = insertedMasterItems[insertedMasterItems.length - 1].sku;

    res.json({
      success: true,
      message: `Import submission ${submission.import_id} approved. ${insertedMasterItems.length} Master Items committed (${startSku} – ${endSku}).`,
      startSku,
      endSku,
      rowsImported: insertedMasterItems.length,
      count: insertedMasterItems.length,
      approvedItems: insertedMasterItems
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Import Submissions] Approve error:', err);
    res.status(500).json({ error: 'Failed to approve import submission. Transaction rolled back.' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/import-submissions/:id/reject
 * Admin rejects submission with a reason.
 * Items are NOT written to master_items.
 */
router.post('/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const isNumeric = /^\d+$/.test(String(id).trim());
  const { rejectionReason } = req.body;

  try {
    const subRes = await query(`SELECT * FROM import_submissions WHERE ${isNumeric ? 'id = $1' : 'import_id = $1'}`, [isNumeric ? parseInt(id, 10) : id]);
    if (subRes.rowCount === 0) {
      return res.status(404).json({ error: 'Import submission not found.' });
    }

    const submission = subRes.rows[0];
    if (submission.status !== 'PENDING_REVIEW') {
      return res.status(400).json({ error: `Cannot reject submission in status ${submission.status}.` });
    }

    const reason = (rejectionReason && String(rejectionReason).trim()) ? String(rejectionReason).trim() : 'Rejected by Administrator';

    await query(`
      UPDATE import_submissions
      SET 
        status = 'REJECTED',
        rejected_by_user_id = $1,
        rejected_by_username = $2,
        rejected_at = CURRENT_TIMESTAMP,
        rejection_reason = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [req.user.id, req.user.username, reason, submission.id]);

    res.json({
      success: true,
      message: `Import submission ${submission.import_id} rejected. Reason: ${reason}`
    });
  } catch (err) {
    console.error('[Import Submissions] Reject error:', err);
    res.status(500).json({ error: 'Failed to reject import submission.' });
  }
});

module.exports = router;
