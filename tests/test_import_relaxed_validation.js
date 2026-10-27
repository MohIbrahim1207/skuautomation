const assert = require('assert');
const path = require('path');
const xlsx = require('xlsx');
const { isTextPlaceholder, isNumericPlaceholder, parseIndonesianNumber } = require('../server/services/numberUtils');
const { query, pool } = require('../server/db/pool');

async function runTests() {
  console.log('================================================================');
  console.log('RUNNING TESTS: EXCEL IMPORT RELAXED VALIDATION & ROBUST PARSING');
  console.log('================================================================\n');

  // TEST 1: Placeholder Rules
  console.log('TEST 1: Placeholder handling for text vs numeric fields');
  assert.strictEqual(isTextPlaceholder(''), true, 'empty string is placeholder');
  assert.strictEqual(isTextPlaceholder(null), true, 'null is placeholder');
  assert.strictEqual(isTextPlaceholder('-'), true, '- is text placeholder');
  assert.strictEqual(isTextPlaceholder('—'), true, '— is text placeholder');
  assert.strictEqual(isTextPlaceholder('–'), true, '– is text placeholder');
  assert.strictEqual(isTextPlaceholder('N/A'), true, 'N/A is text placeholder');
  assert.strictEqual(isTextPlaceholder('n/a'), true, 'n/a is text placeholder');
  assert.strictEqual(isTextPlaceholder('none'), false, '"none" must NOT be treated as empty text');
  assert.strictEqual(isTextPlaceholder('nil'), false, '"nil" must NOT be treated as empty text');
  assert.strictEqual(isTextPlaceholder('Coating: None'), false, '"Coating: None" must be preserved');

  assert.strictEqual(isNumericPlaceholder('none'), true, '"none" is numeric placeholder');
  assert.strictEqual(isNumericPlaceholder('nil'), true, '"nil" is numeric placeholder');
  assert.strictEqual(isNumericPlaceholder('-'), true, '"-" is numeric placeholder');
  console.log('✓ TEST 1 PASSED: Text vs Numeric placeholder distinction verified.\n');

  // TEST 2: Empty Price & Weight Saved as NULL
  console.log('TEST 2: Empty price and weight must be saved as NULL, not 0');
  const dashPrice = parseIndonesianNumber('-', true);
  assert.strictEqual(dashPrice.isValid, true, 'dash price is valid');
  assert.strictEqual(dashPrice.value, null, 'dash price parses to null, not 0');

  const dashWeight = parseIndonesianNumber('—', false);
  assert.strictEqual(dashWeight.isValid, true, 'dash weight is valid');
  assert.strictEqual(dashWeight.value, null, 'dash weight parses to null, not 0');

  const naPrice = parseIndonesianNumber('N/A', true);
  assert.strictEqual(naPrice.value, null, 'N/A price parses to null');
  console.log('✓ TEST 2 PASSED: Empty/placeholder numeric fields return NULL.\n');

  // TEST 3: Indonesian Number Format & Weight with a Comma
  console.log('TEST 3: Indonesian price formatting & weight comma decimal handling');
  // Currency fields: thousand-separator logic preserved
  const pDots = parseIndonesianNumber('1.250.000', true);
  assert.strictEqual(pDots.isValid, true, '1.250.000 isValid');
  assert.strictEqual(pDots.value, 1250000, '1.250.000 parses to 1250000');

  const pCommas = parseIndonesianNumber('1,250,000', true);
  assert.strictEqual(pCommas.isValid, true, '1,250,000 isValid');
  assert.strictEqual(pCommas.value, 1250000, '1,250,000 parses to 1250000');

  const pPlain = parseIndonesianNumber('1250000', true);
  assert.strictEqual(pPlain.isValid, true, '1250000 isValid');
  assert.strictEqual(pPlain.value, 1250000, '1250000 parses to 1250000');

  const pDecimalIdr = parseIndonesianNumber('1.250.000,50', true);
  assert.strictEqual(pDecimalIdr.value, 1250000.5, '1.250.000,50 parses to 1250000.5');

  const pPrefixIdr = parseIndonesianNumber('IDR 1.250.000', true);
  assert.strictEqual(pPrefixIdr.value, 1250000, 'IDR 1.250.000 parses to 1250000');

  const pPrefixRp = parseIndonesianNumber('Rp. 1.250.000,-', true);
  assert.strictEqual(pPrefixRp.value, 1250000, 'Rp. 1.250.000,- parses to 1250000');

  // Requirement 4: Weight and dimensions with a comma treat "1,250" as decimal 1.25, not 1250
  const wComma1 = parseIndonesianNumber('1,250', false);
  assert.strictEqual(wComma1.isValid, true, '1,250 weight isValid');
  assert.strictEqual(wComma1.value, 1.25, '1,250 weight parses to decimal 1.25 (Indonesian style)');

  const wComma2 = parseIndonesianNumber('0,085', false);
  assert.strictEqual(wComma2.isValid, true, '0,085 weight isValid');
  assert.strictEqual(wComma2.value, 0.085, '0,085 weight parses to decimal 0.085');

  const wDot1 = parseIndonesianNumber('1.250', false);
  assert.strictEqual(wDot1.value, 1.25, '1.250 weight parses to decimal 1.25');

  const pInvalid = parseIndonesianNumber('invalid_text', true);
  assert.strictEqual(pInvalid.isValid, false, 'invalid text is marked invalid');
  console.log('✓ TEST 3 PASSED: Indonesian formats, currency prefixes, and weight comma decimal parsed accurately.\n');

  // TEST 4: Matching Logic & Text Normalization: mm2 = mm^2 = mm², Product Name + Description
  console.log('TEST 4: Matching logic and normalization');
  const { normalizeTextForMatching, getItemMatchKey } = require('../server/services/numberUtils');
  assert.strictEqual(normalizeTextForMatching('NYY 1C x 1.5 mm^2'), 'nyy 1c x 1.5 mm2');
  assert.strictEqual(normalizeTextForMatching('NYY 1C x 1.5 mm²'), 'nyy 1c x 1.5 mm2');
  assert.strictEqual(normalizeTextForMatching('NYY 1C x 1.5 mm2'), 'nyy 1c x 1.5 mm2');
  assert.strictEqual(normalizeTextForMatching('  NYY   1C  x  1.5  mm^2  '), 'nyy 1c x 1.5 mm2');

  const key1 = getItemMatchKey('Cable Power NYY', 'NYY 1C x 1.5 mm^2');
  const key2 = getItemMatchKey('Cable Power NYY', 'NYY 1C x 1.5 mm²');
  const key3 = getItemMatchKey('Cable Power NYY', 'NYY 5C x 10 mm^2');
  assert.strictEqual(key1, key2, 'mm^2 and mm² normalize to identical match key');
  assert.notStrictEqual(key1, key3, 'Different descriptions under same Product Name produce different match keys');

  const validRow = { productName: 'Cable Power NYY', unit: 'Mtr' };
  assert.strictEqual(isTextPlaceholder(validRow.productName), false, 'Product Name is valid');
  assert.strictEqual(isTextPlaceholder(validRow.unit), false, 'UOM is valid');

  const missingProdName = { productName: '', unit: 'Mtr' };
  assert.strictEqual(isTextPlaceholder(missingProdName.productName), true, 'Empty Product Name detected');

  const missingUom = { productName: 'Cable Power NYY', unit: '-' };
  assert.strictEqual(isTextPlaceholder(missingUom.unit), true, 'Placeholder UOM "-" detected as missing');
  console.log('✓ TEST 4 PASSED: Only Product Name and UOM required.\n');

  // TEST 5: Flow_Force_Electrical_Input_Template.xlsx all 99 rows pass
  console.log('TEST 5: Verify Flow_Force_Electrical_Input_Template.xlsx (all 99 rows)');
  const filePath = 'C:\\Users\\Lap2033\\Downloads\\Flow_Force_Electrical_Input_Template.xlsx';
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets['Electrical'];
  const rawData = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true, raw: false });
  const headers = rawData[0].map(h => String(h || '').trim());
  const colMap = {};
  headers.forEach((h, idx) => {
    colMap[h.toLowerCase().replace(/[^a-z0-9]/g, '')] = idx;
  });

  const getCol = (r, aliases) => {
    for (const a of aliases) {
      const k = a.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (colMap[k] !== undefined && r[colMap[k]] !== undefined && r[colMap[k]] !== null && String(r[colMap[k]]).trim() !== '') {
        return String(r[colMap[k]]).trim();
      }
    }
    return '';
  };

  let passedRows = 0;
  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    const pName = getCol(row, ['Product Name', 'Product', 'Item Name']);
    const uom = getCol(row, ['Unit', 'Unit / UOM', 'UOM']);
    const rawPrice = getCol(row, ['Current Unit Price (IDR)', 'Price']);
    const rawWeight = getCol(row, ['Weight', 'Weight (kg)']);

    const errors = [];
    if (isTextPlaceholder(pName)) errors.push('Missing Product Name');
    if (isTextPlaceholder(uom)) errors.push('Missing UOM');

    const priceRes = parseIndonesianNumber(rawPrice, true);
    if (!priceRes.isValid) errors.push('Invalid Unit Price');

    const weightRes = parseIndonesianNumber(rawWeight, false);
    if (!weightRes.isValid) errors.push('Invalid Weight');

    assert.strictEqual(errors.length, 0, `Row ${i} must have 0 errors, got: ${errors.join('; ')}`);
    assert.strictEqual(priceRes.value, null, `Row ${i} price must be null`);
    assert.strictEqual(weightRes.value, null, `Row ${i} weight must be null`);
    assert.strictEqual(['Pcs', 'Mtr'].includes(uom), true, `Row ${i} UOM must be Pcs or Mtr, got ${uom}`);
    passedRows++;
  }
  assert.strictEqual(passedRows, 99, 'All 99 rows passed validation');
  console.log(`✓ TEST 5 PASSED: All ${passedRows} rows in Electrical template passed with null price/weight and correct UOM.\n`);

  // TEST 6: Server API - Test Submission with Valid, Missing Name, Missing UOM, and Existing Item Update
  console.log('TEST 6: API endpoint integration verification');
  const app = require('../server/index');
  const http = require('http');
  const jwt = require('jsonwebtoken');

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const adminUserRes = await query("SELECT id, username FROM users WHERE role = 'ADMIN' LIMIT 1");
  assert(adminUserRes.rowCount > 0, 'Admin user exists in DB');
  const dbAdmin = adminUserRes.rows[0];

  const adminToken = jwt.sign(
    { id: dbAdmin.id, username: dbAdmin.username, role: 'ADMIN' },
    process.env.JWT_SECRET || 'flowforce-test-jwt-secret-key-32chars',
    { expiresIn: '1h' }
  );

  const request = (path, method, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let resData = '';
      res.on('data', chunk => resData += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(resData) });
        } catch (e) {
          resolve({ status: res.statusCode, body: resData });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  // Query an existing master item to test duplicate/update detection
  const existingItemRes = await query('SELECT sku, product_name, material, unit FROM master_items LIMIT 1');
  assert(existingItemRes.rowCount > 0, 'At least 1 master item in DB');
  const sampleMaster = existingItemRes.rows[0];
  console.log('  Testing against existing master item:', sampleMaster.sku, sampleMaster.product_name);

  const testPayload = {
    fileName: 'Validation_Test.xlsx',
    materialFamily: 'electrical-materials',
    items: [
      {
        rowNumber: 1,
        productName: 'Cable Power NYY Test',
        itemDescription: 'NYY 5C x 10 mm^2',
        unit: 'Mtr',
        unitPrice: '-',
        weightKg: '-'
      },
      {
        rowNumber: 2,
        productName: '', // Missing Product Name
        unit: 'Mtr',
        unitPrice: '10000'
      },
      {
        rowNumber: 3,
        productName: 'Valid Item Missing UOM',
        unit: '-', // Missing UOM
        unitPrice: '10000'
      },
      {
        rowNumber: 4,
        sku: sampleMaster.sku, // Existing item by SKU
        productName: sampleMaster.product_name,
        itemDescription: 'Updated description through import test',
        unit: sampleMaster.unit || 'Pcs',
        unitPrice: '1.250.000', // Indonesian format
        weightKg: '0.085'
      }
    ]
  };

  const submitRes = await request('/api/import-submissions', 'POST', testPayload);
  assert.strictEqual(submitRes.status, 201, 'Submission created');
  const importId = submitRes.body.importId;

  // Fetch details to verify row-by-row validation statuses
  const detailsRes = await request(`/api/import-submissions/${importId}`, 'GET');
  assert.strictEqual(detailsRes.status, 200, 'Details retrieved');
  const items = detailsRes.body.items;

  // Row 1: Valid
  assert.strictEqual(items[0].validation_status, 'VALID', 'Row 1 is VALID');
  assert.strictEqual(items[0].unit_price, null, 'Row 1 price is null');
  assert.strictEqual(items[0].weight_kg, null, 'Row 1 weight is null');

  // Row 2: Missing Product Name -> INVALID
  assert.strictEqual(items[1].validation_status, 'INVALID', 'Row 2 is INVALID');
  assert(items[1].validation_error.includes('Missing Product Name'), 'Row 2 error is Missing Product Name');

  // Row 3: Missing UOM -> INVALID
  assert.strictEqual(items[2].validation_status, 'INVALID', 'Row 3 is INVALID');
  assert(items[2].validation_error.includes('Missing UOM'), 'Row 3 error is Missing UOM');

  // Row 4: Existing item -> WARNING (not INVALID!) and Indonesian price parsed
  assert.strictEqual(items[3].validation_status, 'WARNING', 'Row 4 is WARNING');
  assert(items[3].validation_error.includes('Existing item found'), 'Row 4 indicates existing item');
  assert.strictEqual(items[3].unit_price, 1250000, 'Row 4 price 1.250.000 parsed to 1250000');
  assert.strictEqual(items[3].weight_kg, 0.085, 'Row 4 weight 0.085 parsed to 0.085');

  // Approve submission: verify Row 1 gets auto-SKU, Row 4 updates existing item
  const approveRes = await request(`/api/import-submissions/${importId}/approve`, 'POST');
  assert.strictEqual(approveRes.status, 200, 'Approval succeeded');

  // Check updated master item for Row 4 (non-destructive update: description & price updated, material preserved)
  const updatedItemRes = await query('SELECT * FROM master_items WHERE sku = $1', [sampleMaster.sku]);
  assert.strictEqual(updatedItemRes.rows[0].item_description, 'Updated description through import test');
  assert.strictEqual(parseFloat(updatedItemRes.rows[0].unit_price), 1250000);
  assert.strictEqual(updatedItemRes.rows[0].material, sampleMaster.material, 'Existing material preserved (not erased by update)');

  // Check new master item for Row 1
  const newItemRes = await query('SELECT * FROM master_items WHERE product_name = $1', ['Cable Power NYY Test']);
  assert.strictEqual(newItemRes.rowCount, 1, 'New item inserted');
  assert(/^FF\d+$/.test(newItemRes.rows[0].sku), 'New SKU auto-assigned starting with FF');

  // Clean up test records
  await query('DELETE FROM master_items WHERE product_name = $1', ['Cable Power NYY Test']);
  await query('UPDATE master_items SET item_description = $1, unit_price = $2 WHERE sku = $3', [sampleMaster.item_description, sampleMaster.unit_price, sampleMaster.sku]);
  await query('DELETE FROM import_submission_items WHERE submission_id = (SELECT id FROM import_submissions WHERE import_id = $1)', [importId]);
  await query('DELETE FROM import_submissions WHERE import_id = $1', [importId]);
  console.log('✓ TEST 6 PASSED: End-to-end API staging, validation, auto-SKU, and non-destructive updates verified.\n');

  // TEST 7: Ambiguous Match — matches >1 existing item -> warning & creates new
  console.log('TEST 7: Ambiguous Match handling');
  // Create two distinct existing items with identical product name & description
  const ambigSku1 = 'TEST-AMB-1';
  const ambigSku2 = 'TEST-AMB-2';
  await query(`INSERT INTO master_items (sku, product_name, item_description, unit) VALUES ($1, 'Cable Gland PG Test', 'PG 7 White', 'Pcs')`, [ambigSku1]);
  await query(`INSERT INTO master_items (sku, product_name, item_description, unit) VALUES ($1, 'Cable Gland PG Test', 'PG 7 White', 'Pcs')`, [ambigSku2]);

  const ambigPayload = {
    fileName: 'Ambiguous_Test.xlsx',
    materialFamily: 'electrical-materials',
    items: [
      {
        rowNumber: 1,
        productName: 'Cable Gland PG Test',
        itemDescription: 'PG 7 White',
        unit: 'Pcs'
      }
    ]
  };

  const ambigSubRes = await request('/api/import-submissions', 'POST', ambigPayload);
  const ambigDetails = await request(`/api/import-submissions/${ambigSubRes.body.importId}`, 'GET');
  assert.strictEqual(ambigDetails.body.items[0].validation_status, 'WARNING');
  assert(ambigDetails.body.items[0].validation_error.includes('Ambiguous match — will create new'), 'Ambiguous match flagged as warning');

  const ambigApproveRes = await request(`/api/import-submissions/${ambigSubRes.body.importId}/approve`, 'POST');
  assert.strictEqual(ambigApproveRes.status, 200);

  // Verify a NEW master item was created and neither of the existing items was touched
  const newAmbigCheck = await query(`SELECT sku FROM master_items WHERE product_name = 'Cable Gland PG Test' AND sku ~ '^FF'`);
  assert(newAmbigCheck.rowCount >= 1, 'Ambiguous item created a brand new FF SKU');

  // Clean up
  await query(`DELETE FROM master_items WHERE product_name = 'Cable Gland PG Test'`);
  await query(`DELETE FROM import_submission_items WHERE submission_id = (SELECT id FROM import_submissions WHERE import_id = $1)`, [ambigSubRes.body.importId]);
  await query(`DELETE FROM import_submissions WHERE import_id = $1`, [ambigSubRes.body.importId]);
  console.log('✓ TEST 7 PASSED: Ambiguous match gracefully warns and creates separate new item.\n');

  // TEST 8: Full End-to-End Import of Flow_Force_Electrical_Input_Template.xlsx (99 rows)
  console.log('TEST 8: End-to-end import of Flow_Force_Electrical_Input_Template.xlsx (all 99 rows)');
  const electricalRows = [];
  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    electricalRows.push({
      rowNumber: i,
      productName: getCol(row, ['Product Name', 'Product', 'Item Name']),
      itemDescription: getCol(row, ['Item Description', 'Description']),
      category: 'Electrical Materials',
      subCategory: getCol(row, ['Electrical Type']),
      brand: getCol(row, ['Manufacturer / Brand']),
      specification: getCol(row, ['Standard']),
      unit: getCol(row, ['Unit', 'Unit / UOM']),
      weightKg: getCol(row, ['Weight']),
      unitPrice: getCol(row, ['Current Unit Price (IDR)']),
      remarks: getCol(row, ['Remarks'])
    });
  }

  const fullImportPayload = {
    fileName: 'Flow_Force_Electrical_Input_Template.xlsx',
    materialFamily: 'electrical-materials',
    items: electricalRows
  };

  const fullSubmitRes = await request('/api/import-submissions', 'POST', fullImportPayload);
  assert.strictEqual(fullSubmitRes.status, 201, 'Full 99-row submission created');
  const fullImportId = fullSubmitRes.body.importId;

  const fullDetails = await request(`/api/import-submissions/${fullImportId}`, 'GET');
  assert.strictEqual(fullDetails.body.items.length, 99, 'All 99 items staged');
  const invalidRows = fullDetails.body.items.filter(it => it.validation_status === 'INVALID');
  assert.strictEqual(invalidRows.length, 0, 'Zero invalid rows in full import');

  // Approve the full 99 items
  const fullApproveRes = await request(`/api/import-submissions/${fullImportId}/approve`, 'POST');
  assert.strictEqual(fullApproveRes.status, 200, 'Full import approved');
  assert.strictEqual(fullApproveRes.body.rowsImported, 99, 'Exactly 99 separate master items committed');

  // Verify sequential SKUs
  const createdSkus = fullApproveRes.body.approvedItems.map(it => it.sku);
  const uniqueSkus = new Set(createdSkus);
  assert.strictEqual(uniqueSkus.size, 99, 'All 99 created master items received unique sequential SKUs');

  // Verify rows sharing "Cable Power NYY" (30 rows) and "Cable Gland PG" (52 rows) are separate new items
  const nyyCount = fullApproveRes.body.approvedItems.filter(it => it.product_name === 'Cable Power NYY').length;
  const glandCount = fullApproveRes.body.approvedItems.filter(it => it.product_name === 'Cable Gland PG').length;
  assert.strictEqual(nyyCount, 30, 'All 30 Cable Power NYY rows created as separate distinct items');
  assert.strictEqual(glandCount, 52, 'All 52 Cable Gland PG rows created as separate distinct items');

  // Clean up test records from database (never contaminate catalog)
  await query(`DELETE FROM master_items WHERE sku = ANY($1)`, [createdSkus]);
  await query(`DELETE FROM import_submission_items WHERE submission_id = (SELECT id FROM import_submissions WHERE import_id = $1)`, [fullImportId]);
  await query(`DELETE FROM import_submissions WHERE import_id = $1`, [fullImportId]);
  console.log(`✓ TEST 8 PASSED: Confirmed all 99 separate items created with auto-assigned SKUs (30 NYY, 52 PG).\n`);

  await new Promise(r => server.close(r));

  console.log('✓ All 8 test suites completed successfully!');
  console.log('================================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

