/**
 * =========================================================================
 * COMPREHENSIVE TEST SUITE: FAMILY-SPECIFIC EXCEL TEMPLATES & IMPORT FLOW
 * 
 * Verifies:
 * 1. Download integrity for all 8 material families
 * 2. Real ZIP PK magic bytes, OpenXML MIME types, attachment filenames
 * 3. Instructions metadata and family data sheets
 * 4. Guard against SPA fallback (no HTML disguised as XLSX)
 * 5. Full Employee -> Fill Excel -> Upload -> Staging -> Admin Approve workflow
 *    for Fasteners and Piping Materials
 * =========================================================================
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const XLSX = require('xlsx');

const app = require('../server/index');
const { query, pool } = require('../server/db/pool');
const { FAMILY_REGISTRY, getFamilySlugs, TEMPLATE_VERSION } = require('../server/services/templateService');

function request(serverPort, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(`http://127.0.0.1:${serverPort}${urlPath}`);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: { ...headers }
    };

    let postData = null;
    if (body) {
      if (typeof body === 'object' && !Buffer.isBuffer(body)) {
        postData = JSON.stringify(body);
        reqOptions.headers['Content-Type'] = 'application/json';
        reqOptions.headers['Content-Length'] = Buffer.byteLength(postData);
      } else {
        postData = body;
        reqOptions.headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
      }
    }

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(rawBuffer.toString('utf8'));
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: rawBuffer,
          json
        });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('================================================================');
  console.log('FLOW FORCE: FAMILY-SPECIFIC EXCEL TEMPLATES INTEGRITY TEST');
  console.log('================================================================\n');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Server listening on port ${port}\n`);

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Login Admin and Employee to obtain JWT tokens
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Authentication ---');
    const adminLogin = await request(port, 'POST', '/api/auth/login', {}, { username: 'admin', password: 'admin123' });
    assert.strictEqual(adminLogin.statusCode, 200, 'Admin login failed');
    const adminToken = adminLogin.json.token;
    console.log('  ✓ Admin logged in successfully');

    const empLogin = await request(port, 'POST', '/api/auth/login', {}, { username: 'employee', password: 'employee123' });
    assert.strictEqual(empLogin.statusCode, 200, 'Employee login failed');
    const empToken = empLogin.json.token;
    console.log('  ✓ Employee logged in successfully');

    // -------------------------------------------------------------------------
    // TEST 2: GET /api/import-submissions/template-families
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Template Families Listing ---');
    const familiesRes = await request(port, 'GET', '/api/import-submissions/template-families');
    assert.strictEqual(familiesRes.statusCode, 200, 'template-families endpoint failed');
    assert(familiesRes.json && Array.isArray(familiesRes.json.families), 'Missing families array');
    assert.strictEqual(familiesRes.json.families.length, 8, `Expected 8 families, got ${familiesRes.json.families.length}`);
    console.log(`  ✓ Available Families (${familiesRes.json.families.length}):`);
    familiesRes.json.families.forEach(f => {
      console.log(`    • ${f.slug}: "${f.name}" -> ${f.filename} (${f.columnCount} cols)`);
    });

    // -------------------------------------------------------------------------
    // TEST 3: Verify all 8 Family Templates (Download, MIME, ZIP, Headers, Sheets)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Download & Binary Validation for All 8 Families ---');
    const slugs = getFamilySlugs();

    const testDir = path.join(__dirname, '../scratch/test_templates_out');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    for (const slug of slugs) {
      const family = FAMILY_REGISTRY[slug];
      console.log(`\n  Testing Family: [${slug}] - ${family.name}`);

      // Public download (NO auth header)
      const res = await request(port, 'GET', `/api/import-submissions/template?family=${slug}`);
      assert.strictEqual(res.statusCode, 200, `Download failed for ${slug}: ${res.statusCode}`);

      // Content-Type
      const ct = res.headers['content-type'];
      assert.strictEqual(ct, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `Invalid MIME: ${ct}`);

      // Content-Disposition
      const cd = res.headers['content-disposition'];
      assert(cd && cd.includes('attachment'), `Missing attachment in ${cd}`);
      assert(cd.includes(family.filename), `Filename mismatch: expected ${family.filename}, got ${cd}`);

      // Cache-Control
      assert(res.headers['cache-control'] && res.headers['cache-control'].includes('no-cache'), 'Missing no-cache');

      // Magic Bytes PK\x03\x04
      const buf = res.body;
      assert(buf.length > 5000, `Buffer too small: ${buf.length} bytes`);
      assert.strictEqual(buf[0], 0x50, 'Byte 0 must be P');
      assert.strictEqual(buf[1], 0x4b, 'Byte 1 must be K');
      assert.strictEqual(buf[2], 0x03, 'Byte 2 must be 0x03');
      assert.strictEqual(buf[3], 0x04, 'Byte 3 must be 0x04');

      // No HTML
      const headText = buf.slice(0, 100).toString('utf8');
      assert(!headText.includes('<!DOCTYPE') && !headText.includes('<html'), `Contains HTML!`);

      // Parse with SheetJS
      const wb = XLSX.read(buf, { type: 'buffer' });
      assert(wb && wb.SheetNames, 'Failed to parse workbook');
      assert(wb.SheetNames.includes('Instructions'), 'Missing Instructions sheet');
      const expectedSheetName = family.sheetName || family.name;
      assert(wb.SheetNames.includes(expectedSheetName), `Missing data sheet "${expectedSheetName}"`);

      // Validate Instructions metadata
      const instrWs = wb.Sheets['Instructions'];
      const instrRows = XLSX.utils.sheet_to_json(instrWs, { header: 1, defval: '' });
      const instrText = instrRows.map(r => r[0]).join('\n');
      assert(instrText.includes(`family_slug=${slug}`), `Instructions missing family_slug=${slug}`);
      assert(instrText.includes(`Template Version: ${TEMPLATE_VERSION}`), 'Missing template version');

      // Validate Data Sheet Headers
      const dataWs = wb.Sheets[expectedSheetName];
      const dataRows = XLSX.utils.sheet_to_json(dataWs, { header: 1, defval: '' });
      assert(dataRows.length >= 2, `Data sheet should have headers + sample row (got ${dataRows.length} rows)`);
      const headers = dataRows[0];
      assert.strictEqual(headers.length, family.headers.length, `Header count mismatch for ${slug}`);
      for (let i = 0; i < family.headers.length; i++) {
        assert.strictEqual(headers[i], family.headers[i], `Col ${i} mismatch: ${headers[i]} vs ${family.headers[i]}`);
      }

      // Save to disk and verify reopening
      const localFile = path.join(testDir, family.filename);
      fs.writeFileSync(localFile, buf);
      const reReadBuf = fs.readFileSync(localFile);
      const reWb = XLSX.read(reReadBuf, { type: 'buffer' });
      assert.strictEqual(reWb.SheetNames.length, 2, 'Re-read workbook sheet count mismatch');

      console.log(`    ✓ Status: 200 OK | Size: ${buf.length} bytes | Magic: PK (ZIP) | Sheets: [${wb.SheetNames.join(', ')}] | Saved: ${family.filename}`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Security & Fallback Guard Tests
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Security & Fallback Guards ---');
    // Unknown family slug returns 400 JSON
    const unknownFam = await request(port, 'GET', '/api/import-submissions/template?family=invalid-slug-12345');
    assert.strictEqual(unknownFam.statusCode, 400, 'Unknown family should return 400');
    assert(unknownFam.json && unknownFam.json.error, 'Should return JSON error');
    console.log('  ✓ PASS: Unknown family returns 400 Bad Request with JSON details');

    // Missing API route returns 404 JSON, NEVER index.html!
    const missingApi = await request(port, 'GET', '/api/non-existent-template.xlsx');
    assert.strictEqual(missingApi.statusCode, 404, 'Missing API endpoint should return 404');
    assert(missingApi.headers['content-type'].includes('application/json'), 'Missing API endpoint must return JSON, not HTML');
    const missingText = missingApi.body.toString('utf8');
    assert(!missingText.includes('<!DOCTYPE html>'), 'Missing API endpoint returned index.html!');
    console.log('  ✓ PASS: Non-existent API route returns 404 JSON, never index.html');

    // Missing root file route with binary extension returns 404 JSON, NEVER index.html!
    const missingRootFile = await request(port, 'GET', '/non-existent-file.xlsx');
    assert.strictEqual(missingRootFile.statusCode, 404, 'Missing root binary file should return 404');
    assert(missingRootFile.headers['content-type'].includes('application/json'), 'Missing root file must return JSON');
    assert(!missingRootFile.body.toString('utf8').includes('<!DOCTYPE html>'), 'Must not return index.html');
    console.log('  ✓ PASS: Missing binary file (.xlsx) at root returns 404 JSON, never index.html');

    // -------------------------------------------------------------------------
    // TEST 5: COMPLETE WORKFLOW - FASTENERS TEMPLATE
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Complete Workflow - Fasteners Template ---');
    // 1. Download Fasteners template
    const fastRes = await request(port, 'GET', '/api/import-submissions/template?family=fasteners');
    assert.strictEqual(fastRes.statusCode, 200);
    const fastWb = XLSX.read(fastRes.body, { type: 'buffer' });

    // 2. Add realistic Fastener rows to the Fasteners sheet
    const fastWs = fastWb.Sheets['Fasteners'];
    const fastRows = XLSX.utils.sheet_to_json(fastWs, { header: 1, defval: '' });
    const fastHeader = fastRows[0];

    // Create 2 test fastener items
    const newFastenerRow1 = [
      '', // Blank SKU -> to be assigned
      'Heavy Hex Bolt M24 x 100mm A325',
      'Structural High Strength Heavy Hex Bolt\nSize: M24 x 100mm\nStandard: ASTM A325 Type 1\nFinish: Hot Dip Galvanized',
      'Heavy Hex Bolts',
      'ASTM A325',
      'M24 x 100mm',
      'ASTM A325 / ASME B18.2.6',
      'Nos',
      0.54,
      'Unbrako',
      'PT Baut Pratama',
      45000,
      'Full Size',
      'Mill test certificate required'
    ];

    const newFastenerRow2 = [
      '', // Blank SKU
      'Heavy Hex Nut M24 A563 Gr.DH',
      'Structural Heavy Hex Nut\nSize: M24\nGrade: A563 DH\nFinish: Hot Dip Galvanized',
      'Heavy Hex Nuts',
      'ASTM A563 Grade DH',
      'M24',
      'ASTM A563 / ASME B18.2.2',
      'Nos',
      0.16,
      'Unbrako',
      'PT Baut Pratama',
      18500,
      'Full Size',
      'Compatible with A325 bolts'
    ];

    // Rebuild data sheet with headers + new rows
    const fastNewSheetData = [fastHeader, newFastenerRow1, newFastenerRow2];
    fastWb.Sheets['Fasteners'] = XLSX.utils.aoa_to_sheet(fastNewSheetData);

    const fastFilledBuf = XLSX.write(fastWb, { bookType: 'xlsx', type: 'buffer' });
    const fastSavedPath = path.join(testDir, 'Flow_Force_Fasteners_Filled_Test.xlsx');
    fs.writeFileSync(fastSavedPath, fastFilledBuf);
    console.log(`  ✓ Fasteners workbook modified and saved to ${fastSavedPath} (${fastFilledBuf.length} bytes)`);

    // 3. Employee uploads/submits Fasteners import
    const fastItemsToSubmit = [
      {
        rowNumber: 2,
        sourceSheet: 'Fasteners',
        sku: '',
        productName: 'Heavy Hex Bolt M24 x 100mm A325',
        itemDescription: 'Structural High Strength Heavy Hex Bolt\nSize: M24 x 100mm\nStandard: ASTM A325',
        subCategory: 'Heavy Hex Bolts',
        material: 'ASTM A325',
        size: 'M24 x 100mm',
        specification: 'ASTM A325 / ASME B18.2.6',
        unit: 'Nos',
        weightKg: 0.54,
        unitPrice: 45000,
        brand: 'Unbrako',
        supplierName: 'PT Baut Pratama',
        supplyType: 'Full Size',
        remarks: 'Mill test certificate required'
      },
      {
        rowNumber: 3,
        sourceSheet: 'Fasteners',
        sku: '',
        productName: 'Heavy Hex Nut M24 A563 Gr.DH',
        itemDescription: 'Structural Heavy Hex Nut\nSize: M24\nGrade: A563 DH',
        subCategory: 'Heavy Hex Nuts',
        material: 'ASTM A563 Grade DH',
        size: 'M24',
        specification: 'ASTM A563 / ASME B18.2.2',
        unit: 'Nos',
        weightKg: 0.16,
        unitPrice: 18500,
        brand: 'Unbrako',
        supplierName: 'PT Baut Pratama',
        supplyType: 'Full Size',
        remarks: 'Compatible with A325 bolts'
      }
    ];

    const fastSubmitRes = await request(port, 'POST', '/api/import-submissions', {
      Authorization: `Bearer ${empToken}`
    }, {
      fileName: 'Flow_Force_Fasteners_Template.xlsx',
      materialFamily: 'fasteners',
      templateVersion: '1.0',
      items: fastItemsToSubmit
    });

    assert.strictEqual(fastSubmitRes.statusCode, 201, `Fasteners submission failed: ${fastSubmitRes.statusCode}`);
    const fastImportId = fastSubmitRes.json.importId;
    console.log(`  ✓ Employee submission created: ${fastImportId} (Status: PENDING_REVIEW, Family: Fasteners)`);

    // 4. Verify in Import Review (Admin GET /api/import-submissions/:id)
    const fastReviewRes = await request(port, 'GET', `/api/import-submissions/${fastImportId}`, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.strictEqual(fastReviewRes.statusCode, 200);
    assert.strictEqual(fastReviewRes.json.submission.material_family, 'Fasteners');
    assert.strictEqual(fastReviewRes.json.items.length, 2);
    assert.strictEqual(fastReviewRes.json.items[0].category, 'Fasteners', 'Item category must be locked to Fasteners');
    assert.strictEqual(fastReviewRes.json.items[1].category, 'Fasteners', 'Item category must be locked to Fasteners');
    console.log(`  ✓ Verified in Admin Import Review: Category locked to "Fasteners", 2 items staged`);

    // 5. Admin Approves Fasteners submission
    const fastApproveRes = await request(port, 'POST', `/api/import-submissions/${fastImportId}/approve`, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.strictEqual(fastApproveRes.statusCode, 200, 'Admin approval failed');
    const fastApprovedItems = fastApproveRes.json.approvedItems;
    assert.strictEqual(fastApprovedItems.length, 2);
    console.log(`  ✓ Admin approved submission ${fastImportId}. Assigned SKUs: ${fastApprovedItems.map(i => i.sku).join(', ')}`);

    // Verify in master_items table
    const checkMasterFast = await query('SELECT sku, product_name, category FROM master_items WHERE sku = $1', [fastApprovedItems[0].sku]);
    assert.strictEqual(checkMasterFast.rowCount, 1);
    assert.strictEqual(checkMasterFast.rows[0].category, 'Fasteners');
    console.log(`  ✓ Master Item verified: [${checkMasterFast.rows[0].sku}] "${checkMasterFast.rows[0].product_name}" (Category: ${checkMasterFast.rows[0].category})`);

    // -------------------------------------------------------------------------
    // TEST 6: COMPLETE WORKFLOW - PIPING MATERIALS TEMPLATE
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: Complete Workflow - Piping Materials Template ---');
    // 1. Download Piping Materials template
    const pipeRes = await request(port, 'GET', '/api/import-submissions/template?family=piping-materials');
    assert.strictEqual(pipeRes.statusCode, 200);
    const pipeWb = XLSX.read(pipeRes.body, { type: 'buffer' });
    assert(pipeWb.SheetNames.includes('Piping Materials'));

    // 2. Add realistic Piping rows to Piping Materials sheet
    const pipeWs = pipeWb.Sheets['Piping Materials'];
    const pipeRows = XLSX.utils.sheet_to_json(pipeWs, { header: 1, defval: '' });
    const pipeHeader = pipeRows[0];

    const newPipeRow1 = [
      '', // Blank SKU
      'Seamless Pipe 8" SCH 40 ASTM A106 Gr.B',
      'High Temperature Carbon Steel Seamless Pipe\nNominal Size: 8" (219.1mm OD)\nWT: 8.18mm\nStandard: ASME B36.10',
      'Seamless Pipes',
      'ASTM A106 Grade B',
      '8" SCH 40',
      'ASME B36.10 / ASTM A106',
      'Length',
      126.5,
      'Sumitomo Metals',
      'PT Pipa Nusantara',
      14500000,
      'Full Size',
      'Hydro tested with 3.1 MTR'
    ];

    const pipeNewSheetData = [pipeHeader, newPipeRow1];
    pipeWb.Sheets['Piping Materials'] = XLSX.utils.aoa_to_sheet(pipeNewSheetData);

    const pipeFilledBuf = XLSX.write(pipeWb, { bookType: 'xlsx', type: 'buffer' });
    const pipeSavedPath = path.join(testDir, 'Flow_Force_Piping_Materials_Filled_Test.xlsx');
    fs.writeFileSync(pipeSavedPath, pipeFilledBuf);
    console.log(`  ✓ Piping Materials workbook modified and saved to ${pipeSavedPath} (${pipeFilledBuf.length} bytes)`);

    // 3. Employee submits Piping Materials import
    const pipeSubmitRes = await request(port, 'POST', '/api/import-submissions', {
      Authorization: `Bearer ${empToken}`
    }, {
      fileName: 'Flow_Force_Piping_Materials_Template.xlsx',
      materialFamily: 'piping-materials',
      templateVersion: '1.0',
      items: [
        {
          rowNumber: 2,
          sourceSheet: 'Piping Materials',
          sku: '',
          productName: 'Seamless Pipe 8" SCH 40 ASTM A106 Gr.B',
          itemDescription: 'High Temperature Carbon Steel Seamless Pipe\nSize: 8" SCH 40',
          subCategory: 'Seamless Pipes',
          material: 'ASTM A106 Grade B',
          size: '8" SCH 40',
          specification: 'ASME B36.10 / ASTM A106',
          unit: 'Length',
          weightKg: 126.5,
          unitPrice: 14500000,
          brand: 'Sumitomo Metals',
          supplierName: 'PT Pipa Nusantara',
          supplyType: 'Full Size',
          remarks: 'Hydro tested with 3.1 MTR'
        }
      ]
    });

    assert.strictEqual(pipeSubmitRes.statusCode, 201);
    const pipeImportId = pipeSubmitRes.json.importId;
    console.log(`  ✓ Employee submission created: ${pipeImportId} (Status: PENDING_REVIEW, Family: Piping Materials)`);

    // 4. Verify in Import Review
    const pipeReviewRes = await request(port, 'GET', `/api/import-submissions/${pipeImportId}`, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.strictEqual(pipeReviewRes.statusCode, 200);
    assert.strictEqual(pipeReviewRes.json.submission.material_family, 'Piping Materials');
    assert.strictEqual(pipeReviewRes.json.items[0].category, 'Piping Materials');
    console.log(`  ✓ Verified in Admin Import Review: Category locked to "Piping Materials"`);

    // 5. Admin Approves Piping submission
    const pipeApproveRes = await request(port, 'POST', `/api/import-submissions/${pipeImportId}/approve`, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.strictEqual(pipeApproveRes.statusCode, 200);
    const pipeApprovedItems = pipeApproveRes.json.approvedItems;
    console.log(`  ✓ Admin approved submission ${pipeImportId}. Assigned SKU: ${pipeApprovedItems[0].sku}`);

    // Verify in master_items
    const checkMasterPipe = await query('SELECT sku, product_name, category FROM master_items WHERE sku = $1', [pipeApprovedItems[0].sku]);
    assert.strictEqual(checkMasterPipe.rowCount, 1);
    assert.strictEqual(checkMasterPipe.rows[0].category, 'Piping Materials');
    console.log(`  ✓ Master Item verified: [${checkMasterPipe.rows[0].sku}] "${checkMasterPipe.rows[0].product_name}" (Category: ${checkMasterPipe.rows[0].category})`);

    console.log('\n================================================================');
    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! ALL 8 TEMPLATES & WORKFLOWS VERIFIED');
    console.log('================================================================\n');

  } finally {
    server.close();
  }
}

run().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
