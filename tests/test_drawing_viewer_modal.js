/**
 * =========================================================================
 * TEST SUITE: ENGINEERING DRAWING FULL PDF & DOCUMENT VIEWER
 * Verifies:
 * 1. Dedicated modal UI (#modalDrawingViewer) in index.html with all required elements
 * 2. DocumentViewer controller implementation and export in app.js
 * 3. UI.viewDrawingDocument integration across all PR locations
 * 4. DuctingWorkflowController.openFullDrawing and viewDrawing integration
 * 5. PR Cart and PR Details interactive thumbnail previews with expand badge
 * 6. Server GET /api/documents/:id/view (HTTP 200, inline, Content-Type application/pdf)
 * 7. Server GET /api/documents/:id/download (HTTP 200, attachment)
 * 8. Authentication & RBAC security (401 unauth, 403 unauthorized, 200 authorized)
 * 9. Activity logs: DOCUMENT_VIEWED and DOCUMENT_DOWNLOADED
 * =========================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { query } = require('../server/db/pool');
const app = require('../server/index');

let server;
let port;
let baseUrl;

function request(serverInstance, method, requestPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(requestPath, baseUrl);
    const reqHeaders = { ...headers };
    let payload = null;

    if (body) {
      if (typeof body === 'object' && !(body instanceof Buffer)) {
        payload = JSON.stringify(body);
        reqHeaders['Content-Type'] = 'application/json';
      } else {
        payload = body;
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
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
          body: json,
          rawBuffer: rawBuffer,
          text: rawBuffer.toString('utf8')
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${message}`);
    throw new Error(message);
  }
  console.log(`  ✓ PASS: ${message}`);
}

async function runTests() {
  console.log('=========================================================================');
  console.log('ENGINEERING DRAWING FULL VIEWER & PDF MODAL INTEGRATION TEST');
  console.log('=========================================================================\n');

  server = http.createServer(app);
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`Test server running on port ${port}\n`);
      resolve();
    });
  });

  try {
    // -----------------------------------------------------------------------
    // PART 1: FRONTEND HTML & JS STATIC VERIFICATION
    // -----------------------------------------------------------------------
    console.log('--- PART 1: Verify Modal Markup in index.html ---');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

    assert(indexHtml.includes('id="modalDrawingViewer"'), 'Modal #modalDrawingViewer exists in index.html');
    assert(indexHtml.includes('id="drawingViewerTitle"'), 'Modal has #drawingViewerTitle');
    assert(indexHtml.includes('id="drawingViewerTypeBadge"'), 'Modal has #drawingViewerTypeBadge');
    assert(indexHtml.includes('id="drawingViewerMeta"'), 'Modal has #drawingViewerMeta');
    assert(indexHtml.includes('id="drawingViewerLoading"'), 'Modal has #drawingViewerLoading spinner');
    assert(indexHtml.includes('id="drawingViewerError"'), 'Modal has #drawingViewerError fallback container');
    assert(indexHtml.includes('id="drawingViewerContent"'), 'Modal has #drawingViewerContent viewer area');
    assert(indexHtml.includes('id="btnDrawingViewerDownload"'), 'Modal header has #btnDrawingViewerDownload');
    assert(indexHtml.includes('id="btnDrawingViewerNewTab"'), 'Modal header has #btnDrawingViewerNewTab');
    assert(indexHtml.includes('DocumentViewer.close()'), 'Modal close button invokes DocumentViewer.close()');

    console.log('\n--- PART 2: Verify DocumentViewer Implementation in app.js ---');
    const appJs = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

    assert(appJs.includes('window.DocumentViewer = DocumentViewer'), 'app.js exports window.DocumentViewer');
    assert(appJs.includes('async open(docOrItem)'), 'DocumentViewer implements open(docOrItem)');
    assert(appJs.includes('renderViewer(srcUrl, isPdf, fileName)'), 'DocumentViewer implements renderViewer()');
    assert(appJs.includes('showError(title, message)'), 'DocumentViewer implements showError()');
    assert(appJs.includes('retry()'), 'DocumentViewer implements retry()');
    assert(appJs.includes('downloadCurrent()'), 'DocumentViewer implements downloadCurrent()');
    assert(appJs.includes('openInNewTab()'), 'DocumentViewer implements openInNewTab()');
    assert(appJs.includes('cleanupBlob()'), 'DocumentViewer implements cleanupBlob()');
    assert(appJs.includes('close()'), 'DocumentViewer implements close()');
    assert(appJs.includes('Escape'), 'DocumentViewer has Escape key listener');

    console.log('\n--- PART 3: Verify Integration Across All Locations ---');
    assert(appJs.includes('viewDrawingDocument(docOrId)'), 'UI implements viewDrawingDocument(docOrId)');
    assert(appJs.includes('DocumentViewer.open(docOrId)'), 'UI.viewDrawingDocument routes to DocumentViewer.open()');
    assert(appJs.includes('DuctingWorkflowController.openFullDrawing'), 'DuctingWorkflowController has openFullDrawing()');
    assert(appJs.includes('DocumentViewer.open(up)'), 'openFullDrawing() routes to DocumentViewer.open()');
    assert(appJs.includes('DocumentViewer.open(drw)'), 'viewDrawing() routes to DocumentViewer.open()');
    assert(appJs.includes('onclick="DuctingWorkflowController.viewDrawing(${idx})"'), 'PR Cart thumbnail is clickable to open full viewer');
    assert(appJs.includes('onclick="UI.viewDrawingDocument(${docId})"'), 'PR Details thumbnail is clickable to open full viewer');

    // -----------------------------------------------------------------------
    // PART 4: BACKEND AUTHENTICATION & SECURE DOCUMENT ENDPOINTS
    // -----------------------------------------------------------------------
    console.log('\n--- PART 4: Test Upload, View & Download Endpoints ---');

    // Admin login
    const adminLoginRes = await request(server, 'POST', '/api/auth/login', {}, {
      username: 'admin',
      password: 'admin123'
    });
    assert(adminLoginRes.statusCode === 200, 'Admin login succeeded');
    const adminToken = adminLoginRes.body.token;

    // Employee login
    const empLoginRes = await request(server, 'POST', '/api/auth/login', {}, {
      username: 'employee',
      password: 'employee123'
    });
    assert(empLoginRes.statusCode === 200, 'Employee login succeeded');
    const empToken = empLoginRes.body.token;

    // Upload a real PDF drawing (PR-Form-20260925.pdf)
    const dummyPdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 55 >>
stream
BT
/F1 14 Tf
72 712 Td
(ENGINEERING DRAWING PR-Form-20260925) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000204 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
310
%%EOF`;

    const pdfBase64 = Buffer.from(dummyPdfContent).toString('base64');
    const uploadRes = await request(server, 'POST', '/api/documents/upload-drawing', {
      'Authorization': `Bearer ${empToken}`
    }, {
      fileName: 'PR-Form-20260925.pdf',
      mimeType: 'application/pdf',
      dataUrl: `data:application/pdf;base64,${pdfBase64}`
    });

    assert(uploadRes.statusCode === 201, 'Upload PR-Form-20260925.pdf returned HTTP 201');
    const drawingDoc = uploadRes.body.document;
    assert(drawingDoc.id > 0, `Generated document ID is ${drawingDoc.id}`);
    assert(drawingDoc.fileName === 'PR-Form-20260925.pdf', 'Document fileName preserved');
    assert(drawingDoc.viewUrl === `/api/documents/${drawingDoc.id}/view`, 'viewUrl matches format');
    assert(drawingDoc.downloadUrl === `/api/documents/${drawingDoc.id}/download`, 'downloadUrl matches format');

    // 1. GET /api/documents/:id/view - Test standard authenticated view
    const viewRes = await request(server, 'GET', `/api/documents/${drawingDoc.id}/view`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(viewRes.statusCode === 200, 'GET /api/documents/:id/view returns HTTP 200');
    assert(viewRes.headers['content-type'].includes('application/pdf'), 'Content-Type is application/pdf');
    assert(viewRes.headers['content-disposition'].includes('inline'), 'Content-Disposition is inline');
    assert(viewRes.rawBuffer.toString('utf8').includes('%PDF-1.4'), 'Response contains authentic PDF binary payload');

    // 2. GET /api/documents/:id/view?token=... - Test URL query token mechanism for iframes / new tabs
    const viewQueryRes = await request(server, 'GET', `/api/documents/${drawingDoc.id}/view?token=${encodeURIComponent(empToken)}`);
    assert(viewQueryRes.statusCode === 200, 'GET view with query ?token= returns HTTP 200');
    assert(viewQueryRes.headers['content-disposition'].includes('inline'), 'Query token response has inline Content-Disposition');

    // 3. GET /api/documents/:id/download - Test standard download
    const downloadRes = await request(server, 'GET', `/api/documents/${drawingDoc.id}/download`, {
      'Authorization': `Bearer ${empToken}`
    });
    assert(downloadRes.statusCode === 200, 'GET /api/documents/:id/download returns HTTP 200');
    assert(downloadRes.headers['content-disposition'].includes('attachment'), 'Content-Disposition is attachment');
    assert(downloadRes.headers['content-disposition'].includes('PR-Form-20260925.pdf'), 'Filename preserved in attachment header');

    // -----------------------------------------------------------------------
    // PART 5: SECURITY & RBAC ENFORCEMENT
    // -----------------------------------------------------------------------
    console.log('\n--- PART 5: Security & RBAC Enforcement ---');

    // Unauthenticated request should be rejected with 401
    const unauthRes = await request(server, 'GET', `/api/documents/${drawingDoc.id}/view`);
    assert(unauthRes.statusCode === 401, 'Unauthenticated request returns HTTP 401 Unauthorized');

    // Admin access should be granted with 200
    const adminViewRes = await request(server, 'GET', `/api/documents/${drawingDoc.id}/view`, {
      'Authorization': `Bearer ${adminToken}`
    });
    assert(adminViewRes.statusCode === 200, 'Admin can view document (HTTP 200)');

    // Another employee access should be rejected with 403
    // Create another employee if not exists
    const otherEmpCheck = await query(`SELECT id FROM users WHERE username = 'emp_other'`);
    let otherEmpId;
    if (otherEmpCheck.rowCount === 0) {
      const insRes = await query(`
        INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
        VALUES ('USR-999', 'Other Employee', 'emp_other', 'other@flowforce.local', '$2a$10$wK1W6QY1e21bWjMv2k1KMeW8uQZ0wG9w8V3y9/2n4bW6g7Y1q23.', 'EMPLOYEE', 'Active', false)
        RETURNING id
      `);
      otherEmpId = insRes.rows[0].id;
    } else {
      otherEmpId = otherEmpCheck.rows[0].id;
    }

    const otherEmpToken = require('jsonwebtoken').sign(
      { id: otherEmpId, username: 'emp_other', role: 'EMPLOYEE' },
      process.env.JWT_SECRET || 'flowforce_dev_secret_jwt_key_2026_super_secure',
      { expiresIn: '1h' }
    );

    const forbiddenViewRes = await request(server, 'GET', `/api/documents/${drawingDoc.id}/view`, {
      'Authorization': `Bearer ${otherEmpToken}`
    });
    assert(forbiddenViewRes.statusCode === 403, 'Unauthorized employee is denied access (HTTP 403 Forbidden)');

    // -----------------------------------------------------------------------
    // PART 6: AUDIT TRAIL / ACTIVITY LOGGING
    // -----------------------------------------------------------------------
    console.log('\n--- PART 6: Activity Logging ---');
    const logsRes = await query(`
      SELECT action, entity_type, entity_id
      FROM activity_logs
      WHERE entity_type = 'DOCUMENT' AND entity_id = $1
      ORDER BY id DESC
      LIMIT 10
    `, [String(drawingDoc.id)]);

    const actions = logsRes.rows.map(r => r.action);
    assert(actions.includes('DOCUMENT_UPLOADED'), 'Audit log recorded DOCUMENT_UPLOADED');
    assert(actions.includes('DOCUMENT_VIEWED'), 'Audit log recorded DOCUMENT_VIEWED');
    assert(actions.includes('DOCUMENT_DOWNLOADED'), 'Audit log recorded DOCUMENT_DOWNLOADED');

    console.log('\n=========================================================================');
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    console.log('=========================================================================\n');
  } finally {
    if (server) {
      server.close();
    }
  }
}

runTests().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
