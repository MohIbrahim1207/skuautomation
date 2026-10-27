/**
 * Master Items API Routes (/api/master-items)
 * Single Source of Truth for verified technical specifications & pricing
 */
const express = require('express');
const router = express.Router();
const { query, pool } = require('../db/pool');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { REQUIRE_UNIT_PRICE } = require('../config/pricing');
const { logActivity, extractClientIp } = require('../services/activityLogger');

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

const { serveTemplateDownload } = require('../services/templateService');
const {
  isTextPlaceholder,
  isNumericPlaceholder,
  parseIndonesianNumber,
  normalizeTextForMatching,
  getItemMatchKey
} = require('../services/numberUtils');

// GET /api/master-items/template - Download standard Flow Force New SKU Input template
router.get('/template', serveTemplateDownload);

router.use(authenticateToken);

// GET /api/master-items - Browse Master Catalog (supports optional category and search filtering)
router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;
    let sql = `SELECT id, sku, product_name, item_description, category, sub_category,
              material, size, specification, unit, weight_kg, status, supply_type, remarks, brand, unit_price, source_sheet, created_at
       FROM master_items`;
    const params = [];
    const whereClauses = [];

    if (category) {
      params.push(category.trim());
      whereClauses.push(`LOWER(category) = LOWER($${params.length})`);
    }

    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      whereClauses.push(`(LOWER(sku) LIKE $${params.length} OR LOWER(product_name) LIKE $${params.length} OR LOWER(COALESCE(item_description, '')) LIKE $${params.length})`);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ` + whereClauses.join(' AND ');
    }

    sql += ` ORDER BY sku ASC`;

    const result = await query(sql, params);

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

    await logActivity({
      entityType: 'MASTER_ITEM',
      entityId: cleanSku,
      action: 'SKU_CREATED',
      module: 'MASTER_CATALOG',
      description: `Created new Master SKU ${cleanSku} (${productName.trim()})`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS',
      afterValue: {
        sku: cleanSku,
        productName: productName.trim(),
        itemDescription: itemDescription.trim(),
        category: category || 'Raw Materials',
        subCategory: subCategory || null,
        material: material || null,
        size: size || null,
        specification: specification || null,
        unit: unit || 'Sheet',
        weightKg: weightNum,
        unitPrice: priceNum,
        status: statusVal,
        supplyType: supplyTypeVal,
        remarks: remarksVal,
        brand: brand || 'PT Persada Nusantara Steel'
      },
      metadata: { sku: cleanSku, productName: productName.trim() }
    });

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

// PUT /api/master-items/:sku - Edit Master Item (Admin, or Employee restricted to Status & Remarks only)
router.put('/:sku', async (req, res) => {
  const { sku } = req.params;

  // Field-level authorization: Non-admins may ONLY update Status and Remarks.
  if (req.user && req.user.role !== 'ADMIN') {
    const allowedFields = ['status', 'remarks'];
    const bodyFields = Object.keys(req.body);
    const forbiddenFields = bodyFields.filter(f => !allowedFields.includes(f) && req.body[f] !== undefined);

    if (forbiddenFields.length > 0) {
      return res.status(403).json({
        error: `Access Denied — Employees are only permitted to edit Status and Remarks. Modifying protected field(s) [${forbiddenFields.join(', ')}] requires Administrator privileges.`
      });
    }
  }

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

    const oldItem = existing.rows[0];
    const updated = await query('SELECT * FROM master_items WHERE UPPER(sku) = UPPER($1)', [sku.trim()]);
    const r = updated.rows[0];

    const clientIp = extractClientIp(req);
    const priceChanged = updatePrice && Number(r.unit_price) !== Number(oldItem.unit_price);
    const descChanged = (itemDescription !== undefined) && r.item_description !== oldItem.item_description;

    if (priceChanged) {
      await logActivity({
        entityType: 'MASTER_ITEM',
        entityId: r.sku,
        action: 'PRICE_CHANGED',
        module: 'MASTER_CATALOG',
        description: `Unit price for ${r.sku} changed from IDR ${oldItem.unit_price !== null ? Number(oldItem.unit_price).toLocaleString('id-ID') : 'None'} to IDR ${r.unit_price !== null ? Number(r.unit_price).toLocaleString('id-ID') : 'None'}`,
        userId: req.user.id,
        username: req.user.username,
        role: req.user.role,
        ipAddress: clientIp,
        status: 'SUCCESS',
        beforeValue: { unitPrice: oldItem.unit_price !== null ? Number(oldItem.unit_price) : null },
        afterValue: { unitPrice: r.unit_price !== null ? Number(r.unit_price) : null },
        metadata: { sku: r.sku, oldPrice: oldItem.unit_price, newPrice: r.unit_price }
      });
    }

    if (descChanged) {
      await logActivity({
        entityType: 'MASTER_ITEM',
        entityId: r.sku,
        action: 'DESCRIPTION_CHANGED',
        module: 'MASTER_CATALOG',
        description: `Item description for ${r.sku} updated`,
        userId: req.user.id,
        username: req.user.username,
        role: req.user.role,
        ipAddress: clientIp,
        status: 'SUCCESS',
        beforeValue: { itemDescription: oldItem.item_description },
        afterValue: { itemDescription: r.item_description },
        metadata: { sku: r.sku }
      });
    }

    if (!priceChanged && !descChanged) {
      await logActivity({
        entityType: 'MASTER_ITEM',
        entityId: r.sku,
        action: 'SKU_UPDATED',
        module: 'MASTER_CATALOG',
        description: `Master Item ${r.sku} updated by ${req.user.username}`,
        userId: req.user.id,
        username: req.user.username,
        role: req.user.role,
        ipAddress: clientIp,
        status: 'SUCCESS',
        beforeValue: {
          productName: oldItem.product_name,
          status: oldItem.status,
          supplyType: oldItem.supply_type,
          remarks: oldItem.remarks
        },
        afterValue: {
          productName: r.product_name,
          status: r.status,
          supplyType: r.supply_type,
          remarks: r.remarks
        },
        metadata: { sku: r.sku }
      });
    }

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

    // Track per-sheet statistics
    const sheetMap = {};
    items.forEach(it => {
      const s = it.sourceSheet || sheetName || 'Default';
      if (!sheetMap[s]) {
        sheetMap[s] = { sheetName: s, sheet: s, rowsDetected: 0, rowsImported: 0, rowsSkipped: 0, rowsFailed: 0 };
      }
      sheetMap[s].rowsDetected++;
    });

    console.log('[8. PostgreSQL Transaction Start]', { itemsToInsert: items.length, nextStartingSku: `FF${currentSeq + 1}` });

    // Load existing items into memory for exact SKU and Product Name + Description matching
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

    for (let i = 0; i < items.length; i++) {
      const it = items[i];

      const cleanSku = (it.sku && !isTextPlaceholder(it.sku)) ? String(it.sku).trim() : '';
      const prodName = (it.productName !== undefined && it.productName !== null && !isTextPlaceholder(it.productName))
        ? String(it.productName).trim()
        : null;
      const desc = (it.itemDescription !== undefined && it.itemDescription !== null && !isTextPlaceholder(it.itemDescription))
        ? String(it.itemDescription).trim()
        : null;

      let existingMatch = null;
      if (cleanSku) {
        const matches = existingSkuMap.get(cleanSku.toUpperCase()) || [];
        if (matches.length === 1) {
          existingMatch = matches[0];
        } else if (matches.length > 1) {
          existingMatch = null; // Ambiguous match — create new
        }
      } else if (prodName) {
        const key = getItemMatchKey(prodName, desc);
        const matches = existingNameDescMap.get(key) || [];
        if (matches.length === 1) {
          existingMatch = matches[0];
        } else if (matches.length > 1) {
          existingMatch = null; // Ambiguous match — create new
        }
      }

      let category = (it.category !== undefined && it.category !== null && !isTextPlaceholder(it.category))
        ? String(it.category).trim()
        : null;

      const itemSheet = it.sourceSheet || sheetName;

      if (!category) {
        if (itemSheet && itemSheet.toLowerCase().includes('piping')) category = 'Piping & Fittings';
        else if (itemSheet && itemSheet.toLowerCase().includes('fastener')) category = 'Fasteners';
        else if (itemSheet && itemSheet.toLowerCase().includes('electrical')) category = 'Electrical Materials';
        else if (itemSheet && itemSheet.toLowerCase().includes('bought')) category = 'Bought Out Items';
        else category = 'Raw Materials';
      } else if (category.toLowerCase() === 'piping') {
        category = 'Piping & Fittings';
      } else if (category.toLowerCase() === 'fastener' || category.toLowerCase() === 'fasteners') {
        category = 'Fasteners';
      } else if (category.toLowerCase() === 'electrical' || category.toLowerCase() === 'electrical materials') {
        category = 'Electrical Materials';
      }

      const subCategory = (it.subCategory !== undefined && it.subCategory !== null && !isTextPlaceholder(it.subCategory))
        ? String(it.subCategory).trim()
        : null;

      const material = (it.material !== undefined && it.material !== null && !isTextPlaceholder(it.material))
        ? String(it.material).trim()
        : null;

      const size = (it.size !== undefined && it.size !== null && !isTextPlaceholder(it.size))
        ? String(it.size).trim()
        : null;

      const specification = (it.specification !== undefined && it.specification !== null && !isTextPlaceholder(it.specification))
        ? String(it.specification).trim()
        : null;

      const unit = (it.unit !== undefined && it.unit !== null && !isTextPlaceholder(it.unit))
        ? String(it.unit).trim()
        : null;

      const parsedWeight = parseIndonesianNumber(it.weightKg, false);
      const weight = parsedWeight.value;

      const brand = (it.brand !== undefined && it.brand !== null && !isTextPlaceholder(it.brand))
        ? String(it.brand).trim()
        : null;

      const parsedPrice = parseIndonesianNumber(it.unitPrice, true);
      const price = parsedPrice.value;

      const itemStatus = sanitizeStatus(it.status);
      const itemSupplyType = sanitizeSupplyType(it.supplyType);
      const itemRemarks = sanitizeRemarks(it.remarks);

      const rowNumStr = it.excelRowNum ? ` R${it.excelRowNum}` : '';
      const auditSource = `Excel: ${fileName || 'File'} [${it.sourceSheet || sheetName || 'Sheet'}]${rowNumStr} by ${req.user.username || 'User'} (${req.user.id || 'ID'})`;

      if (existingMatch) {
        // Updates must never erase data: skip any blank or placeholder field, keep existing DB value
        const isReal = (v) => v !== undefined && v !== null && !isTextPlaceholder(v) && String(v).trim() !== '';

        const updatedDesc = isReal(desc) ? desc : existingMatch.item_description;
        const updatedCategory = isReal(it.category) ? category : existingMatch.category;
        const updatedSubCat = isReal(subCategory) ? subCategory : existingMatch.sub_category;
        const updatedMaterial = isReal(material) ? material : existingMatch.material;
        const updatedSize = isReal(size) ? size : existingMatch.size;
        const updatedSpec = isReal(specification) ? specification : existingMatch.specification;
        const updatedUnit = isReal(unit) ? unit : existingMatch.unit;
        const updatedWeight = (weight !== null && weight !== undefined) ? weight : existingMatch.weight_kg;
        const updatedSupplyType = isReal(it.supplyType) ? itemSupplyType : existingMatch.supply_type;
        const updatedRemarks = isReal(it.remarks) ? itemRemarks : existingMatch.remarks;
        const updatedBrand = isReal(brand) ? brand : existingMatch.brand;
        const updatedPrice = (price !== null && price !== undefined) ? price : existingMatch.unit_price;
        const updatedSourceSheet = isReal(itemSheet) ? itemSheet : existingMatch.source_sheet;

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

        insertedRows.push(updateRes.rows[0]);
      } else {
        currentSeq++;
        const sku = `FF${currentSeq}`;

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
          unit || 'Pcs',
          weight,
          itemStatus,
          itemSupplyType,
          itemRemarks,
          brand,
          price,
          auditSource
        ]);

        const insertedItem = insertRes.rows[0];
        insertedRows.push(insertedItem);

        // Update in-memory map
        const newKey = getItemMatchKey(insertedItem.product_name, insertedItem.item_description);
        if (!existingNameDescMap.has(newKey)) existingNameDescMap.set(newKey, []);
        existingNameDescMap.get(newKey).push(insertedItem);
        if (!existingSkuMap.has(sku)) existingSkuMap.set(sku, []);
        existingSkuMap.get(sku).push(insertedItem);
      }

      const s = it.sourceSheet || sheetName || 'Default';
      if (sheetMap[s]) sheetMap[s].rowsImported++;
    }

    await client.query('COMMIT');

    console.log('[8. PostgreSQL Transaction Committed]', {
      totalInsertedInPostgres: insertedRows.length,
      startSku: insertedRows[0].sku,
      endSku: insertedRows[insertedRows.length - 1].sku
    });

    await logActivity({
      entityType: 'MASTER_ITEM',
      action: 'SKU_BATCH_IMPORTED',
      module: 'MASTER_CATALOG',
      description: `Imported ${insertedRows.length} SKUs (${insertedRows[0]?.sku} - ${insertedRows[insertedRows.length - 1]?.sku}) from file: ${fileName || 'Excel'}`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS',
      metadata: {
        count: insertedRows.length,
        fileName,
        startSku: insertedRows[0]?.sku,
        endSku: insertedRows[insertedRows.length - 1]?.sku
      }
    });

    res.status(201).json({
      success: true,
      message: `Successfully imported ${insertedRows.length} Master Items.`,
      count: insertedRows.length,
      rowsDetected: items.length,
      rowsImported: insertedRows.length,
      rowsSkipped: 0,
      rowsFailed: 0,
      sheetBreakdown: Object.values(sheetMap),
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
    res.status(500).json({
      success: false,
      error: err.message || 'Batch import failed. Transaction rolled back.',
      rowsDetected: items ? items.length : 0,
      rowsImported: 0,
      rowsSkipped: 0,
      rowsFailed: items ? items.length : 0
    });
  } finally {
    client.release();
  }
});

// DELETE /api/master-items/:sku - Delete Master Item (Admin only)
router.delete('/:sku', requireAdmin, async (req, res) => {
  const { sku } = req.params;

  try {
    const existing = await query('SELECT * FROM master_items WHERE UPPER(sku) = UPPER($1)', [sku.trim()]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: `Master SKU '${sku}' not found.` });
    }

    // Protect authoritative Raw Materials FF4186–FF4235
    const skuMatch = sku.trim().toUpperCase().match(/^FF(\d+)$/);
    if (skuMatch) {
      const num = parseInt(skuMatch[1], 10);
      if (num >= 4186 && num <= 4235) {
        return res.status(403).json({ error: 'Cannot delete authoritative Raw Materials FF4186–FF4235.' });
      }
    }

    const itemToDelete = existing.rows[0];
    await query('DELETE FROM master_items WHERE UPPER(sku) = UPPER($1)', [sku.trim()]);

    await logActivity({
      entityType: 'MASTER_ITEM',
      entityId: itemToDelete.sku,
      action: 'SKU_DELETED',
      module: 'MASTER_CATALOG',
      description: `Administrator ${req.user.username} deleted Master Item ${itemToDelete.sku} (${itemToDelete.product_name})`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS',
      beforeValue: {
        sku: itemToDelete.sku,
        productName: itemToDelete.product_name,
        category: itemToDelete.category,
        unitPrice: itemToDelete.unit_price
      }
    });

    res.json({ success: true, message: `Master Item '${sku}' deleted successfully.` });
  } catch (err) {
    console.error('[Master Items API] Delete error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

module.exports = router;
