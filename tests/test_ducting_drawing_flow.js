/**
 * Comprehensive Automated Test Suite: Ducting Engineering Drawing Flow
 * 
 * Verifies all requirements from prompt:
 *  1. Engineering drawing upload (PDF & Image) via /api/documents/upload-drawing
 *  2. PR Item drawing persistence & database association (pr_items.drawing_document_id, documents.purchase_request_item_id)
 *  3. Drawing is project/PR-specific (does NOT create MasterItem or Global SKU)
 *  4. PR details API returns engineeringDrawing object on PR items
 *  5. Multiple PR items maintain separate drawings (no cross-contamination)
 *  6. Generated PR PDF appends Engineering Drawing Appendix losslessly
 *  7. View & Download endpoints with correct headers and Content-Disposition
 *  8. RBAC security enforcement (Admin, Owner, Unauthorized 403/401)
 *  9. Activity Logs record DOCUMENT_UPLOADED, DOCUMENT_VIEWED, DOCUMENT_DOWNLOADED
 * 10. File persistence in persistent storage directory (STORAGE_DIR)
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
    mustChangePassword: user.must_change_password || false
  }, JWT_SECRET, { expiresIn: '2h' });
}

// Minimal valid single-page PDF generator for test fixture
async function createTestPdfBuffer(title = 'Test Engineering Drawing') {
  const doc = await PDFLibDoc.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(title, { x: 50, y: 750, size: 18 });
  page.drawRectangle({ x: 50, y: 300, width: 400, height: 200, borderWidth: 2 });
  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

// 1x1 transparent PNG buffer for image test fixture
function createTestPngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
}

async function runTests() {
  console.log('=========================================================================');
  console.log('DUCTING ENGINEERING DRAWING FULL INTEGRATION & PERSISTENCE TEST SUITE');
  console.log('=========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  console.log(`Test server running on port ${port}\n`);

  try {
    // 1. Fetch Users & Projects
    const adminRes = await query(`SELECT * FROM users WHERE role = 'ADMIN' LIMIT 1`);
    const empRes = await query(`SELECT * FROM users WHERE role = 'EMPLOYEE' LIMIT 1`);
    const emp2Res = await query(`SELECT * FROM users WHERE role = 'EMPLOYEE' AND id != $1 LIMIT 1`, [empRes.rows[0].id]);
    const projRes = await query(`SELECT * FROM projects LIMIT 1`);

    assert(adminRes.rowCount > 0, 'Admin user exists in database');
    assert(empRes.rowCount > 0, 'Employee user exists in database');
    assert(projRes.rowCount > 0, 'Project exists in database');

    const admin = adminRes.rows[0];
    const employee = empRes.rows[0];
    const otherEmployee = emp2Res.rowCount > 0 ? emp2Res.rows[0] : null;
    const project = projRes.rows[0];

    const adminToken = makeToken(admin);
    const empToken = makeToken(employee);
    const otherEmpToken = otherEmployee ? makeToken(otherEmployee) : null;

    // -------------------------------------------------------------------------
    // TEST 1: Upload Engineering Drawing PDF
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 1: Upload Engineering Drawing PDF via /api/documents/upload-drawing ---');
    const testPdfBuf = await createTestPdfBuffer('Straight Duct Engineering Specification Drawing');
    const pdfDataUrl = `data:application/pdf;base64,${testPdfBuf.toString('base64')}`;

    const uploadPdfRes = await request(server, 'POST', '/api/documents/upload-drawing', {
      'Authorization': `Bearer ${empToken}`
    }, {
      fileName: 'Template Ducting Straight PR Form.pdf',
      mimeType: 'application/pdf',
      dataUrl: pdfDataUrl,
      projectId: project.id
    });

    assert(uploadPdfRes.status === 201, `Upload PDF returned HTTP 201 Created (got ${uploadPdfRes.status})`);
    assert(uploadPdfRes.body && uploadPdfRes.body.document, 'Response contains document object');
    const pdfDoc = uploadPdfRes.body.document;
    assert(pdfDoc.id > 0, `Generated document ID: ${pdfDoc.id}`);
    assert(pdfDoc.mimeType === 'application/pdf', `MIME type is application/pdf`);
    assert(pdfDoc.viewUrl === `/api/documents/${pdfDoc.id}/view`, 'Correct viewUrl returned');
    assert(pdfDoc.downloadUrl === `/api/documents/${pdfDoc.id}/download`, 'Correct downloadUrl returned');

    // Verify physical file on disk in persistent storage
    const docDbRes = await query(`SELECT * FROM documents WHERE id = $1`, [pdfDoc.id]);
    assert(docDbRes.rowCount === 1, 'Document record persisted in documents table');
    assert(docDbRes.rows[0].document_type === 'ENGINEERING_DRAWING', 'document_type is ENGINEERING_DRAWING');
    const resolvedPdfPath = resolveStoragePath(docDbRes.rows[0].file_path_or_storage_key);
    assert(fs.existsSync(resolvedPdfPath), `Physical drawing PDF exists at: ${resolvedPdfPath}`);

    // -------------------------------------------------------------------------
    // TEST 2: Upload Engineering Drawing PNG Image
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Upload Engineering Drawing Image (PNG) ---');
    const testPngBuf = createTestPngBuffer();
    const pngDataUrl = `data:image/png;base64,${testPngBuf.toString('base64')}`;

    const uploadPngRes = await request(server, 'POST', '/api/documents/upload-drawing', {
      'Authorization': `Bearer ${empToken}`
    }, {
      fileName: 'Elbow_Sketch_Drawing.png',
      mimeType: 'image/png',
      dataUrl: pngDataUrl,
      projectId: project.id
    });

    assert(uploadPngRes.status === 201, `Upload PNG returned HTTP 201 (got ${uploadPngRes.status})`);
    const pngDoc = uploadPngRes.body.document;
    assert(pngDoc.id > 0, `Generated image document ID: ${pngDoc.id}`);
    const pngDbRes = await query(`SELECT * FROM documents WHERE id = $1`, [pngDoc.id]);
    const resolvedPngPath = resolveStoragePath(pngDbRes.rows[0].file_path_or_storage_key);
    assert(fs.existsSync(resolvedPngPath), `Physical drawing image exists at: ${resolvedPngPath}`);

    // -------------------------------------------------------------------------
    // TEST 3: Validation - Reject Unsupported Formats & Empty Payloads
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Validation - Reject Invalid Formats ---');
    const badUploadRes = await request(server, 'POST', '/api/documents/upload-drawing', {
      'Authorization': `Bearer ${empToken}`
    }, {
      fileName: 'script.exe',
      mimeType: 'application/x-msdownload',
      dataUrl: 'data:application/x-msdownload;base64,AQID',
      projectId: project.id
    });
    assert(badUploadRes.status === 400, `Rejected .exe file with HTTP 400 (got ${badUploadRes.status})`);

    // -------------------------------------------------------------------------
    // TEST 4: Create PR with Multiple Items and Verify Isolation
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Create PR with Multiple Items (Straight Duct, Elbow, Standard Item) ---');
    // Pre-check count of MasterItems to ensure ducting drawings do NOT create master items
    const initialMasterCountRes = await query(`SELECT COUNT(*) FROM master_items`);
    const initialMasterCount = parseInt(initialMasterCountRes.rows[0].count, 10);

    const prPayload = {
      projectId: project.id,
      department: 'Engineering & Design',
      requiredDate: '2026-10-15',
      urgency: 'Standard (1-2 Weeks)',
      reasonForPurchase: 'Air ventilation system installation phase 1',
      remarks: 'Engineering drawings attached for custom ducting items',
      cartItems: [
        // Item 1: Straight Duct with attached PDF drawing
        {
          category: 'Ducting',
          ductingType: 'Straight Duct',
          productName: 'Ducting — Straight Duct',
          material: 'GI',
          materialGrade: 'GI',
          unit: 'Pcs',
          quantity: 2,
          unitPrice: 350000,
          purchaseType: 'PROJECT-SPECIFIC DUCTING',
          ductingDimensions: {
            dimA: 300,
            l1: 1000,
            thickness: 1.2
          },
          drawingAttachment: {
            documentId: pdfDoc.id,
            id: pdfDoc.id,
            name: 'Template Ducting Straight PR Form.pdf',
            fileName: 'Template Ducting Straight PR Form.pdf',
            size: testPdfBuf.length,
            type: 'application/pdf'
          }
        },
        // Item 2: Elbow with attached PNG image drawing
        {
          category: 'Ducting',
          ductingType: 'Elbow',
          productName: 'Ducting — Elbow',
          material: 'SUS304',
          materialGrade: 'SUS304',
          unit: 'Pcs',
          quantity: 4,
          unitPrice: 450000,
          purchaseType: 'PROJECT-SPECIFIC DUCTING',
          ductingDimensions: {
            dimA: 250,
            angleB: 90,
            radius: 375,
            thickness: 1.5
          },
          drawingAttachment: {
            documentId: pngDoc.id,
            id: pngDoc.id,
            name: 'Elbow_Sketch_Drawing.png',
            fileName: 'Elbow_Sketch_Drawing.png',
            size: testPngBuf.length,
            type: 'image/png'
          }
        },
        // Item 3: Standard Item with NO drawing
        {
          category: 'Fasteners',
          productName: 'Hex Bolt M12 x 50 mm',
          itemDescription: 'Standard Galvanized Grade 8.8 Hex Bolt',
          material: 'SS400',
          size: 'M12 x 50 mm',
          unit: 'Pcs',
          quantity: 100,
          unitPrice: 5000,
          purchaseType: 'STANDARD STOCK ITEM',
          drawingAttachment: null
        }
      ]
    };

    const createPrRes = await request(server, 'POST', '/api/purchase-requests', {
      'Authorization': `Bearer ${empToken}`
    }, prPayload);

    assert(createPrRes.status === 201, `Create PR returned HTTP 201 (got ${createPrRes.status})`);
    assert(createPrRes.body && createPrRes.body.prId, `PR ID returned: ${createPrRes.body.prId}`);
    const prId = createPrRes.body.prId;
    const prNumber = createPrRes.body.prNumber;

    // Verify master items count did NOT increase
    const postMasterCountRes = await query(`SELECT COUNT(*) FROM master_items`);
    const postMasterCount = parseInt(postMasterCountRes.rows[0].count, 10);
    assert(postMasterCount === initialMasterCount, `MasterItem count unchanged (${initialMasterCount} items; no global SKU created for ducting)`);

    // -------------------------------------------------------------------------
    // TEST 5: Verify Drawing Persistence & Linkage in Database
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Verify Drawing Persistence & Linkage in Database ---');
    const itemsDbRes = await query(`SELECT * FROM pr_items WHERE purchase_request_id = $1 ORDER BY id ASC`, [prId]);
    assert(itemsDbRes.rowCount === 3, 'Created exactly 3 PR items');

    const it1 = itemsDbRes.rows[0];
    const it2 = itemsDbRes.rows[1];
    const it3 = itemsDbRes.rows[2];

    assert(it1.drawing_document_id === pdfDoc.id, `Item 1 linked to drawing document #${pdfDoc.id}`);
    assert(it2.drawing_document_id === pngDoc.id, `Item 2 linked to drawing document #${pngDoc.id}`);
    assert(it3.drawing_document_id === null, 'Item 3 drawing_document_id is NULL (no drawing)');

    // Verify documents table updated with purchase_request_id and purchase_request_item_id
    const doc1Check = await query(`SELECT * FROM documents WHERE id = $1`, [pdfDoc.id]);
    assert(doc1Check.rows[0].purchase_request_id === prId, `Document 1 purchase_request_id linked to PR #${prId}`);
    assert(doc1Check.rows[0].purchase_request_item_id === it1.id, `Document 1 purchase_request_item_id linked to Item #${it1.id}`);

    // -------------------------------------------------------------------------
    // TEST 6: PR Details API Response Structure (Section 16)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: PR Details API Response Structure ---');
    const getPrRes = await request(server, 'GET', `/api/purchase-requests/${prId}`, {
      'Authorization': `Bearer ${empToken}`
    });

    assert(getPrRes.status === 200, `GET /api/purchase-requests/${prId} returned HTTP 200`);
    assert(getPrRes.body && getPrRes.body.items, 'Response contains items array');
    const apiItems = getPrRes.body.items;

    // Item 1: Straight Duct
    assert(apiItems[0].ductingType === 'Straight Duct', 'Item 1 ductingType matches');
    assert(apiItems[0].engineeringDrawing !== null, 'Item 1 has engineeringDrawing object');
    assert(apiItems[0].engineeringDrawing.id === pdfDoc.id, 'Item 1 drawing ID matches');
    assert(apiItems[0].engineeringDrawing.fileName === 'Template Ducting Straight PR Form.pdf', 'Item 1 drawing fileName matches');
    assert(apiItems[0].engineeringDrawing.mimeType === 'application/pdf', 'Item 1 drawing mimeType is application/pdf');
    assert(apiItems[0].engineeringDrawing.viewUrl === `/api/documents/${pdfDoc.id}/view`, 'Item 1 drawing viewUrl matches');
    assert(apiItems[0].engineeringDrawing.downloadUrl === `/api/documents/${pdfDoc.id}/download`, 'Item 1 drawing downloadUrl matches');

    // Item 2: Elbow
    assert(apiItems[1].ductingType === 'Elbow', 'Item 2 ductingType matches');
    assert(apiItems[1].engineeringDrawing !== null, 'Item 2 has engineeringDrawing object');
    assert(apiItems[1].engineeringDrawing.id === pngDoc.id, 'Item 2 drawing ID matches');
    assert(apiItems[1].engineeringDrawing.fileName === 'Elbow_Sketch_Drawing.png', 'Item 2 drawing fileName matches');
    assert(apiItems[1].engineeringDrawing.mimeType === 'image/png', 'Item 2 drawing mimeType is image/png');

    // Item 3: Standard Stock Item
    assert(apiItems[2].engineeringDrawing === null, 'Item 3 engineeringDrawing is NULL (isolated from other items)');

    // -------------------------------------------------------------------------
    // TEST 7: Generated PR PDF Embedding & Appendix (Sections 9, 10, 11)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 7: Generated PR PDF Embedding & Appendix ---');
    const pdfDocRes = await query(
      `SELECT * FROM documents WHERE purchase_request_id = $1 AND document_type = 'PR_PDF'`,
      [prId]
    );
    assert(pdfDocRes.rowCount > 0, 'PR PDF generated and registered in documents table');
    const prPdfRecord = pdfDocRes.rows[0];
    const generatedPdfPath = resolveStoragePath(prPdfRecord.file_path_or_storage_key);
    assert(fs.existsSync(generatedPdfPath), `Generated PR PDF exists on disk: ${generatedPdfPath}`);

    const prPdfBytes = fs.readFileSync(generatedPdfPath);
    assert(prPdfBytes.slice(0, 4).toString('ascii') === '%PDF', 'Generated PDF has valid %PDF magic bytes');

    // Load PDF with pdf-lib to verify it parses and has appendix pages
    const parsedPdf = await PDFLibDoc.load(prPdfBytes);
    const pageCount = parsedPdf.getPageCount();
    console.log(`  ℹ Total pages in generated PR PDF: ${pageCount}`);
    // Base PR is at least 1 page + 1 page for PDF appendix header + 1 page for drawing PDF + 1 page for Image appendix = >= 3 pages
    assert(pageCount >= 3, `PR PDF has multiple pages (${pageCount} pages) including Drawing Appendix`);

    // Verify SHA-256 matches actual file on disk
    const expectedSha = crypto.createHash('sha256').update(prPdfBytes).digest('hex');
    assert(prPdfRecord.sha256_checksum === expectedSha, 'Database SHA-256 matches physical file on disk');

    // -------------------------------------------------------------------------
    // TEST 8: Document View & Download Endpoints
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 8: Document View & Download Endpoints ---');
    // View PDF Drawing
    const viewRes = await request(server, 'GET', `/api/documents/${pdfDoc.id}/view`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(viewRes.status === 200, `View PDF returned HTTP 200 (got ${viewRes.status})`);
    assert(viewRes.headers['content-type'] === 'application/pdf', `Content-Type is application/pdf`);
    assert(viewRes.headers['content-disposition'].includes('inline'), `Content-Disposition is inline`);

    // View with Query Token (Direct Browser Tab / Iframe)
    const viewQueryRes = await request(server, 'GET', `/api/documents/${pdfDoc.id}/view?token=${encodeURIComponent(empToken)}`);
    assert(viewQueryRes.status === 200, `View with URL query token returned HTTP 200`);

    // Download PDF Drawing
    const dlRes = await request(server, 'GET', `/api/documents/${pdfDoc.id}/download`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(dlRes.status === 200, `Download PDF returned HTTP 200 (got ${dlRes.status})`);
    assert(dlRes.headers['content-disposition'].includes('attachment'), `Content-Disposition is attachment`);
    assert(dlRes.headers['content-disposition'].includes('Template_Ducting_Straight_PR_Form.pdf'), 'Download filename preserved safely');

    // -------------------------------------------------------------------------
    // TEST 9: RBAC Security Enforcement (Section 13)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 9: RBAC Security Enforcement ---');
    // Unauthenticated request
    const noAuthRes = await request(server, 'GET', `/api/documents/${pdfDoc.id}/view`);
    assert(noAuthRes.status === 401, `Unauthenticated request returned HTTP 401 Unauthorized (got ${noAuthRes.status})`);

    // Admin can access employee's drawing
    const adminAccessRes = await request(server, 'GET', `/api/documents/${pdfDoc.id}/view`, {
      'Authorization': `Bearer ${adminToken}`
    });
    assert(adminAccessRes.status === 200, `Admin can access authorized drawing (HTTP 200)`);

    // Other employee cannot access if not their PR
    if (otherEmpToken) {
      const unauthorizedRes = await request(server, 'GET', `/api/documents/${pdfDoc.id}/view`, {
        'Authorization': `Bearer ${otherEmpToken}`
      });
      assert(unauthorizedRes.status === 403, `Unauthorized employee returned HTTP 403 Forbidden (got ${unauthorizedRes.status})`);
    } else {
      console.log('  ℹ Skipping other employee 403 check (single employee in test db)');
    }

    // -------------------------------------------------------------------------
    // TEST 10: Activity Logging (Section 19)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 10: Activity Logging ---');
    const logsRes = await query(
      `SELECT action, metadata FROM activity_logs WHERE entity_type = 'DOCUMENT' ORDER BY created_at DESC LIMIT 10`
    );
    const actions = logsRes.rows.map(r => r.action);
    console.log('  Recent document activity actions:', actions);

    assert(actions.includes('DOCUMENT_UPLOADED'), 'DOCUMENT_UPLOADED action logged');
    assert(actions.includes('DOCUMENT_VIEWED'), 'DOCUMENT_VIEWED action logged');
    assert(actions.includes('DOCUMENT_DOWNLOADED'), 'DOCUMENT_DOWNLOADED action logged');

    // -------------------------------------------------------------------------
    // TEST 11: Inline Base64 Drawing Upload via Cart (Fallback Flow)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 11: Inline Base64 Drawing Upload via Cart (Fallback Flow) ---');
    const inlinePdfBuf = await createTestPdfBuffer('Inline Drawing Test Specification');
    const inlineDataUrl = `data:application/pdf;base64,${inlinePdfBuf.toString('base64')}`;

    const inlinePrPayload = {
      projectId: project.id,
      department: 'Engineering & Design',
      requiredDate: '2026-10-20',
      urgency: 'Standard (1-2 Weeks)',
      reasonForPurchase: 'Inline drawing submission test',
      remarks: 'Testing un-pre-uploaded inline dataUrl submission',
      cartItems: [
        {
          category: 'Ducting',
          ductingType: 'Straight Duct',
          productName: 'Ducting — Straight Duct Inline',
          material: 'GI',
          quantity: 1,
          unitPrice: 200000,
          purchaseType: 'PROJECT-SPECIFIC DUCTING',
          ductingDimensions: {
            dimA: 400,
            l1: 1200,
            thickness: 1.0
          },
          drawingAttachment: {
            name: 'Inline_Straight_Duct.pdf',
            size: inlinePdfBuf.length,
            type: 'application/pdf',
            dataUrl: inlineDataUrl
          }
        }
      ]
    };

    const inlinePrRes = await request(server, 'POST', '/api/purchase-requests', {
      'Authorization': `Bearer ${empToken}`
    }, inlinePrPayload);

    assert(inlinePrRes.status === 201, `Inline PR created successfully (HTTP 201)`);
    const inlinePrDetails = await request(server, 'GET', `/api/purchase-requests/${inlinePrRes.body.prId}`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(inlinePrDetails.body.items[0].engineeringDrawing !== null, 'Inline drawing was automatically persisted and linked to PR item');
    assert(inlinePrDetails.body.items[0].engineeringDrawing.fileName === 'Inline_Straight_Duct.pdf', 'Inline drawing fileName matches');

    console.log('\n=========================================================================');
    console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('=========================================================================\n');

  } catch (err) {
    console.error('Test suite error:', err);
    failed++;
  } finally {
    server.close();
    await pool.end();
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
