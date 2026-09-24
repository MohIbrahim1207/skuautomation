/**
 * Automated Test Suite: PR Document Storage & Download Flow
 * Covers:
 *  1. Admin can download authorized PR document (Excel & PDF)
 *  2. Employee can download their own authorized PR document
 *  3. Employee cannot download another employee's unauthorized document (403 Forbidden)
 *  4. Missing physical file returns a clear 404/document-not-found response
 *  5. Authorization errors are not incorrectly reported as storage errors (403 prior to 404)
 *  6. Portable path resolution (legacy 'app/storage/...' vs 'storage/...')
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const app = require('../server/index');
const { query, pool } = require('../server/db/pool');
const { JWT_SECRET } = require('../server/middleware/auth');
const { generatePrDocuments } = require('../server/services/documentGenerator');

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
          rawBuffer: rawBuf
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
    fullName: user.full_name,
    email: user.email,
    role: user.role,
    mustChangePassword: false
  }, JWT_SECRET, { expiresIn: '1h' });
}

async function run() {
  console.log('================================================================');
  console.log('  FLOW FORCE DOCUMENT STORAGE & DOWNLOAD VERIFICATION SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;
  const assert = (condition, msg) => {
    if (condition) {
      console.log(`  ✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${msg}`);
      failed++;
    }
  };

  // 1. Fetch Users
  const adminRes = await query(`SELECT * FROM users WHERE role = 'ADMIN' LIMIT 1`);
  const employeesRes = await query(`SELECT * FROM users WHERE role = 'EMPLOYEE' ORDER BY id ASC LIMIT 2`);

  if (adminRes.rowCount === 0 || employeesRes.rowCount < 2) {
    console.error('Test pre-requisite failed: Need 1 Admin and at least 2 Employees in database.');
    process.exit(1);
  }

  const adminUser = adminRes.rows[0];
  const empA = employeesRes.rows[0];
  const empB = employeesRes.rows[1];

  const adminToken = makeToken(adminUser);
  const empAToken = makeToken(empA);
  const empBToken = makeToken(empB);

  console.log(`Test Principals:`);
  console.log(`  Admin:      ${adminUser.username} (${adminUser.id})`);
  console.log(`  Employee A: ${empA.username} (${empA.id})`);
  console.log(`  Employee B: ${empB.username} (${empB.id})\n`);

  // Start test server
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Ephemeral test server listening on http://127.0.0.1:${port}\n`);

  let testProjectId = null;
  let testPrAId = null;
  let testPrBId = null;

  try {
    // 2. Setup Test Project and Purchase Requests
    const projRes = await query(`
      INSERT INTO projects (project_code, project_name, job_location, description, created_by_user_id)
      VALUES ('TEST-DL-PROJ', 'Document Download Test Project', 'Test Location', 'Testing document storage and downloads', $1)
      ON CONFLICT (project_code) DO UPDATE SET project_name = EXCLUDED.project_name
      RETURNING id, project_code
    `, [adminUser.id]);
    testProjectId = projRes.rows[0].id;

    // Create PR for Employee A
    const prARes = await query(`
      INSERT INTO purchase_requests (
        pr_number, project_id, status, department, required_date, urgency,
        reason_for_purchase, created_by_user_id
      ) VALUES (
        'PR-TEST-DLA-001', $1, 'APPROVED', 'Engineering', CURRENT_DATE + 7, 'Standard',
        'Testing doc dl emp A', $2
      ) RETURNING id, pr_number
    `, [testProjectId, empA.id]);
    testPrAId = prARes.rows[0].id;

    // Add item to PR A
    await query(`
      INSERT INTO pr_items (
        purchase_request_id, sku, product_name, item_description, material_grade,
        size_dimensions, unit, quantity, status, supply_type
      ) VALUES (
        $1, 'FF4186', 'Test Steel Plate', 'Test Item for PR A', 'SS400',
        '6mm x 5ft x 20ft', 'Sheet', 2, 'Available', 'Full Size'
      )
    `, [testPrAId]);

    // Create PR for Employee B
    const prBRes = await query(`
      INSERT INTO purchase_requests (
        pr_number, project_id, status, department, required_date, urgency,
        reason_for_purchase, created_by_user_id
      ) VALUES (
        'PR-TEST-DLB-001', $1, 'APPROVED', 'Engineering', CURRENT_DATE + 7, 'Standard',
        'Testing doc dl emp B', $2
      ) RETURNING id, pr_number
    `, [testProjectId, empB.id]);
    testPrBId = prBRes.rows[0].id;

    // Add item to PR B
    await query(`
      INSERT INTO pr_items (
        purchase_request_id, sku, product_name, item_description, material_grade,
        size_dimensions, unit, quantity, status, supply_type
      ) VALUES (
        $1, 'FF4187', 'Test Angle Bar', 'Test Item for PR B', 'SS400',
        '50x50x5mm', 'Length', 5, 'Available', 'Full Size'
      )
    `, [testPrBId]);

    // Generate documents for both PRs
    await generatePrDocuments(testPrAId);
    await generatePrDocuments(testPrBId);

    // Fetch generated document records
    const docsARes = await query(`SELECT * FROM documents WHERE purchase_request_id = $1 ORDER BY document_type`, [testPrAId]);
    const docsBRes = await query(`SELECT * FROM documents WHERE purchase_request_id = $1 ORDER BY document_type`, [testPrBId]);

    const excelDocA = docsARes.rows.find(d => d.document_type === 'PR_EXCEL');
    const pdfDocA = docsARes.rows.find(d => d.document_type === 'PR_PDF');
    const excelDocB = docsBRes.rows.find(d => d.document_type === 'PR_EXCEL');
    const pdfDocB = docsBRes.rows.find(d => d.document_type === 'PR_PDF');

    console.log('--- TEST GROUP 1: ADMIN AUTHORIZED PR DOCUMENT DOWNLOAD ---');
    {
      // Admin downloads Employee A's Excel
      const resExcel = await request(server, 'GET', `/api/documents/${excelDocA.id}/download`, {
        'Authorization': `Bearer ${adminToken}`
      });
      assert(resExcel.status === 200, 'Admin can download authorized PR Excel document (HTTP 200)');
      assert(
        resExcel.headers['content-type'] === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Excel response Content-Type is valid openxmlformats'
      );
      assert(
        resExcel.headers['content-disposition'] && resExcel.headers['content-disposition'].includes(excelDocA.file_name),
        'Excel response Content-Disposition matches document file_name'
      );
      assert(resExcel.rawBuffer.length > 500, `Excel file has non-empty stream payload (${resExcel.rawBuffer.length} bytes)`);

      // Admin downloads Employee A's PDF
      const resPdf = await request(server, 'GET', `/api/documents/${pdfDocA.id}/download`, {
        'Authorization': `Bearer ${adminToken}`
      });
      assert(resPdf.status === 200, 'Admin can download authorized PR PDF document (HTTP 200)');
      assert(resPdf.headers['content-type'] === 'application/pdf', 'PDF response Content-Type is application/pdf');
      assert(
        resPdf.headers['content-disposition'] && resPdf.headers['content-disposition'].includes(pdfDocA.file_name),
        'PDF response Content-Disposition matches document file_name'
      );
      assert(resPdf.rawBuffer.slice(0, 4).toString('utf8') === '%PDF', 'PDF payload begins with valid %PDF magic bytes');
    }

    console.log('\n--- TEST GROUP 2: EMPLOYEE DOWNLOADS OWN AUTHORIZED PR DOCUMENT ---');
    {
      // Employee A downloads their OWN PR documents
      const resAExcel = await request(server, 'GET', `/api/documents/${excelDocA.id}/download`, {
        'Authorization': `Bearer ${empAToken}`
      });
      assert(resAExcel.status === 200, 'Employee A can download their own PR Excel document (HTTP 200)');
      assert(resAExcel.rawBuffer.length > 500, 'Employee A receives valid Excel stream');

      const resAPdf = await request(server, 'GET', `/api/documents/${pdfDocA.id}/download`, {
        'Authorization': `Bearer ${empAToken}`
      });
      assert(resAPdf.status === 200, 'Employee A can download their own PR PDF document (HTTP 200)');
      assert(resAPdf.rawBuffer.slice(0, 4).toString('utf8') === '%PDF', 'Employee A receives valid PDF stream');
    }

    console.log('\n--- TEST GROUP 3: EMPLOYEE CANNOT DOWNLOAD ANOTHER EMPLOYEE\'S DOCUMENT (403) ---');
    {
      // Employee A attempts to download Employee B's document
      const resUnauthorizedExcel = await request(server, 'GET', `/api/documents/${excelDocB.id}/download`, {
        'Authorization': `Bearer ${empAToken}`
      });
      assert(resUnauthorizedExcel.status === 403, 'Employee A blocked from downloading Employee B document with HTTP 403');
      assert(
        resUnauthorizedExcel.body && resUnauthorizedExcel.body.error && resUnauthorizedExcel.body.error.includes('Access Denied'),
        'Blocked response contains clear "Access Denied" error message'
      );

      const resUnauthorizedPdf = await request(server, 'GET', `/api/documents/${pdfDocB.id}/download`, {
        'Authorization': `Bearer ${empAToken}`
      });
      assert(resUnauthorizedPdf.status === 403, 'Employee A blocked from downloading Employee B PDF with HTTP 403');
    }

    console.log('\n--- TEST GROUP 4: MISSING PHYSICAL FILE RETURNS CLEAR 404 ---');
    {
      // Create a document record pointing to a non-existent physical file
      const ghostDocRes = await query(`
        INSERT INTO documents (
          project_id, purchase_request_id, document_type, file_name,
          file_path_or_storage_key, uploaded_by_user_id
        ) VALUES (
          $1, $2, 'PR_PDF', 'PR-GHOST-MISSING.pdf',
          'storage/projects/TEST-DL-PROJ/purchase-requests/PR-GHOST-MISSING.pdf', $3
        ) RETURNING id
      `, [testProjectId, testPrAId, empA.id]);
      const ghostDocId = ghostDocRes.rows[0].id;

      // Employee A requests missing document
      const resGhost = await request(server, 'GET', `/api/documents/${ghostDocId}/download`, {
        'Authorization': `Bearer ${empAToken}`
      });
      assert(resGhost.status === 404, 'Missing physical file returns clear HTTP 404 response');
      assert(
        resGhost.body && resGhost.body.error === 'Physical document file not found on server storage.',
        'Error message correctly states "Physical document file not found on server storage."'
      );

      // Clean up ghost doc
      await query(`DELETE FROM documents WHERE id = $1`, [ghostDocId]);
    }

    console.log('\n--- TEST GROUP 5: AUTHORIZATION ERRORS NOT REPORTED AS STORAGE ERRORS ---');
    {
      // Create a non-existent file document belonging to Employee B
      const ghostDocBRes = await query(`
        INSERT INTO documents (
          project_id, purchase_request_id, document_type, file_name,
          file_path_or_storage_key, uploaded_by_user_id
        ) VALUES (
          $1, $2, 'PR_PDF', 'PR-GHOST-B-MISSING.pdf',
          'storage/projects/TEST-DL-PROJ/purchase-requests/PR-GHOST-B-MISSING.pdf', $3
        ) RETURNING id
      `, [testProjectId, testPrBId, empB.id]);
      const ghostDocBId = ghostDocBRes.rows[0].id;

      // Employee A attempts to download Employee B's missing document
      // It MUST fail with 403 (Authorization), NOT 404 (Storage missing)!
      const resAuthPrecedence = await request(server, 'GET', `/api/documents/${ghostDocBId}/download`, {
        'Authorization': `Bearer ${empAToken}`
      });
      assert(
        resAuthPrecedence.status === 403,
        'Authorization check executes BEFORE storage check (returns 403, NEVER misreports as 404 storage error)'
      );
      assert(
        resAuthPrecedence.body && resAuthPrecedence.body.error && resAuthPrecedence.body.error.includes('Access Denied'),
        'Returns Access Denied message rather than file missing message'
      );

      // Clean up
      await query(`DELETE FROM documents WHERE id = $1`, [ghostDocBId]);
    }

    console.log('\n--- TEST GROUP 6: PORTABLE PATH RESOLUTION (LEGACY "app/storage/..." KEYS) ---');
    {
      // Create a document record with legacy prefix 'app/storage/...' simulating container database state
      // Ensure the physical file exists in standard storage
      const legacyKey = `app/${excelDocA.file_path_or_storage_key.replace(/^app[/\\]/, '')}`;
      const legacyDocRes = await query(`
        INSERT INTO documents (
          project_id, purchase_request_id, document_type, file_name,
          file_path_or_storage_key, uploaded_by_user_id
        ) VALUES (
          $1, $2, 'PR_EXCEL', 'PR-LEGACY-TEST.xlsx',
          $3, $4
        ) RETURNING id
      `, [testProjectId, testPrAId, legacyKey, empA.id]);
      const legacyDocId = legacyDocRes.rows[0].id;

      const resLegacy = await request(server, 'GET', `/api/documents/${legacyDocId}/download`, {
        'Authorization': `Bearer ${empAToken}`
      });
      assert(resLegacy.status === 200, 'Legacy "app/storage/..." storage key resolved successfully by resolveStoragePath (HTTP 200)');
      assert(resLegacy.rawBuffer.length > 500, 'Legacy document streamed correct payload');

      // Clean up
      await query(`DELETE FROM documents WHERE id = $1`, [legacyDocId]);
    }

  } finally {
    // Teardown test records
    if (testPrAId) {
      await query(`DELETE FROM documents WHERE purchase_request_id = $1`, [testPrAId]);
      await query(`DELETE FROM pr_items WHERE purchase_request_id = $1`, [testPrAId]);
      await query(`DELETE FROM pr_approval_history WHERE purchase_request_id = $1`, [testPrAId]);
      await query(`DELETE FROM purchase_requests WHERE id = $1`, [testPrAId]);
    }
    if (testPrBId) {
      await query(`DELETE FROM documents WHERE purchase_request_id = $1`, [testPrBId]);
      await query(`DELETE FROM pr_items WHERE purchase_request_id = $1`, [testPrBId]);
      await query(`DELETE FROM pr_approval_history WHERE purchase_request_id = $1`, [testPrBId]);
      await query(`DELETE FROM purchase_requests WHERE id = $1`, [testPrBId]);
    }
    if (testProjectId) {
      await query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);
    }
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n================================================================');
  console.log(`TOTAL PASSES:   ${passed}`);
  console.log(`TOTAL FAILURES: ${failed}`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
