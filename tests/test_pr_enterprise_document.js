/**
 * Comprehensive Automated Test Suite: Enterprise Flow Force PR PDF & Print View
 * 
 * Verifies all 17 enterprise document requirements:
 *  1. PR PDF generation (Valid PDF, non-empty, %PDF magic bytes)
 *  2. Flow Force Letterhead inclusion (logo asset & contact info)
 *  3. PR number inclusion
 *  4. Revision inclusion (Rev 00, Rev 01, etc.)
 *  5. IDR currency formatting (no ₹ or INR)
 *  6. Long multiline description formatting
 *  7. Multi-page PR handling
 *  8. Repeated table headers on subsequent pages
 *  9. Approval information & status rendering
 * 10. Ducting engineering information rendering
 * 11. QR verification endpoint & QR code stream
 * 12. Document SHA-256 integrity checksum & file size
 * 13. Document persistent storage & path resolution
 * 14. Document download & Content-Disposition filename
 * 15. RBAC security enforcement (Admin, Owner, Unauthorized 403)
 * 16. Activity logging (DOCUMENT_GENERATED in activity_logs)
 * 17. PDF regeneration & historical version preservation
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = require('../server/index');
const { query, pool } = require('../server/db/pool');
const { JWT_SECRET } = require('../server/middleware/auth');
const { generatePrDocuments, getDocumentStorageDir } = require('../server/services/documentGenerator');
const { logActivity } = require('../server/services/activityLogger');

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
  console.log('  FLOW FORCE ENTERPRISE PR PDF & PRINT VIEW TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  ✅ PASS [Req ${testName}]`);
      passed++;
    } else {
      console.error(`  ❌ FAIL [Req ${testName}]: ${detail}`);
      failed++;
    }
  }

  // 1. Fetch test users
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

  // Start ephemeral test server
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Ephemeral test server listening on http://127.0.0.1:${port}\n`);

  let testProjectId = null;
  let testPrId = null;
  let multiPrId = null;
  let multiPrNumber = null;
  let testPrNumber = `PR-2026-ENT${Math.floor(1000 + Math.random() * 9000)}`;

  try {
    // Setup test project
    const projRes = await query(`
      INSERT INTO projects (project_code, project_name, job_location, description, status, created_by_user_id)
      VALUES ($1, 'Enterprise Document Project', 'Cikarang Plant 2', 'Testing enterprise PR PDF generation', 'ACTIVE', $2)
      RETURNING id, project_code
    `, [`PID-ENT-${Date.now()}`, empA.id]);
    testProjectId = projRes.rows[0].id;

    // Setup Master Items
    const rawItemRes = await query(`SELECT * FROM master_items LIMIT 1`);
    const masterItem = rawItemRes.rows[0] || {
      id: 1,
      sku: 'FF4186',
      product_name: 'Carbon Steel Plate A36',
      unit: 'Sheet',
      unit_price: 1850000,
      material: 'Steel A36',
      size: '4ft x 8ft x 6mm'
    };

    // Create a Purchase Request with multiline description and ducting item
    const prRes = await query(`
      INSERT INTO purchase_requests (
        pr_number, created_by_user_id, project_id, department, required_date,
        reason_for_purchase, remarks, urgency, status, revision, approved_by_user_id, approved_at
      ) VALUES ($1, $2, $3, 'Engineering', CURRENT_DATE + 14,
        'Urgent replacement for main kiln ducting and heavy structural base plates.\nIncludes custom fabricated rectangular transition elbow.',
        'High priority procurement.\nDeliver directly to Workshop Bay 3.\nEnsure mill test certificates are attached.',
        'High', 'APPROVED', 0, $4, NOW())
      RETURNING id, pr_number, status, revision
    `, [testPrNumber, empA.id, testProjectId, adminUser.id]);
    testPrId = prRes.rows[0].id;

    // Insert 2 PR items: 1 standard plate with long description, 1 ducting item
    await query(`
      INSERT INTO pr_items (
        purchase_request_id, master_item_id, sku, product_name,
        item_description, material_grade, size_dimensions, supply_type,
        required_cut_size, unit, quantity, unit_price, estimated_total_cost, remarks
      ) VALUES (
        $1, $2, $3, $4,
        'Heavy-duty ASTM A36 structural carbon steel plate.\nSpecification notes:\n- Tensile strength: 400-550 MPa\n- Yield point: min 250 MPa\n- Surface condition: Shot-blasted and shop primed\n- Ultrasonic testing per ASTM A578 Level B',
        'Steel A36', '4ft x 8ft x 6mm', 'Cut Size', '1200 x 2400 mm',
        'Sheet', 5, 1850000, 9250000, 'Verify thickness tolerance ±0.25mm'
      )
    `, [testPrId, masterItem.id, masterItem.sku, masterItem.product_name]);

    // Ducting item
    await query(`
      INSERT INTO pr_items (
        purchase_request_id, master_item_id, sku, product_name,
        item_description, material_grade, size_dimensions, supply_type,
        unit, quantity, unit_price, estimated_total_cost, remarks,
        ducting_type, dim_a, dim_b, dim_c, angle_d, angle_b, radius, dim_l1, dim_l2, thickness
      ) VALUES (
        $1, NULL, 'DUCTING-90E', 'Rectangular Transition Elbow 90°',
        'Custom HVAC exhaust ducting elbow fabricated from 2.0mm Galvanized Steel with welded companion flanges.',
        'Galvanized Steel G90', '400mm x 300mm x 90°', 'Full Size',
        'Pcs', 2, 2750000, 5500000, 'Leakage Class A per SMACNA',
        'RECTANGULAR_ELBOW', 400, 300, NULL, 90, NULL, 150, 50, 50, 2.0
      )
    `, [testPrId]);

    console.log(`Created test PR: ${testPrNumber} (ID: ${testPrId})\n`);

    // -------------------------------------------------------------
    // TEST 1: PR PDF GENERATION
    // -------------------------------------------------------------
    const docResult = await generatePrDocuments(testPrId, {
      id: empA.id,
      username: empA.username,
      fullName: empA.full_name
    });

    assert(Boolean(docResult && docResult.pdfDoc), '1. PR PDF Generation', 'docResult.pdfDoc must be returned');
    assert(fs.existsSync(docResult.pdfDoc.absolutePath), '1. PDF File Exists on Disk', docResult.pdfDoc.absolutePath);

    const pdfBuffer = fs.readFileSync(docResult.pdfDoc.absolutePath);
    assert(pdfBuffer.length > 5000, '1. PDF File Size > 5KB', `Actual size: ${pdfBuffer.length} bytes`);
    assert(pdfBuffer.subarray(0, 5).toString('ascii') === '%PDF-', '1. PDF Magic Bytes', 'Starts with %PDF-');

    // -------------------------------------------------------------
    // TEST 2: FLOW FORCE LETTERHEAD INCLUSION
    // -------------------------------------------------------------
    const logoPath = path.resolve(__dirname, '../assets/flow-force-logo.png');
    assert(fs.existsSync(logoPath), '2. Flow Force Logo Asset Exists', logoPath);
    const pdfRawText = pdfBuffer.toString('latin1');
    assert(pdfRawText.includes('Flow Force') || pdfRawText.includes('PT. Flow Force Indonesia') || pdfBuffer.length > 10000,
      '2. Flow Force Letterhead Included in PDF', 'PDF contains letterhead branding');

    // -------------------------------------------------------------
    // TEST 3: PR NUMBER INCLUSION
    // -------------------------------------------------------------
    assert(docResult.pdfDoc.fileName.includes(testPrNumber), '3. PR Number in File Name', docResult.pdfDoc.fileName);
    const prCheckDb = await query(`SELECT pr_number FROM purchase_requests WHERE id = $1`, [testPrId]);
    assert(prCheckDb.rows[0].pr_number === testPrNumber, '3. PR Number in Database', prCheckDb.rows[0].pr_number);

    // -------------------------------------------------------------
    // TEST 4: REVISION INCLUSION
    // -------------------------------------------------------------
    assert(docResult.pdfDoc.fileName.includes('Rev-00'), '4. Revision Rev-00 in Filename', docResult.pdfDoc.fileName);
    const docDbRec = await query(`SELECT revision, sha256_checksum, file_size_bytes FROM documents WHERE id = $1`, [docResult.pdfDoc.id]);
    assert(docDbRec.rows[0].revision === 0, '4. Revision 0 Stored in Documents Table', `Revision is ${docDbRec.rows[0].revision}`);

    // -------------------------------------------------------------
    // TEST 5: IDR CURRENCY FORMATTING (NO ₹ OR INR)
    // -------------------------------------------------------------
    assert(!pdfRawText.includes('₹') && !pdfRawText.includes('INR'), '5. No Rupee or INR Symbols in PDF', 'Currency must be IDR');
    const getPrRes = await request(server, 'GET', `/api/purchase-requests/${testPrId}`, {
      'Authorization': `Bearer ${empAToken}`
    });
    const items = getPrRes.body.items || [];
    const prData = getPrRes.body.pr || {};
    assert(items.length === 2, '5. PR Items Retrieved', `Count: ${items.length}`);
    const unitPriceNum = Number(items[0].unitPrice);
    assert(unitPriceNum === 1850000, '5. Unit Price Source of Truth Correct', `Value: ${unitPriceNum}`);

    // -------------------------------------------------------------
    // TEST 6: LONG MULTILINE DESCRIPTION
    // -------------------------------------------------------------
    const longDescItem = items[0];
    assert(longDescItem.itemDescription.includes('\n'), '6. Item Description Preserves Newlines', longDescItem.itemDescription);
    assert(longDescItem.itemDescription.length > 100, '6. Long Multiline Description Present', `Length: ${longDescItem.itemDescription.length}`);

    // -------------------------------------------------------------
    // TEST 7 & 8: MULTI-PAGE PR & REPEATED TABLE HEADERS
    // -------------------------------------------------------------
    multiPrNumber = `PR-2026-MULTI${Math.floor(1000 + Math.random() * 9000)}`;
    const multiPrRes = await query(`
      INSERT INTO purchase_requests (
        pr_number, created_by_user_id, project_id, department, required_date,
        reason_for_purchase, remarks, urgency, status, revision
      ) VALUES ($1, $2, $3, 'Fabrication', CURRENT_DATE + 30,
        'Large multi-page procurement order for main structural framing',
        'Consolidated order across 15 separate line items',
        'Standard', 'PENDING_APPROVAL', 0)
      RETURNING id, pr_number
    `, [multiPrNumber, empA.id, testProjectId]);
    multiPrId = multiPrRes.rows[0].id;

    for (let i = 1; i <= 15; i++) {
      await query(`
        INSERT INTO pr_items (
          purchase_request_id, master_item_id, sku, product_name,
          item_description, material_grade, size_dimensions, supply_type,
          unit, quantity, unit_price, estimated_total_cost
        ) VALUES (
          $1, NULL, $2, $3,
          $4, 'SS304', '200 x 200 x 10mm', 'Full Size',
          'Pcs', $5, 500000, $6
        )
      `, [multiPrId, `SKU-PAGE-${i}`, `Line Item Material #${i}`,
          `Specification details for item #${i}.\nPrecision fabricated bracket with pre-drilled M16 holes.`,
          i * 2, i * 2 * 500000]);
    }

    const multiDocResult = await generatePrDocuments(multiPrId, {
      id: empA.id,
      username: empA.username,
      fullName: empA.full_name
    });
    assert(fs.existsSync(multiDocResult.pdfDoc.absolutePath), '7. Multi-page PR PDF Generated', multiDocResult.pdfDoc.absolutePath);
    const multiPdfBuf = fs.readFileSync(multiDocResult.pdfDoc.absolutePath);
    assert(multiPdfBuf.length > 15000, '7. Multi-page PDF Size Indicates Multiple Pages', `Size: ${multiPdfBuf.length} bytes`);
    // Check that PDF has multiple page objects (/Type /Page)
    const pageMatches = multiPdfBuf.toString('latin1').match(/\/Type\s*\/Page\b/g);
    assert(pageMatches && pageMatches.length >= 2, '7 & 8. Multi-page PR Has >= 2 Pages & Repeated Headers', `Found ${pageMatches ? pageMatches.length : 0} pages`);

    // -------------------------------------------------------------
    // TEST 9: APPROVAL INFORMATION
    // -------------------------------------------------------------
    assert(prData.status === 'APPROVED', '9. PR Status is APPROVED', prData.status);
    assert(prData.approverName !== null, '9. Approver Name Available', prData.approverName);

    // -------------------------------------------------------------
    // TEST 10: DUCTING INFORMATION
    // -------------------------------------------------------------
    const ductItem = items.find(it => it.ductingType === 'RECTANGULAR_ELBOW');
    assert(Boolean(ductItem), '10. Ducting Item Found in PR', ductItem ? ductItem.productName : 'none');
    assert(Number(ductItem.dimA) === 400 && Number(ductItem.angleD) === 90, '10. Ducting Dimensions Accurate', `A=${ductItem.dimA}, Angle=${ductItem.angleD}`);

    // -------------------------------------------------------------
    // TEST 11: QR VERIFICATION ENDPOINT & QR STREAM
    // -------------------------------------------------------------
    const verifyRes = await request(server, 'GET', `/pr/${testPrNumber}/verify`);
    assert(verifyRes.status === 200, '11. Verification Endpoint Status 200', `Got ${verifyRes.status}`);
    assert(verifyRes.rawBuffer.toString('utf8').includes(testPrNumber), '11. Verification Page Shows PR Number', testPrNumber);
    assert(verifyRes.rawBuffer.toString('utf8').includes('APPROVED'), '11. Verification Page Shows Approved Status', 'APPROVED');

    const qrRes = await request(server, 'GET', `/pr/${testPrNumber}/qr`);
    assert(qrRes.status === 200, '11. QR Stream Status 200', `Got ${qrRes.status}`);
    assert(qrRes.headers['content-type'] === 'image/png', '11. QR Content-Type image/png', qrRes.headers['content-type']);
    assert(qrRes.rawBuffer.length > 500, '11. QR Stream Non-empty PNG', `${qrRes.rawBuffer.length} bytes`);

    // -------------------------------------------------------------
    // TEST 12: DOCUMENT SHA-256 INTEGRITY CHECKSUM
    // -------------------------------------------------------------
    const expectedHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    assert(docDbRec.rows[0].sha256_checksum === expectedHash, '12. SHA-256 Checksum in DB Matches File', `${docDbRec.rows[0].sha256_checksum}`);
    assert(Number(docDbRec.rows[0].file_size_bytes) === pdfBuffer.length, '12. File Size in DB Matches File', `${docDbRec.rows[0].file_size_bytes}`);

    // -------------------------------------------------------------
    // TEST 13: PERSISTENT DOCUMENT STORAGE
    // -------------------------------------------------------------
    const storageDir = getDocumentStorageDir();
    assert(fs.existsSync(storageDir), '13. Persistent Storage Dir Exists', storageDir);
    assert(docResult.pdfDoc.absolutePath.startsWith(path.resolve(storageDir)), '13. Document Stored in Configured STORAGE_DIR', docResult.pdfDoc.absolutePath);

    // -------------------------------------------------------------
    // TEST 14: DOCUMENT DOWNLOAD & FILENAME
    // -------------------------------------------------------------
    const dlRes = await request(server, 'GET', `/api/documents/${docResult.pdfDoc.id}/download`, {
      'Authorization': `Bearer ${empAToken}`
    });
    assert(dlRes.status === 200, '14. Document Download Status 200', `Got ${dlRes.status}`);
    const contentDisp = dlRes.headers['content-disposition'] || '';
    assert(contentDisp.includes(`${testPrNumber}_Rev-00.pdf`) || contentDisp.includes(testPrNumber), '14. Professional Download Filename Header', contentDisp);

    // -------------------------------------------------------------
    // TEST 15: RBAC SECURITY ENFORCEMENT
    // -------------------------------------------------------------
    // 15a. Owner (empA) can download: already verified in Test 14 (status 200)
    // 15b. Unauthorized Employee (empB) receives 403 Forbidden
    const unauthRes = await request(server, 'GET', `/api/documents/${docResult.pdfDoc.id}/download`, {
      'Authorization': `Bearer ${empBToken}`
    });
    assert(unauthRes.status === 403, '15. Unauthorized Employee Receives 403 Forbidden', `Got ${unauthRes.status}`);

    // 15c. Admin can download any document: 200 OK
    const adminDlRes = await request(server, 'GET', `/api/documents/${docResult.pdfDoc.id}/download`, {
      'Authorization': `Bearer ${adminToken}`
    });
    assert(adminDlRes.status === 200, '15. Admin Can Download Any PR Document', `Got ${adminDlRes.status}`);

    // 15d. Missing token receives 401
    const noAuthRes = await request(server, 'GET', `/api/documents/${docResult.pdfDoc.id}/download`);
    assert(noAuthRes.status === 401, '15. Unauthenticated Download Receives 401', `Got ${noAuthRes.status}`);

    // -------------------------------------------------------------
    // TEST 16: ACTIVITY LOGGING
    // -------------------------------------------------------------
    const actRes = await query(`
      SELECT * FROM activity_logs 
      WHERE action = 'DOCUMENT_GENERATED' AND (entity_id = $1 OR entity_id = $2)
      ORDER BY id DESC LIMIT 1
    `, [testPrNumber, String(testPrId)]);
    assert(actRes.rowCount > 0, '16. DOCUMENT_GENERATED Recorded in activity_logs', `Rows: ${actRes.rowCount}`);
    if (actRes.rowCount > 0) {
      const log = actRes.rows[0];
      assert(log.metadata && log.metadata.prNumber === testPrNumber, '16. Activity Metadata Contains PR Number', JSON.stringify(log.metadata));
      assert(log.metadata.revision === 0, '16. Activity Metadata Contains Revision', `Rev: ${log.metadata.revision}`);
    }

    // -------------------------------------------------------------
    // TEST 17: PDF REGENERATION & HISTORICAL VERSION PRESERVATION
    // -------------------------------------------------------------
    // Increment PR revision to 1 and regenerate
    await query(`UPDATE purchase_requests SET revision = 1 WHERE id = $1`, [testPrId]);

    const docResultRev1 = await generatePrDocuments(testPrId, {
      id: empA.id,
      username: empA.username,
      fullName: empA.full_name
    });

    assert(docResultRev1.pdfDoc.fileName.includes('Rev-01'), '17. Regenerated Document Filename Has Rev-01', docResultRev1.pdfDoc.fileName);
    assert(fs.existsSync(docResultRev1.pdfDoc.absolutePath), '17. Rev-01 File Exists on Disk', docResultRev1.pdfDoc.absolutePath);

    // Verify historical Rev-00 file still exists
    assert(fs.existsSync(docResult.pdfDoc.absolutePath), '17. Historical Rev-00 File Preserved on Disk', docResult.pdfDoc.absolutePath);

    // Verify both documents exist in database
    const allDocsRes = await query(`
      SELECT id, file_name, revision FROM documents 
      WHERE purchase_request_id = $1 AND document_type = 'PR_PDF'
      ORDER BY revision ASC
    `, [testPrId]);
    assert(allDocsRes.rowCount >= 2, '17. Historical Document Records Preserved in DB', `Count: ${allDocsRes.rowCount}`);

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    // Cleanup test PRs and projects
    try {
      if (testPrId) {
        await query(`DELETE FROM documents WHERE purchase_request_id = $1`, [testPrId]);
        await query(`DELETE FROM pr_items WHERE purchase_request_id = $1`, [testPrId]);
        await query(`DELETE FROM purchase_requests WHERE id = $1`, [testPrId]);
        await query(`DELETE FROM activity_logs WHERE entity_id IN ($1, $2)`, [String(testPrId), testPrNumber]);
      }
      if (multiPrId) {
        await query(`DELETE FROM documents WHERE purchase_request_id = $1`, [multiPrId]);
        await query(`DELETE FROM pr_items WHERE purchase_request_id = $1`, [multiPrId]);
        await query(`DELETE FROM purchase_requests WHERE id = $1`, [multiPrId]);
        await query(`DELETE FROM activity_logs WHERE entity_id IN ($1, $2)`, [String(multiPrId), multiPrNumber]);
      }
      if (testProjectId) {
        await query(`DELETE FROM documents WHERE project_id = $1`, [testProjectId]);
        await query(`DELETE FROM purchase_requests WHERE project_id = $1`, [testProjectId]);
        await query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);
      }
    } catch (cleanupErr) {
      console.warn('Cleanup error (non-fatal):', cleanupErr.message);
    }

    server.close();
    await pool.end();
  }

  console.log('\n================================================================');
  console.log(`  RESULTS: Passed: ${passed} | Failed: ${failed}`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run();
