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

// Helper: Format Import ID (e.g. IMP-0001)
function formatImportId(seq) {
  return `IMP-${String(seq).padStart(4, '0')}`;
}

/**
 * POST /api/import-submissions
 * Submit an Excel import for Admin review.
 * Available to both EMPLOYEE and ADMIN.
 * Creates an Import Submission record in PENDING_REVIEW status.
 * NEVER writes directly to master_items.
 */
router.post('/', authenticateToken, async (req, res) => {
  const { fileName, items } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided for import.' });
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

    // 2. Fetch existing active master SKUs to check duplicates
    const existingSkusRes = await client.query('SELECT sku FROM master_items');
    const existingSkuSet = new Set(existingSkusRes.rows.map(r => r.sku.toUpperCase().trim()));

    // 3. Create Import Submission Header
    const subInsertRes = await client.query(`
      INSERT INTO import_submissions (
        import_id,
        file_name,
        uploaded_by_user_id,
        uploaded_by_username,
        status,
        total_rows
      ) VALUES ($1, $2, $3, $4, 'PENDING_REVIEW', $5)
      RETURNING *
    `, [
      importId,
      fileName || 'Import.xlsx',
      req.user.id,
      req.user.username,
      items.length
    ]);

    const submission = subInsertRes.rows[0];

    // 4. Validate and insert each row into import_submission_items
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rowNum = it.rowNumber || (i + 1);
      const rawSku = String(it.sku || '').trim();
      const isBlankSku = !rawSku;
      const isDuplicate = !isBlankSku && existingSkuSet.has(rawSku.toUpperCase());

      // Validation logic
      const errors = [];
      if (!it.productName || String(it.productName).trim() === '') {
        errors.push('Missing Product Name');
      }
      if (!it.material || String(it.material).trim() === '') {
        errors.push('Missing Material / Grade');
      }
      if (it.unitPrice !== undefined && it.unitPrice !== null && String(it.unitPrice).trim() !== '') {
        const pNum = Number(it.unitPrice);
        if (isNaN(pNum) || pNum < 0) {
          errors.push('Invalid Unit Price');
        }
      }
      if (it.weightKg !== undefined && it.weightKg !== null && String(it.weightKg).trim() !== '') {
        const wNum = Number(it.weightKg);
        if (isNaN(wNum) || wNum < 0) {
          errors.push('Invalid Weight');
        }
      }

      // Check dimension A, B, C, D, L1, L2 if provided
      const dims = ['dimA', 'dimB', 'dimC', 'dimD', 'dimL1', 'dimL2'];
      dims.forEach(d => {
        if (it[d] !== undefined && it[d] !== null && String(it[d]).trim() !== '') {
          const val = String(it[d]).trim();
          if (/[<>{}\\]/.test(val)) {
            errors.push(`Invalid ${d.replace('dim', 'Dimension ')}`);
          }
        }
      });

      if (isDuplicate) {
        errors.push('Existing SKU found — requires Admin review.');
      }

      const validationStatus = errors.length > 0 ? (errors.some(e => !e.includes('Existing SKU found')) ? 'INVALID' : 'WARNING') : 'VALID';
      const validationError = errors.join('; ');

      let price = null;
      if (it.unitPrice !== undefined && it.unitPrice !== null && String(it.unitPrice).trim() !== '') {
        const pNum = Number(it.unitPrice);
        if (!isNaN(pNum) && isFinite(pNum) && pNum >= 0) price = pNum;
      }

      let weight = null;
      if (it.weightKg !== undefined && it.weightKg !== null && String(it.weightKg).trim() !== '') {
        const wNum = Number(it.weightKg);
        if (!isNaN(wNum) && isFinite(wNum) && wNum >= 0) weight = wNum;
      }

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
        it.productName ? String(it.productName).trim() : '',
        it.itemDescription ? String(it.itemDescription).trim() : '',
        it.category || 'Raw Materials',
        it.subCategory ? String(it.subCategory).trim() : '',
        it.material ? String(it.material).trim() : '',
        it.size ? String(it.size).trim() : '',
        it.specification ? String(it.specification).trim() : '',
        it.unit ? String(it.unit).trim() : 'Sheet',
        weight,
        price,
        it.supplyType === 'Cut Size' ? 'Cut Size' : 'Full Size',
        it.brand ? String(it.brand).trim() : '',
        it.supplierName ? String(it.supplierName).trim() : '',
        it.remarks ? String(it.remarks).trim() : '',
        it.dimA || it.a || '',
        it.dimB || it.b || '',
        it.dimC || it.c || '',
        it.dimD || it.d || '',
        it.dimL1 || it.l1 || '',
        it.dimL2 || it.l2 || '',
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

    for (const it of itemsRes.rows) {
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
        it.product_name,
        it.item_description || '',
        it.category || 'Raw Materials',
        it.sub_category || '',
        it.material || '',
        it.size || '',
        it.specification || 'PT Persada Nusantara Steel Standard',
        it.unit || 'Sheet',
        it.weight_kg,
        'Available',
        it.supply_type || 'Full Size',
        it.remarks || '',
        it.brand || '',
        it.unit_price,
        it.source_sheet || submission.file_name
      ]);

      insertedMasterItems.push(insertRes.rows[0]);

      // Record assigned master SKU back to staging item
      await client.query(`
        UPDATE import_submission_items
        SET assigned_master_sku = $1
        WHERE id = $2
      `, [assignedSku, it.id]);
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
      count: insertedMasterItems.length
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
