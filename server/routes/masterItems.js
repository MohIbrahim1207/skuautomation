/**
 * Master Items API Routes (/api/master-items)
 * Single Source of Truth for verified technical specifications & pricing
 */
const express = require('express');
const router = express.Router();
const { query, pool } = require('../db/pool');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { REQUIRE_UNIT_PRICE } = require('../config/pricing');

const VALID_STATUSES = ['Available', 'Out of Stock'];
const VALID_SUPPLY_TYPES = ['Full Size', 'Cut Size'];

function sanitizeStatus(status) {
  if (!status || typeof status !== 'string') return 'Available';
  const trimmed = status.trim();
  const matched = VALID_STATUSES.find(s => s.toLowerCase() === trimmed.toLowerCase());
  return matched || 'Available';
}

function sanitizeSupplyType(supplyType) {
  if (!supplyType || typeof supplyType !== 'string') return 'Full Size';
  const trimmed = supplyType.trim();
  const matched = VALID_SUPPLY_TYPES.find(s => s.toLowerCase() === trimmed.toLowerCase());
  return matched || 'Full Size';
}

function sanitizeRemarks(remarks) {
  if (remarks === undefined || remarks === null) return '';
  return String(remarks).trim();
}

router.use(authenticateToken);

// GET /api/master-items - Browse Master Catalog
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, sku, product_name, item_description, category, sub_category,
              material, size, specification, unit, weight_kg, status, supply_type, remarks, brand, unit_price, source_sheet, created_at
       FROM master_items
       ORDER BY sku ASC`
    );

    const items = result.rows.map(r => ({
      id: r.id,
      sku: r.sku,
      productName: r.product_name,
      itemDescription: r.item_description,
      category: r.category,
      subCategory: r.sub_category,
      material: r.material,
      size: r.size,
      specification: r.specification,
      unit: r.unit,
      weightKg: r.weight_kg ? parseFloat(r.weight_kg) : null,
      status: (r.status === 'Out of Stock') ? 'Out of Stock' : 'Available',
      supplyType: (r.supply_type === 'Cut Size') ? 'Cut Size' : 'Full Size',
      remarks: (r.remarks !== null && r.remarks !== undefined) ? r.remarks : '',
      brand: r.brand,
      unitPrice: r.unit_price ? parseFloat(r.unit_price) : null,
      sourceSheet: r.source_sheet,
      createdAt: r.created_at
    }));

    console.log('[Catalog API - 9. Fetch]', { totalMasterItemsInDb: items.length });
    res.json(items);
  } catch (err) {
    console.error('[Master Items API] List error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// GET /api/master-items/:sku - Single item lookup
router.get('/:sku', async (req, res) => {
  const { sku } = req.params;

  try {
    const result = await query(
      `SELECT * FROM master_items WHERE UPPER(sku) = UPPER($1)`,
      [sku.trim()]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Master SKU '${sku}' not found.` });
    }

    const r = result.rows[0];
    res.json({
      id: r.id,
      sku: r.sku,
      productName: r.product_name,
      itemDescription: r.item_description,
      category: r.category,
      subCategory: r.sub_category,
      material: r.material,
      size: r.size,
      specification: r.specification,
      unit: r.unit,
      weightKg: r.weight_kg ? parseFloat(r.weight_kg) : null,
      status: (r.status === 'Out of Stock') ? 'Out of Stock' : 'Available',
      supplyType: (r.supply_type === 'Cut Size') ? 'Cut Size' : 'Full Size',
      remarks: (r.remarks !== null && r.remarks !== undefined) ? r.remarks : '',
      brand: r.brand,
      unitPrice: r.unit_price ? parseFloat(r.unit_price) : null,
      sourceSheet: r.source_sheet,
      createdAt: r.created_at
    });
  } catch (err) {
    console.error('[Master Items API] Get error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/master-items - Create New SKU (Admin only)
router.post('/', requireAdmin, async (req, res) => {
  const {
    sku, productName, itemDescription, category, subCategory,
    material, size, specification, unit, weightKg, status, supplyType, remarks, brand, unitPrice
  } = req.body;

  if (!sku || !sku.trim()) return res.status(400).json({ error: 'SKU is required.' });
  if (!productName || !productName.trim()) return res.status(400).json({ error: 'Product Name is required.' });
  if (!itemDescription || !itemDescription.trim()) return res.status(400).json({ error: 'Item Description is required.' });

  // Price Requirement: Controlled by REQUIRE_UNIT_PRICE switch
  let priceNum = null;
  if (unitPrice !== undefined && unitPrice !== null && unitPrice !== '') {
    priceNum = Number(unitPrice);
    if (isNaN(priceNum) || !isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'Current Unit Price (IDR) must be a valid positive number.' });
    }
  } else if (REQUIRE_UNIT_PRICE) {
    return res.status(400).json({ error: 'Current Unit Price (IDR) is required.' });
  }

  const cleanSku = sku.trim().toUpperCase();
  const statusVal = sanitizeStatus(status);
  const supplyTypeVal = sanitizeSupplyType(supplyType);
  const remarksVal = sanitizeRemarks(remarks);

  try {
    const checkSku = await query('SELECT 1 FROM master_items WHERE UPPER(sku) = $1', [cleanSku]);
    if (checkSku.rowCount > 0) {
      return res.status(400).json({ error: `SKU '${cleanSku}' already exists.` });
    }

    const weightNum = (weightKg !== '' && weightKg !== null && !isNaN(parseFloat(weightKg))) ? parseFloat(weightKg) : null;

    const insertRes = await query(
      `INSERT INTO master_items (
        sku, product_name, item_description, category, sub_category,
        material, size, specification, unit, weight_kg, status, supply_type, remarks, brand, unit_price, source_sheet
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'Engineering Manual')
      RETURNING *`,
      [
        cleanSku,
        productName.trim(),
        itemDescription.trim(),
        category || 'Raw Materials',
        subCategory || null,
        material || null,
        size || null,
        specification || null,
        unit || 'Sheet',
        weightNum,
        statusVal,
        supplyTypeVal,
        remarksVal,
        brand || 'PT Persada Nusantara Steel',
        priceNum
      ]
    );

    const r = insertRes.rows[0];
    res.status(201).json({
      ...r,
      status: (r.status === 'Out of Stock') ? 'Out of Stock' : 'Available',
      supplyType: (r.supply_type === 'Cut Size') ? 'Cut Size' : 'Full Size'
    });
  } catch (err) {
    console.error('[Master Items API] Create error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// PUT /api/master-items/:sku - Edit Master Item (Admin only)
router.put('/:sku', requireAdmin, async (req, res) => {
  const { sku } = req.params;
  const { itemDescription, unitPrice, productName, material, size, specification, status, supplyType, remarks } = req.body;

  // Price Requirement: Controlled by REQUIRE_UNIT_PRICE switch
  let priceVal = null;
  let updatePrice = false;

  if (unitPrice !== undefined) {
    updatePrice = true;
    if (unitPrice === null || unitPrice === '') {
      if (REQUIRE_UNIT_PRICE) {
        return res.status(400).json({ error: 'Current Unit Price (IDR) is required.' });
      }
      priceVal = null;
    } else {
      const p = Number(unitPrice);
      if (isNaN(p) || !isFinite(p) || p < 0) {
        return res.status(400).json({ error: 'Current Unit Price (IDR) must be a valid positive number.' });
      }
      priceVal = p;
    }
  }

  const updateStatus = status !== undefined;
  const statusVal = updateStatus ? sanitizeStatus(status) : null;
  const updateSupplyType = supplyType !== undefined;
  const supplyTypeVal = updateSupplyType ? sanitizeSupplyType(supplyType) : null;
  const updateRemarks = remarks !== undefined;
  const remarksVal = updateRemarks ? sanitizeRemarks(remarks) : null;

  try {
    const existing = await query('SELECT * FROM master_items WHERE UPPER(sku) = UPPER($1)', [sku.trim()]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: `Master SKU '${sku}' not found.` });
    }

    await query(
      `UPDATE master_items
       SET item_description = COALESCE($1, item_description),
           unit_price = CASE WHEN $8::boolean THEN $2::numeric ELSE unit_price END,
           product_name = COALESCE($3, product_name),
           material = COALESCE($4, material),
           size = COALESCE($5, size),
           specification = COALESCE($6, specification),
           status = CASE WHEN $9::boolean THEN $10 ELSE status END,
           supply_type = CASE WHEN $13::boolean THEN $14 ELSE supply_type END,
           remarks = CASE WHEN $11::boolean THEN $12 ELSE remarks END,
           updated_at = CURRENT_TIMESTAMP
       WHERE UPPER(sku) = UPPER($7)`,
      [
        (itemDescription !== undefined) ? itemDescription.trim() : null,
        priceVal,
        (productName !== undefined) ? productName.trim() : null,
        material || null,
        size || null,
        specification || null,
        sku.trim(),
        updatePrice,
        updateStatus,
        statusVal,
        updateRemarks,
        remarksVal,
        updateSupplyType,
        supplyTypeVal
      ]
    );

    const updated = await query('SELECT * FROM master_items WHERE UPPER(sku) = UPPER($1)', [sku.trim()]);
    const r = updated.rows[0];
    res.json({
      success: true,
      message: 'Master Item updated successfully.',
      item: {
        ...r,
        status: (r.status === 'Out of Stock') ? 'Out of Stock' : 'Available',
        supplyType: (r.supply_type === 'Cut Size') ? 'Cut Size' : 'Full Size',
        remarks: (r.remarks !== null && r.remarks !== undefined) ? r.remarks : ''
      }
    });
  } catch (err) {
    console.error('[Master Items API] Update error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/master-items/batch-import - Concurrency-safe Excel Batch Import
router.post('/batch-import', async (req, res) => {
  // Role verification: Admin or Engineering required
  if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'ENGINEERING')) {
    return res.status(403).json({ error: 'Access Denied — Administrator or Engineering permission required.' });
  }

  const { fileName, sheetName, items } = req.body;

  console.log('[7. Backend Request Body]', { fileName, sheetName, receivedItemsCount: items ? items.length : 0 });

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided for import. Please upload a valid Excel worksheet.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // SKU Concurrency Safety: Transaction-scoped PostgreSQL advisory lock
    // Prevents race conditions during SKU allocation across concurrent imports
    await client.query('SELECT pg_advisory_xact_lock(987654321)');

    // Query maximum existing numeric SKU in FF series (minimum boundary: 4235 so first new is FF4236)
    const maxRes = await client.query(`
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(sku FROM '^FF([0-9]+)$') AS INTEGER)),
        4235
      ) AS max_seq
      FROM master_items
      WHERE sku ~ '^FF[0-9]+$'
    `);

    let currentSeq = Math.max(parseInt(maxRes.rows[0].max_seq, 10), 4235);
    const insertedRows = [];

    console.log('[8. PostgreSQL Transaction Start]', { itemsToInsert: items.length, nextStartingSku: `FF${currentSeq + 1}` });

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      currentSeq++;
      const sku = `FF${currentSeq}`;

      const prodName = (it.productName !== undefined && it.productName !== null && String(it.productName).trim() !== '')
        ? String(it.productName).trim()
        : null;

      const desc = (it.itemDescription !== undefined && it.itemDescription !== null && String(it.itemDescription).trim() !== '')
        ? String(it.itemDescription).trim()
        : null;

      let category = (it.category !== undefined && it.category !== null && String(it.category).trim() !== '')
        ? String(it.category).trim()
        : null;

      const itemSheet = it.sourceSheet || sheetName;

      if (!category) {
        if (itemSheet && itemSheet.toLowerCase().includes('piping')) category = 'Piping & Fittings';
        else if (itemSheet && itemSheet.toLowerCase().includes('fastener')) category = 'Fasteners';
        else category = 'Raw Materials';
      } else if (category.toLowerCase() === 'piping') {
        category = 'Piping & Fittings';
      } else if (category.toLowerCase() === 'fastener' || category.toLowerCase() === 'fasteners') {
        category = 'Fasteners';
      }

      const subCategory = (it.subCategory !== undefined && it.subCategory !== null && String(it.subCategory).trim() !== '')
        ? String(it.subCategory).trim()
        : null;

      const material = (it.material !== undefined && it.material !== null && String(it.material).trim() !== '')
        ? String(it.material).trim()
        : null;

      const size = (it.size !== undefined && it.size !== null && String(it.size).trim() !== '')
        ? String(it.size).trim()
        : null;

      const specification = (it.specification !== undefined && it.specification !== null && String(it.specification).trim() !== '')
        ? String(it.specification).trim()
        : null;

      const unit = (it.unit !== undefined && it.unit !== null && String(it.unit).trim() !== '')
        ? String(it.unit).trim()
        : null;

      const weight = (it.weightKg !== undefined && it.weightKg !== null && it.weightKg !== '' && !isNaN(parseFloat(it.weightKg)))
        ? parseFloat(it.weightKg)
        : null;

      const brand = (it.brand !== undefined && it.brand !== null && String(it.brand).trim() !== '')
        ? String(it.brand).trim()
        : null;

      let price = null;
      if (it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== '') {
        const pNum = Number(it.unitPrice);
        if (!isNaN(pNum) && isFinite(pNum)) {
          price = pNum;
        } else {
          price = it.unitPrice;
        }
      }

      const itemStatus = sanitizeStatus(it.status);
      const itemSupplyType = sanitizeSupplyType(it.supplyType);
      const itemRemarks = sanitizeRemarks(it.remarks);

      const rowNumStr = it.excelRowNum ? ` R${it.excelRowNum}` : '';
      const auditSource = `Excel: ${fileName || 'File'} [${it.sourceSheet || sheetName || 'Sheet'}]${rowNumStr} by ${req.user.username || 'User'} (${req.user.id || 'ID'})`;

      const insertRes = await client.query(`
        INSERT INTO master_items (
          sku, product_name, item_description, category, sub_category,
          material, size, specification, unit, weight_kg, status, supply_type, remarks, brand, unit_price, source_sheet
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *
      `, [
        sku,
        prodName,
        desc,
        category,
        subCategory,
        material,
        size,
        specification,
        unit,
        weight,
        itemStatus,
        itemSupplyType,
        itemRemarks,
        brand,
        price,
        auditSource
      ]);

      insertedRows.push(insertRes.rows[0]);
    }

    await client.query('COMMIT');

    console.log('[8. PostgreSQL Transaction Committed]', {
      totalInsertedInPostgres: insertedRows.length,
      startSku: insertedRows[0].sku,
      endSku: insertedRows[insertedRows.length - 1].sku
    });

    res.status(201).json({
      success: true,
      message: `Successfully imported ${insertedRows.length} Master Items.`,
      count: insertedRows.length,
      startSku: insertedRows[0].sku,
      endSku: insertedRows[insertedRows.length - 1].sku,
      items: insertedRows,
      audit: {
        importedBy: req.user.username,
        userId: req.user.id,
        fileName: fileName || 'Unknown',
        sheetName: sheetName || 'Unknown',
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Master Items Batch Import] Error:', err);
    res.status(500).json({ error: err.message || 'Batch import failed. Transaction rolled back.' });
  } finally {
    client.release();
  }
});

module.exports = router;
