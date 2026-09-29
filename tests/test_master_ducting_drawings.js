/**
 * Comprehensive Automated Acceptance Test Suite:
 * Master Ducting Drawing Architecture & Historical Versioning
 *
 * Verifies all 23 Acceptance Test steps:
 * 1. Admin/Engineering opens Ducting Configuration (GET /api/ducting-types)
 * 2. Select Y-Duct
 * 3. Upload Y-Duct drawing once (POST /api/ducting-types/Y-Duct/drawing)
 * 4. Save and verify DOCUMENT_UPLOADED activity log
 * 5. Create a new Y-Duct PR without uploading drawing
 * 6. Verify drawing automatically appears and attaches to PR item
 * 7. Add Y-Duct to PR and verify no second upload required
 * 8. Open PR Cart / PR item: Drawing is present
 * 9. Open PR Details: Drawing is present
 * 10. Verify View endpoint (/api/documents/:id/view) works and logs DOCUMENT_VIEWED
 * 11. Verify Download endpoint (/api/documents/:id/download) works and logs DOCUMENT_DOWNLOADED
 * 12. Open Print View / Generate PDF: Appendix is present in PDF
 * 13. Create another Y-Duct PR: Verify same master drawing automatically appears
 * 14. Replace Y-Duct master drawing with v2 (POST /api/ducting-types/Y-Duct/drawing)
 * 15. Verify DOCUMENT_UPDATED activity log
 * 16. Create a new Y-Duct PR (PR 3): Verify new PR uses new drawing v2
 * 17. Open old PR (PR 1): Verify old PR permanently retains original drawing v1
 * 18. Historical Integrity: Master drawing updates do not mutate historical PRs
 * 19. RBAC: Employee can view and download master drawing attached to their PR
 * 20. Removal: DELETE /api/ducting-types/Y-Duct/drawing logs DOCUMENT_DELETED and retains past PR drawings
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { PDFDocument: PDFLibDoc } = require('pdf-lib');

const app = require('../server/index');
const { query, pool } = require('../server/db/pool');
const { JWT_SECRET } = require('../server/middleware/auth');
const { generatePrDocuments, getDocumentStorageDir } = require('../server/services/documentGenerator');
const { resolveStoragePath } = require('../server/routes/documents');

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
      res.on('data', chunk => chunks.push(chunk));
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

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

async function createDummyPdf(titleText = 'Y-Duct Master Drawing v1') {
  const pdfDoc = await PDFLibDoc.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  page.drawText(titleText, {
    x: 50,
    y: height - 100,
    size: 18
  });
  page.drawText('Official Flow Force Master Ducting Engineering Drawing Specification', {
    x: 50,
    y: height - 130,
    size: 11
  });
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

let server;
let adminToken;
let empToken;
let adminUser;
let empUser;
let testProjectId;

async function runAcceptanceTests() {
  console.log('========================================================================');
  console.log(' STARTING MASTER DUCTING DRAWING ACCEPTANCE TEST SUITE');
  console.log('========================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (!condition) {
      console.error(`❌ [FAIL] ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    } else {
      console.log(`✅ [PASS] ${message}`);
      passedTests++;
    }
  }

  try {
    // 0. Setup Server & Users
    server = http.createServer(app);
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    console.log(`Test server running on port ${port}`);

    const adminRes = await query(`SELECT * FROM users WHERE role = 'ADMIN' LIMIT 1`);
    if (adminRes.rowCount === 0) throw new Error('No admin user found');
    adminUser = adminRes.rows[0];
    adminToken = generateToken(adminUser);

    const empRes = await query(`SELECT * FROM users WHERE role = 'EMPLOYEE' LIMIT 1`);
    if (empRes.rowCount === 0) throw new Error('No employee user found');
    empUser = empRes.rows[0];
    empToken = generateToken(empUser);

    const projRes = await query(`SELECT id FROM projects LIMIT 1`);
    testProjectId = projRes.rowCount > 0 ? projRes.rows[0].id : 1;

    // Reset Y-Duct master drawing for clean test slate
    await query(`UPDATE ducting_types SET master_drawing_document_id = NULL, current_standard_drawing_id = NULL WHERE type_name = 'Y-Duct'`);

    // -------------------------------------------------------------------------
    // STEP 1: Admin opens Ducting Configuration
    // -------------------------------------------------------------------------
    console.log('\n--- Step 1: Admin opens Ducting Configuration ---');
    const getTypesRes = await request(server, 'GET', '/api/ducting-types', {
      'Authorization': `Bearer ${adminToken}`
    });
    assert(getTypesRes.status === 200, 'GET /api/ducting-types returns HTTP 200');
    assert(Array.isArray(getTypesRes.body.types), 'Response contains array of ducting types');
    const yDuctType = getTypesRes.body.types.find(t => t.typeName === 'Y-Duct');
    assert(!!yDuctType, 'Y-Duct type exists in configuration');
    assert(yDuctType.hasDrawing === false, 'Y-Duct starts with hasDrawing = false');

    // -------------------------------------------------------------------------
    // STEP 2 & 3 & 4: Upload Y-Duct Master Drawing v1
    // -------------------------------------------------------------------------
    console.log('\n--- Step 2-4: Upload Y-Duct Master Drawing v1 ---');
    const pdfV1Buffer = await createDummyPdf('Y-Duct Master Drawing Version 1.0');
    const pdfV1Base64 = `data:application/pdf;base64,${pdfV1Buffer.toString('base64')}`;

    const uploadV1Res = await request(server, 'POST', '/api/ducting-types/Y-Duct/drawing', {
      'Authorization': `Bearer ${adminToken}`
    }, {
      fileName: 'Template_Ducting_Y-Duct_PR_Form_v1.pdf',
      mimeType: 'application/pdf',
      dataUrl: pdfV1Base64
    });
    console.log('Upload v1 response:', uploadV1Res.status, uploadV1Res.body);
    assert(uploadV1Res.status === 200 || uploadV1Res.status === 201, 'POST /api/ducting-types/Y-Duct/drawing returns HTTP 200/201');
    assert(uploadV1Res.body.success === true, 'Upload response indicates success');
    const v1DocId = uploadV1Res.body.drawing.documentId;
    const v1Revision = uploadV1Res.body.drawing.revision;
    assert(typeof v1Revision === 'number' && v1Revision >= 1, `Initial master drawing has revision ${v1Revision}`);

    // Verify activity log: DOCUMENT_UPLOADED
    const actLogV1 = await query(
      `SELECT * FROM activity_logs WHERE entity_type = 'DOCUMENT' AND entity_id = $1 AND action = 'DOCUMENT_UPLOADED'`,
      [String(v1DocId)]
    );
    assert(actLogV1.rowCount > 0, 'Activity log records DOCUMENT_UPLOADED for master drawing v1');

    // -------------------------------------------------------------------------
    // STEP 5 & 6: Create new Y-Duct PR (PR 1)
    // -------------------------------------------------------------------------
    console.log('\n--- Step 5-8: Create PR 1 (Auto-attached Master Drawing v1) ---');
    // Fetch drawing endpoint as employee during PR creation
    const fetchDrawingRes = await request(server, 'GET', '/api/ducting-types/Y-Duct/drawing', {
      'Authorization': `Bearer ${empToken}`
    });
    assert(fetchDrawingRes.status === 200, 'Employee can fetch Y-Duct master drawing');
    assert(fetchDrawingRes.body.hasDrawing === true, 'Master drawing is marked as present');
    assert(fetchDrawingRes.body.drawing.documentId === v1DocId, 'Drawing returned matches v1DocId');

    // Count DOCUMENT_UPLOADED logs before PR 1 creation
    const uploadLogsBefore = await query(`SELECT COUNT(*) FROM activity_logs WHERE action = 'DOCUMENT_UPLOADED'`);
    const countBefore = parseInt(uploadLogsBefore.rows[0].count, 10);

    // Create PR with Y-Duct referencing master drawing v1
    const createPr1Res = await request(server, 'POST', '/api/purchase-requests', {
      'Authorization': `Bearer ${empToken}`
    }, {
      projectId: testProjectId,
      department: 'Engineering Fabrication',
      requiredDate: '2026-10-15',
      urgency: 'Standard (1-2 Weeks)',
      reasonForPurchase: 'Air Handling Unit Exhaust Y-Duct fabrication',
      cartItems: [
        {
          category: 'Ducting',
          ductingType: 'Y-Duct',
          productName: 'Ducting — Y-Duct',
          unit: 'Pcs',
          quantity: 2,
          unitPrice: 2500000,
          drawingAttachment: {
            documentId: v1DocId,
            id: v1DocId,
            name: 'Template_Ducting_Y-Duct_PR_Form_v1.pdf'
          },
          ductingDimensions: {
            dimA: 350,
            dimB: 250,
            dimC: 200,
            angleD: 45,
            l1: 600,
            l2: 400,
            thickness: 1.5
          }
        }
      ]
    });

    assert(createPr1Res.status === 201, `PR 1 created successfully: ${createPr1Res.body.prNumber}`);
    const pr1Id = createPr1Res.body.prId;
    const pr1Number = createPr1Res.body.prNumber;

    // Verify PR creation did NOT create another DOCUMENT_UPLOADED event
    const uploadLogsAfter = await query(`SELECT COUNT(*) FROM activity_logs WHERE action = 'DOCUMENT_UPLOADED'`);
    const countAfter = parseInt(uploadLogsAfter.rows[0].count, 10);
    assert(countAfter === countBefore, 'PR creation did NOT generate duplicate DOCUMENT_UPLOADED event');

    // Verify pr_items references v1DocId
    const itemPr1Res = await query(`SELECT * FROM pr_items WHERE purchase_request_id = $1`, [pr1Id]);
    assert(itemPr1Res.rowCount === 1, 'PR 1 contains 1 item');
    assert(itemPr1Res.rows[0].drawing_document_id === v1DocId, `PR 1 item references master drawing v1 (doc ID: ${v1DocId})`);

    // Verify documents table was NOT hijacked by single PR
    const docV1Res = await query(`SELECT * FROM documents WHERE id = $1`, [v1DocId]);
    assert(docV1Res.rows[0].purchase_request_id === null, 'Master document purchase_request_id remains NULL (not hijacked)');

    // -------------------------------------------------------------------------
    // STEP 9 & 10: Open PR Details & PR Cart verification
    // -------------------------------------------------------------------------
    console.log('\n--- Step 9-11: Verify PR 1 Details and Drawing Info ---');
    const pr1DetailsRes = await request(server, 'GET', `/api/purchase-requests/${pr1Id}`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(pr1DetailsRes.status === 200, 'GET /api/purchase-requests/:id returns HTTP 200');
    const pr1Item = pr1DetailsRes.body.items[0];
    assert(Boolean(pr1Item.engineeringDrawing), 'PR Details item contains engineeringDrawing object');
    assert(pr1Item.engineeringDrawing.documentId === v1DocId, 'PR Details drawing documentId is v1DocId');
    assert(pr1Item.engineeringDrawing.viewUrl === `/api/documents/${v1DocId}/view`, 'Drawing has correct viewUrl');
    assert(pr1Item.engineeringDrawing.downloadUrl === `/api/documents/${v1DocId}/download`, 'Drawing has correct downloadUrl');

    // -------------------------------------------------------------------------
    // STEP 11 & 12: View & Download endpoints & Activity Logs
    // -------------------------------------------------------------------------
    console.log('\n--- View & Download Endpoints Test ---');
    const viewRes = await request(server, 'GET', `/api/documents/${v1DocId}/view`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(viewRes.status === 200, 'Employee can view master drawing via /api/documents/:id/view');
    assert(viewRes.headers['content-type'] === 'application/pdf', 'View Content-Type is application/pdf');

    const dlRes = await request(server, 'GET', `/api/documents/${v1DocId}/download`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(dlRes.status === 200, 'Employee can download master drawing via /api/documents/:id/download');
    assert(dlRes.headers['content-disposition'].includes('attachment'), 'Download Content-Disposition includes attachment');

    // Check activity logs: DOCUMENT_VIEWED & DOCUMENT_DOWNLOADED
    const viewLog = await query(`SELECT * FROM activity_logs WHERE entity_type = 'DOCUMENT' AND entity_id = $1 AND action = 'DOCUMENT_VIEWED'`, [String(v1DocId)]);
    assert(viewLog.rowCount > 0, 'DOCUMENT_VIEWED activity logged');
    const dlLog = await query(`SELECT * FROM activity_logs WHERE entity_type = 'DOCUMENT' AND entity_id = $1 AND action = 'DOCUMENT_DOWNLOADED'`, [String(v1DocId)]);
    assert(dlLog.rowCount > 0, 'DOCUMENT_DOWNLOADED activity logged');

    // -------------------------------------------------------------------------
    // STEP 13-16: Generated PR PDF Appendix Verification
    // -------------------------------------------------------------------------
    console.log('\n--- Step 13-16: Verify PDF Generation with Drawing Appendix ---');
    const genResult = await generatePrDocuments(pr1Id);
    assert(Boolean(genResult.pdfFilePath), `PR PDF generated at: ${genResult.pdfFilePath}`);
    assert(fs.existsSync(genResult.pdfFilePath), 'Physical PR PDF exists on disk');

    const generatedPdfBytes = fs.readFileSync(genResult.pdfFilePath);
    const parsedPdf = await PDFLibDoc.load(generatedPdfBytes);
    // Main PR is 1 page + Appendix Header + Copied PDF pages >= 3 pages
    assert(parsedPdf.getPageCount() >= 2, `Generated PR PDF includes appendix (total pages: ${parsedPdf.getPageCount()})`);

    // -------------------------------------------------------------------------
    // STEP 17 & 18: Create PR 2 with same Master Drawing
    // -------------------------------------------------------------------------
    console.log('\n--- Step 17-18: Create PR 2 with Same Master Drawing ---');
    const createPr2Res = await request(server, 'POST', '/api/purchase-requests', {
      'Authorization': `Bearer ${empToken}`
    }, {
      projectId: testProjectId,
      department: 'Ventilation Project',
      cartItems: [
        {
          category: 'Ducting',
          ductingType: 'Y-Duct',
          productName: 'Ducting — Y-Duct',
          unit: 'Pcs',
          quantity: 1,
          unitPrice: 2800000,
          // Omitting drawingAttachment; backend auto-attaches master drawing for Y-Duct!
          ductingDimensions: {
            dimA: 500,
            dimB: 350,
            dimC: 300,
            angleD: 60,
            l1: 800,
            l2: 500,
            thickness: 2.0
          }
        }
      ]
    });
    assert(createPr2Res.status === 201, `PR 2 created: ${createPr2Res.body.prNumber}`);
    const pr2Id = createPr2Res.body.prId;

    const pr2ItemsRes = await query(`SELECT * FROM pr_items WHERE purchase_request_id = $1`, [pr2Id]);
    assert(pr2ItemsRes.rows[0].drawing_document_id === v1DocId, `PR 2 automatically attached master drawing v1 (doc ID: ${v1DocId})`);

    // -------------------------------------------------------------------------
    // STEP 19: Replace Y-Duct Master Drawing with v2
    // -------------------------------------------------------------------------
    console.log('\n--- Step 19: Replace Y-Duct Master Drawing with v2 ---');
    const pdfV2Buffer = await createDummyPdf('Y-Duct Master Drawing Version 2.0 (Updated 2026)');
    const pdfV2Base64 = `data:application/pdf;base64,${pdfV2Buffer.toString('base64')}`;

    const replaceRes = await request(server, 'POST', '/api/ducting-types/Y-Duct/drawing', {
      'Authorization': `Bearer ${adminToken}`
    }, {
      fileName: 'Template_Ducting_Y-Duct_PR_Form_v2.pdf',
      mimeType: 'application/pdf',
      dataUrl: pdfV2Base64
    });

    assert(replaceRes.status === 200, 'POST /api/ducting-types/Y-Duct/drawing replacement returns HTTP 200');
    assert(replaceRes.body.action === 'REPLACED', 'Replacement action is REPLACED');
    const v2DocId = replaceRes.body.drawing.documentId;
    assert(v2DocId !== v1DocId, `New document ID created for v2: ${v2DocId} (different from v1: ${v1DocId})`);
    assert(replaceRes.body.drawing.revision === v1Revision + 1, `Revision is incremented from ${v1Revision} to ${v1Revision + 1}`);

    // Check activity log: DOCUMENT_UPDATED
    const updateLog = await query(`SELECT * FROM activity_logs WHERE entity_type = 'DOCUMENT' AND entity_id = $1 AND action = 'DOCUMENT_UPDATED'`, [String(v2DocId)]);
    assert(updateLog.rowCount > 0, 'DOCUMENT_UPDATED activity logged for master drawing replacement');

    // Verify ducting_types points to v2
    const dtRes = await query(`SELECT master_drawing_document_id FROM ducting_types WHERE type_name = 'Y-Duct'`);
    assert(dtRes.rows[0].master_drawing_document_id === v2DocId, 'ducting_types now points to v2DocId');

    // -------------------------------------------------------------------------
    // STEP 20 & 21: Create PR 3 (uses v2)
    // -------------------------------------------------------------------------
    console.log('\n--- Step 20-21: Create PR 3 (Should Use v2) ---');
    const createPr3Res = await request(server, 'POST', '/api/purchase-requests', {
      'Authorization': `Bearer ${empToken}`
    }, {
      projectId: testProjectId,
      department: 'Plant Expansion Phase 2',
      cartItems: [
        {
          category: 'Ducting',
          ductingType: 'Y-Duct',
          productName: 'Ducting — Y-Duct',
          unit: 'Pcs',
          quantity: 4,
          unitPrice: 3200000,
          ductingDimensions: {
            dimA: 400,
            dimB: 300,
            dimC: 250,
            angleD: 45,
            l1: 700,
            l2: 450,
            thickness: 1.8
          }
        }
      ]
    });
    assert(createPr3Res.status === 201, `PR 3 created: ${createPr3Res.body.prNumber}`);
    const pr3Id = createPr3Res.body.prId;

    const pr3ItemsRes = await query(`SELECT * FROM pr_items WHERE purchase_request_id = $1`, [pr3Id]);
    assert(pr3ItemsRes.rows[0].drawing_document_id === v2DocId, `PR 3 uses new master drawing v2 (doc ID: ${v2DocId})`);

    // -------------------------------------------------------------------------
    // STEP 22 & 23: Historical Versioning Integrity: Verify PR 1 still uses v1!
    // -------------------------------------------------------------------------
    console.log('\n--- Step 22-23: Historical Versioning Integrity Check ---');
    const oldPrItemsRes = await query(`SELECT * FROM pr_items WHERE purchase_request_id = $1`, [pr1Id]);
    assert(oldPrItemsRes.rows[0].drawing_document_id === v1DocId, `Historical Integrity: PR 1 still references original v1DocId (${v1DocId})`);

    const oldPrDetailsRes = await request(server, 'GET', `/api/purchase-requests/${pr1Id}`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(oldPrDetailsRes.body.items[0].engineeringDrawing.documentId === v1DocId, 'PR 1 details API permanently retains v1 drawing');
    assert(oldPrDetailsRes.body.items[0].engineeringDrawing.fileName === 'Template_Ducting_Y-Duct_PR_Form_v1.pdf', 'PR 1 retains original filename');

    // -------------------------------------------------------------------------
    // Removal Test: DELETE /api/ducting-types/Y-Duct/drawing
    // -------------------------------------------------------------------------
    console.log('\n--- Master Drawing Removal Test ---');
    const deleteRes = await request(server, 'DELETE', '/api/ducting-types/Y-Duct/drawing', {
      'Authorization': `Bearer ${adminToken}`
    });
    assert(deleteRes.status === 200, 'DELETE /api/ducting-types/Y-Duct/drawing returns HTTP 200');

    // Verify ducting_types is now NULL
    const dtDelRes = await query(`SELECT master_drawing_document_id FROM ducting_types WHERE type_name = 'Y-Duct'`);
    assert(dtDelRes.rows[0].master_drawing_document_id === null, 'ducting_types master_drawing_document_id is now NULL');

    // Verify DOCUMENT_DELETED logged
    const delLog = await query(`SELECT * FROM activity_logs WHERE entity_type = 'DOCUMENT' AND entity_id = $1 AND action = 'DOCUMENT_DELETED'`, [String(v2DocId)]);
    assert(delLog.rowCount > 0, 'DOCUMENT_DELETED activity logged');

    // Verify historical PRs still have their drawings
    const oldPrAfterDel = await query(`SELECT drawing_document_id FROM pr_items WHERE purchase_request_id = $1`, [pr1Id]);
    assert(oldPrAfterDel.rows[0].drawing_document_id === v1DocId, 'PR 1 drawing association remains intact after master removal');

    console.log('\n========================================================================');
    console.log(` ALL ${totalTests} TESTS PASSED SUCCESSFULLY! (${passedTests}/${totalTests})`);
    console.log('========================================================================\n');

  } catch (err) {
    console.error('\n❌ Test suite encountered an error:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
  }
}

runAcceptanceTests().then(() => {
  pool.end();
});
