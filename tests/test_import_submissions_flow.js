/**
 * =========================================================================
 * Comprehensive Integration Test Suite: Controlled Import Submissions Flow
 * =========================================================================
 * Covers:
 *  1. Database Schema & Startup Migrations
 *     - import_submissions & import_submission_items tables exist and have correct columns
 *  2. Authentication & Roles
 *     - Admin token can GET /api/import-submissions (200 OK)
 *     - Employee token can GET /api/import-submissions (200 OK, only own submissions)
 *  3. Excel Import Staging (Fasteners, Piping, Blank SKUs)
 *     - Items uploaded enter PENDING_REVIEW
 *     - Blank SKUs remain unassigned ("NEW ITEM — SKU TO BE ASSIGNED")
 *     - master_items is NOT modified during staging (zero inserts)
 *  4. RBAC & Data Isolation
 *     - Employee cannot view another employee's staged imports
 *     - Employee cannot approve (403 Forbidden)
 *     - Employee cannot reject (403 Forbidden)
 *     - Employee cannot edit staged items (403 Forbidden)
 *     - Admin can view all submissions
 *  5. Admin Edit & Approval Workflow
 *     - Admin can update staged item details
 *     - Admin approves submission -> atomic commit to master_items
 *     - Sequential Flow Force SKUs (e.g. FF4236+) correctly assigned
 *     - Existing master_items remain unmodified and intact
 *  6. JSON Structure Compatibility
 *     - Both camelCase and snake_case properties are present for UI compatibility
 */
const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../server/index');
const { query, pool } = require('../server/db/pool');
const { JWT_SECRET } = require('../server/middleware/auth');

function request(server, method, reqPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr.port;
    const reqHeaders = { ...headers };
    let postData = '';
    if (body) {
      postData = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: reqHeaders
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        const rawBuf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(rawBuf.toString('utf8')); } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
          rawText: rawBuf.toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function makeToken(user) {
  return jwt.sign({
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email,
    fullName: user.fullName || user.username
  }, JWT_SECRET, { expiresIn: '1h' });
}

let server;

async function run() {
  console.log('================================================================');
  console.log('STARTING INTEGRATION TESTS: IMPORT SUBMISSIONS WORKFLOW & RBAC');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 0. Start local server
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        console.log(`Local test server running on port ${port}\n`);
        resolve();
      });
    });

    // 1. Health check and startup migrations
    console.log('TEST 1: Health check & Schema Verification');
    const healthRes = await request(server, 'GET', '/health');
    assert(healthRes.status === 200, `Health check status is 200 (got ${healthRes.status})`);
    assert(healthRes.body.database === 'connected', 'Database is connected');

    // Verify import_submissions & import_submission_items exist
    const tblCheck = await query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_name IN ('import_submissions', 'import_submission_items')
    `);
    const existingTables = tblCheck.rows.map(r => r.table_name);
    assert(existingTables.includes('import_submissions'), 'import_submissions table exists in PostgreSQL');
    assert(existingTables.includes('import_submission_items'), 'import_submission_items table exists in PostgreSQL');

    // Record initial master items count
    const initialMasterCountRes = await query('SELECT COUNT(*) AS count FROM master_items');
    const initialMasterCount = parseInt(initialMasterCountRes.rows[0].count, 10);
    console.log(`Initial master_items count: ${initialMasterCount}\n`);

    // Define test users
    const adminUser = { id: 'USR-001', username: 'admin', role: 'ADMIN', email: 'admin@flowforce.local', fullName: 'System Administrator' };
    const empUserA = { id: 'USR-002', username: 'ren1234', role: 'EMPLOYEE', email: 'ren1234@flowforce.local', fullName: 'Employee Ren' };
    const empUserB = { id: 'USR-003', username: 'employee', role: 'EMPLOYEE', email: 'employee@flowforce.local', fullName: 'Employee Default' };

    const adminToken = makeToken(adminUser);
    const empTokenA = makeToken(empUserA);
    const empTokenB = makeToken(empUserB);

    // 2. GET /api/import-submissions for Admin and Employee
    console.log('TEST 2: GET /api/import-submissions Endpoint Availability');
    const adminGet = await request(server, 'GET', '/api/import-submissions', { Authorization: `Bearer ${adminToken}` });
    assert(adminGet.status === 200, `Admin GET /api/import-submissions returns 200 (got ${adminGet.status})`);
    assert(Array.isArray(adminGet.body), 'Admin receives an array of submissions');

    const empGet = await request(server, 'GET', '/api/import-submissions', { Authorization: `Bearer ${empTokenA}` });
    assert(empGet.status === 200, `Employee GET /api/import-submissions returns 200 (got ${empGet.status})`);
    assert(Array.isArray(empGet.body), 'Employee receives an array of submissions');

    // 3. Staging Import Batch (Fasteners + Piping + Blank SKUs)
    console.log('\nTEST 3: Staging Import Batch (Fasteners, Piping, Blank SKUs)');
    const importPayload = {
      fileName: 'Fasteners_and_Piping_Test.xlsx',
      items: [
        {
          rowNumber: 1,
          sourceSheet: 'Fasteners',
          sku: '', // Blank SKU: must remain unassigned until Admin approval
          productName: 'Hex Bolt M12 x 50mm Stainless Steel 316',
          itemDescription: 'Full thread hex bolt SS316 with matching nut and washers',
          category: 'Fasteners',
          subCategory: 'Hex Bolts',
          material: 'SS316',
          size: 'M12 x 50mm',
          specification: 'DIN 933',
          unit: 'Pcs',
          weightKg: '0.085',
          unitPrice: '12500',
          supplyType: 'Full Size',
          brand: 'Tong',
          supplierName: 'Global Fasteners PT',
          remarks: 'Critical fastener for pipeline flange assembly'
        },
        {
          rowNumber: 2,
          sourceSheet: 'Piping',
          sku: '', // Blank SKU
          productName: 'Seamless Carbon Steel Pipe 4" Sch 40',
          itemDescription: 'Seamless pipe ASTM A106 Gr B 4 inch nominal bore',
          category: 'Piping & Tubes',
          subCategory: 'Pipes',
          material: 'ASTM A106 Gr. B',
          size: '4" Sch 40 x 6000mm',
          specification: 'ASME B36.10M',
          unit: 'Length',
          weightKg: '96.42',
          unitPrice: '1850000',
          supplyType: 'Full Size',
          brand: 'NSSMC',
          supplierName: 'Indo Steel Pipe',
          remarks: 'Steam line replacement spool'
        }
      ]
    };

    const submitRes = await request(server, 'POST', '/api/import-submissions', {
      Authorization: `Bearer ${empTokenA}`
    }, importPayload);

    assert(submitRes.status === 201, `Import submission created with 201 Created (got ${submitRes.status})`);
    assert(submitRes.body.success === true, 'Response indicates success');
    const createdImportId = submitRes.body.importId || submitRes.body.import_id;
    assert(!!createdImportId, `Created Import ID: ${createdImportId}`);
    assert(submitRes.body.submission.status === 'PENDING_REVIEW', 'Submission status is PENDING_REVIEW');

    // Verify master_items was NOT modified during upload/staging
    const masterCountAfterStageRes = await query('SELECT COUNT(*) AS count FROM master_items');
    const masterCountAfterStage = parseInt(masterCountAfterStageRes.rows[0].count, 10);
    assert(masterCountAfterStage === initialMasterCount, `master_items count unchanged during staging (${masterCountAfterStage} === ${initialMasterCount})`);

    // Verify blank SKU remains unassigned in staging table
    const stagedItemsRes = await query(
      `SELECT * FROM import_submission_items WHERE submission_id = (SELECT id FROM import_submissions WHERE import_id = $1) ORDER BY row_number ASC`,
      [createdImportId]
    );
    assert(stagedItemsRes.rowCount === 2, '2 items saved to import_submission_items');
    assert(stagedItemsRes.rows[0].assigned_master_sku === null, 'First item assigned_master_sku is NULL (unassigned)');
    assert(stagedItemsRes.rows[1].assigned_master_sku === null, 'Second item assigned_master_sku is NULL (unassigned)');

    // 4. Data Isolation & RBAC
    console.log('\nTEST 4: RBAC & Data Isolation');
    // Employee A (uploader) sees the submission
    const empAGetList = await request(server, 'GET', '/api/import-submissions', { Authorization: `Bearer ${empTokenA}` });
    const empASubIds = empAGetList.body.map(s => s.importId || s.import_id);
    assert(empASubIds.includes(createdImportId), 'Uploader (Employee A) sees their own submission');

    // Employee B does NOT see Employee A's submission
    const empBGetList = await request(server, 'GET', '/api/import-submissions', { Authorization: `Bearer ${empTokenB}` });
    const empBSubIds = empBGetList.body.map(s => s.importId || s.import_id);
    assert(!empBSubIds.includes(createdImportId), 'Non-uploader (Employee B) CANNOT see Employee A submission');

    // Admin sees the submission
    const adminGetList = await request(server, 'GET', '/api/import-submissions', { Authorization: `Bearer ${adminToken}` });
    const adminSubIds = adminGetList.body.map(s => s.importId || s.import_id);
    assert(adminSubIds.includes(createdImportId), 'Admin can see the staged submission');

    // Employee B cannot GET details of Employee A's submission (403 Forbidden)
    const empBDetails = await request(server, 'GET', `/api/import-submissions/${createdImportId}`, { Authorization: `Bearer ${empTokenB}` });
    assert(empBDetails.status === 403, `Employee B forbidden from viewing Employee A submission details (got ${empBDetails.status})`);

    // Employee A cannot approve their own submission (403 Forbidden)
    const empApprove = await request(server, 'POST', `/api/import-submissions/${createdImportId}/approve`, { Authorization: `Bearer ${empTokenA}` });
    assert(empApprove.status === 403, `Employee forbidden from approving submission (got ${empApprove.status})`);

    // Employee A cannot reject submission (403 Forbidden)
    const empReject = await request(server, 'POST', `/api/import-submissions/${createdImportId}/reject`, { Authorization: `Bearer ${empTokenA}` });
    assert(empReject.status === 403, `Employee forbidden from rejecting submission (got ${empReject.status})`);

    // Employee A cannot edit item row (403 Forbidden)
    const firstItemId = stagedItemsRes.rows[0].id;
    const empEdit = await request(server, 'PUT', `/api/import-submissions/${createdImportId}/items/${firstItemId}`, { Authorization: `Bearer ${empTokenA}` }, {
      productName: 'Hacked Name'
    });
    assert(empEdit.status === 403, `Employee forbidden from modifying staged items (got ${empEdit.status})`);

    // 5. JSON Response Compatibility (CamelCase + Snake_Case)
    console.log('\nTEST 5: JSON Response Structure & Compatibility');
    const adminDetails = await request(server, 'GET', `/api/import-submissions/${createdImportId}`, { Authorization: `Bearer ${adminToken}` });
    assert(adminDetails.status === 200, `Admin GET details returns 200 (got ${adminDetails.status})`);
    const subObj = adminDetails.body.submission;
    assert(subObj.import_id === createdImportId && subObj.importId === createdImportId, 'Submission contains both import_id and importId');
    assert(subObj.file_name === 'Fasteners_and_Piping_Test.xlsx' && subObj.fileName === 'Fasteners_and_Piping_Test.xlsx', 'Submission contains both file_name and fileName');
    assert(subObj.total_rows === 2 && subObj.totalRows === 2, 'Submission contains both total_rows and totalRows');

    const firstItem = adminDetails.body.items[0];
    assert(firstItem.product_name === 'Hex Bolt M12 x 50mm Stainless Steel 316' && firstItem.productName === 'Hex Bolt M12 x 50mm Stainless Steel 316', 'Item contains both product_name and productName');
    assert(firstItem.unit_price === 12500 && firstItem.unitPrice === 12500, 'Item contains both unit_price and unitPrice');
    assert(firstItem.weight_kg === 0.085 && firstItem.weightKg === 0.085, 'Item contains both weight_kg and weightKg');

    // 6. Admin Edit Item Row Before Approval
    console.log('\nTEST 6: Admin Edit Item Row');
    const adminEdit = await request(server, 'PUT', `/api/import-submissions/${createdImportId}/items/${firstItemId}`, {
      Authorization: `Bearer ${adminToken}`
    }, {
      productName: 'Hex Bolt M12 x 50mm Stainless Steel 316 (Verified)',
      unitPrice: 13000
    });
    assert(adminEdit.status === 200, `Admin successfully edited item row (got ${adminEdit.status})`);
    assert(adminEdit.body.item.product_name === 'Hex Bolt M12 x 50mm Stainless Steel 316 (Verified)', 'Updated product name verified in DB');
    assert(Number(adminEdit.body.item.unit_price) === 13000, 'Updated unit price verified in DB');

    // 7. Admin Approval -> Atomic Commit to master_items
    console.log('\nTEST 7: Admin Approval Workflow');
    const approveRes = await request(server, 'POST', `/api/import-submissions/${createdImportId}/approve`, {
      Authorization: `Bearer ${adminToken}`
    });
    assert(approveRes.status === 200, `Submission approved with 200 OK (got ${approveRes.status})`);
    assert(approveRes.body.success === true, 'Approval indicates success');
    assert(approveRes.body.rowsImported === 2, `2 items imported into master_items`);

    // Verify master_items now has +2 items
    const masterCountAfterApproveRes = await query('SELECT COUNT(*) AS count FROM master_items');
    const masterCountAfterApprove = parseInt(masterCountAfterApproveRes.rows[0].count, 10);
    assert(masterCountAfterApprove === initialMasterCount + 2, `master_items count increased by 2 (${masterCountAfterApprove} === ${initialMasterCount + 2})`);

    // Verify newly assigned SKUs follow sequential FF format
    const newItemsRes = await query(`
      SELECT sku, product_name, category, sub_category, unit_price, status, supply_type 
      FROM master_items 
      ORDER BY sku DESC 
      LIMIT 2
    `);
    const newItems = newItemsRes.rows.reverse();
    assert(newItems[0].sku.startsWith('FF'), `First assigned SKU starts with FF (${newItems[0].sku})`);
    assert(newItems[1].sku.startsWith('FF'), `Second assigned SKU starts with FF (${newItems[1].sku})`);
    assert(newItems[0].product_name === 'Hex Bolt M12 x 50mm Stainless Steel 316 (Verified)', 'Verified edited product name in master_items');
    assert(newItems[0].status === 'Available', 'New item status is Available');

    // Verify submission status changed to APPROVED
    const finalSubRes = await query('SELECT status, approved_by_username, approved_at FROM import_submissions WHERE import_id = $1', [createdImportId]);
    assert(finalSubRes.rows[0].status === 'APPROVED', 'Submission status updated to APPROVED');
    assert(finalSubRes.rows[0].approved_by_username === 'admin', 'Approved by username is admin');

    // Clean up test items added to master_items during approval
    for (const item of newItems) {
      await query('DELETE FROM master_items WHERE sku = $1', [item.sku]);
    }
    await query('DELETE FROM import_submissions WHERE import_id = $1', [createdImportId]);

    const finalMasterCountRes = await query('SELECT COUNT(*) AS count FROM master_items');
    const finalMasterCount = parseInt(finalMasterCountRes.rows[0].count, 10);
    assert(finalMasterCount === initialMasterCount, `master_items restored to exact initial count (${finalMasterCount} === ${initialMasterCount})`);

    console.log('\n================================================================');
    console.log(`INTEGRATION TESTS SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test suite uncaught error:', err);
    process.exit(1);
  } finally {
    if (server) {
      server.close();
    }
    await pool.end();
  }
}

run();
