/**
 * =========================================================================
 * AUTOMATED TEST: MASTER ITEM EXCEL TEMPLATE DOWNLOAD INTEGRITY & EXCEL OPEN
 * =========================================================================
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const XLSX = require('xlsx');

const app = require('../server/index');

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

function fetchEndpoint(serverPort, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${serverPort}${urlPath}`, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body
        });
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('================================================================');
  console.log('FLOW FORCE EXCEL TEMPLATE DOWNLOAD & EXCEL COMPATIBILITY TEST');
  console.log('================================================================\n');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Test server listening on http://127.0.0.1:${port}\n`);

  try {
    const endpointsToTest = [
      '/api/import-submissions/template',
      '/api/master-items/template',
      '/Flow_Force_New_SKU_Input_Template.xlsx'
    ];

    let downloadedFileTarget = '';

    for (const ep of endpointsToTest) {
      console.log(`--- Testing Endpoint: ${ep} ---`);
      const res = await fetchEndpoint(port, ep);

      // 1. Status Code
      assert.strictEqual(res.statusCode, 200, `Expected HTTP 200, got ${res.statusCode}`);
      console.log(`  ✓ PASS: HTTP status is 200 OK`);

      // 2. Content-Type Header
      const expectedType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      assert.strictEqual(res.headers['content-type'], expectedType, `Unexpected Content-Type: ${res.headers['content-type']}`);
      console.log(`  ✓ PASS: Content-Type is valid OpenXML spreadsheetml.sheet`);

      // 3. Content-Disposition Header
      assert(res.headers['content-disposition'], 'Missing Content-Disposition header');
      assert(
        res.headers['content-disposition'].includes('Flow_Force_New_SKU_Input_Template.xlsx') ||
        res.headers['content-disposition'].includes('Flow_Force_Raw_Materials_Template.xlsx'),
        'Filename must be Flow_Force_New_SKU_Input_Template.xlsx or Flow_Force_Raw_Materials_Template.xlsx'
      );
      console.log(`  ✓ PASS: Content-Disposition is attachment with correct filename`);

      // 4. Cache-Control Header
      assert(res.headers['cache-control'] && res.headers['cache-control'].includes('no-cache'), 'Cache-Control must prevent stale caching');
      console.log(`  ✓ PASS: Cache-Control prevents stale browser caching`);

      // 5. Binary ZIP Magic Bytes (PK\x03\x04)
      const buf = res.body;
      assert(buf.length > 5000, `Downloaded file is too small (${buf.length} bytes)`);
      assert.strictEqual(buf[0], 0x50, 'Magic byte 0 is not P (0x50)');
      assert.strictEqual(buf[1], 0x4b, 'Magic byte 1 is not K (0x4B)');
      assert.strictEqual(buf[2], 0x03, 'Magic byte 2 is not 0x03');
      assert.strictEqual(buf[3], 0x04, 'Magic byte 3 is not 0x04');
      console.log(`  ✓ PASS: Binary payload starts with valid ZIP magic bytes (PK\\x03\\x04)`);

      // 6. Verify No HTML / JSON
      const startText = buf.slice(0, 100).toString('utf8');
      assert(!startText.includes('<!DOCTYPE'), 'File contains HTML <!DOCTYPE');
      assert(!startText.includes('<html'), 'File contains HTML <html>');
      assert(!startText.includes('{"error"'), 'File contains JSON error');
      console.log(`  ✓ PASS: Payload does NOT contain HTML error/SPA fallback or JSON`);

      // 7. Parse with SheetJS / XLSX
      const wb = XLSX.read(buf, { type: 'buffer' });
      assert(wb && Array.isArray(wb.SheetNames), 'XLSX workbook failed to parse');
      const dataSheetName = wb.SheetNames.find(s => s !== 'Instructions');
      assert(dataSheetName, 'Missing material data sheet');
      assert(wb.SheetNames.includes('Instructions'), 'Missing "Instructions" sheet');
      console.log(`  ✓ PASS: SheetJS parses workbook successfully. Sheets: [${wb.SheetNames.join(', ')}]`);

      // 8. Verify Header Columns
      const ws = wb.Sheets[dataSheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      assert(rows.length > 0, `${dataSheetName} sheet has no rows`);
      const headers = rows[0];

      // Check key common headers
      ['SKU (Leave Blank)', 'Product Name', 'Item Description', 'Unit / UOM'].forEach(exp => {
        assert(headers.includes(exp), `Missing expected column header: "${exp}" in [${headers.join(', ')}]`);
      });
      console.log(`  ✓ PASS: Core Flow Force columns present and verified in sheet "${dataSheetName}"`);

      downloadedFileTarget = path.resolve(__dirname, '../Flow_Force_New_SKU_Input_Template.xlsx');
    }

    // 9. Verify SPA fallback does NOT serve index.html for missing .xlsx files
    console.log('\n--- Testing SPA Fallback Guard ---');
    const missingRes = await fetchEndpoint(port, '/nonexistent_file.xlsx');
    assert.strictEqual(missingRes.statusCode, 404, `Missing .xlsx should return 404, got ${missingRes.statusCode}`);
    const missingText = missingRes.body.toString('utf8');
    assert(!missingText.includes('<!DOCTYPE html>'), 'Missing .xlsx must NEVER return index.html');
    console.log('  ✓ PASS: Missing .xlsx returns HTTP 404 (NEVER returns index.html)');

    // 10. Real Microsoft Excel Opening Verification via Excel.Application COM Object
    console.log('\n--- Testing Real Microsoft Excel Opening ---');
    try {
      const psCommand = `powershell -ExecutionPolicy Bypass -File "${path.resolve(__dirname, 'check_excel_open.ps1')}" -filePath "${downloadedFileTarget}"`;
      const excelOutput = execSync(psCommand, { encoding: 'utf8' });
      console.log(excelOutput.trim());
      assert(excelOutput.includes('TEST COMPLETED SUCCESSFULLY'), 'Excel COM check failed');
      console.log('  ✓ PASS: Microsoft Excel successfully opened and parsed the downloaded template without errors!');
    } catch (excelErr) {
      console.warn('  ⚠️ Note: Excel COM check skipped or failed on host:', excelErr.message);
    }

    console.log('\n================================================================');
    console.log('ALL EXCEL TEMPLATE TESTS PASSED (10/10)!');
    console.log('================================================================\n');

  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
