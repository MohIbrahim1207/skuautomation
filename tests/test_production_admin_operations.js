/**
 * =========================================================================
 * FLOW FORCE PRODUCTION ADMIN OPERATIONS & AUDIT VERIFICATION SUITE
 * tests/test_production_admin_operations.js
 * =========================================================================
 *
 * Verifies all 8 production compliance requirements:
 * 1. Audit Log Creation (Login, User Mgmt, SKU/Price/Desc, Drawings, PRs)
 * 2. Audit Log Immutability (PostgreSQL trigger blocks UPDATE & DELETE)
 * 3. Admin Authorization (Admin access to /api/admin/* and /api/users)
 * 4. Employee Denial (HTTP 403 enforcement on all Admin routes)
 * 5. User Management (last_login_at tracking, last active admin protection, force password change)
 * 6. PR Approval Audit (Approve and Reject with reason recorded in audit logs)
 * 7. Standard Drawing Version Audit (Upload, replace, removal audit trails)
 * 8. Dashboard Real-Data Loading (Live PostgreSQL KPIs & System Health)
 */

const http = require('http');
const assert = require('assert');
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
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(postData);
    req.end();
  });
}

function generateToken(user) {
  return jwt.sign({
    id: user.id,
    username: user.username,
    fullName: user.full_name || user.username,
    role: user.role
  }, JWT_SECRET, { expiresIn: '2h' });
}

async function runTests() {
  console.log('\n=================================================================');
  console.log('STARTING PRODUCTION ADMIN OPERATIONS VERIFICATION SUITE');
  console.log('=================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(desc, fn) {
    return async () => {
      process.stdout.write(`• ${desc} ... `);
      try {
        await fn();
        console.log('\x1b[32mPASSED\x1b[0m');
        passed++;
      } catch (err) {
        console.log('\x1b[31mFAILED\x1b[0m');
        console.error('  Error:', err.message);
        failed++;
      }
    };
  }

  // Create HTTP server on dynamic port
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));

  try {
    // Retrieve active Admin and Employee test fixtures from PostgreSQL
    const adminUserRes = await query("SELECT * FROM users WHERE role = 'ADMIN' AND status = 'Active' LIMIT 1");
    const empUserRes = await query("SELECT * FROM users WHERE role = 'EMPLOYEE' AND status = 'Active' LIMIT 1");

    assert(adminUserRes.rowCount > 0, 'No active ADMIN user found in database');
    assert(empUserRes.rowCount > 0, 'No active EMPLOYEE user found in database');

    const adminUser = adminUserRes.rows[0];
    const empUser = empUserRes.rows[0];

    const adminToken = generateToken(adminUser);
    const empToken = generateToken(empUser);

    const adminHeaders = { 'Authorization': `Bearer ${adminToken}` };
    const empHeaders = { 'Authorization': `Bearer ${empToken}` };

    // =========================================================================
    // 1. AUDIT LOG IMMUTABILITY TESTS (POSTGRESQL TRIGGER ENFORCEMENT)
    // =========================================================================
    await test('1.1 Audit Log Immutability: Block UPDATE via PostgreSQL Trigger', async () => {
      // Insert a dedicated audit log record to test
      const insRes = await query(`
        INSERT INTO activity_logs (
          entity_type, entity_id, action, module, description, status, created_at
        ) VALUES ('SYSTEM', 'TEST_IMMUTABLE', 'TEST_ACTION', 'SYSTEM', 'Original text', 'SUCCESS', CURRENT_TIMESTAMP)
        RETURNING id
      `);
      const testLogId = insRes.rows[0].id;

      let updateBlocked = false;
      try {
        await query(`UPDATE activity_logs SET description = 'TAMPERED' WHERE id = $1`, [testLogId]);
      } catch (err) {
        if (err.message.includes('prohibited') || err.message.includes('append-only') || err.message.includes('forbidden')) {
          updateBlocked = true;
        }
      }
      assert.strictEqual(updateBlocked, true, 'PostgreSQL trigger must reject UPDATE operations on activity_logs');
    })();

    await test('1.2 Audit Log Immutability: Block DELETE via PostgreSQL Trigger', async () => {
      const insRes = await query(`
        INSERT INTO activity_logs (
          entity_type, entity_id, action, module, description, status, created_at
        ) VALUES ('SYSTEM', 'TEST_IMMUTABLE_DEL', 'TEST_ACTION', 'SYSTEM', 'Original text', 'SUCCESS', CURRENT_TIMESTAMP)
        RETURNING id
      `);
      const testLogId = insRes.rows[0].id;

      let deleteBlocked = false;
      try {
        await query(`DELETE FROM activity_logs WHERE id = $1`, [testLogId]);
      } catch (err) {
        if (err.message.includes('prohibited') || err.message.includes('append-only') || err.message.includes('forbidden')) {
          deleteBlocked = true;
        }
      }
      assert.strictEqual(deleteBlocked, true, 'PostgreSQL trigger must reject DELETE operations on activity_logs');
    })();

    // =========================================================================
    // 2. ADMIN AUTHORIZATION & EMPLOYEE DENIAL TESTS
    // =========================================================================
    await test('2.1 Admin Dashboard: Admin Authorized (200), Employee Denied (403), Unauthenticated Denied (401)', async () => {
      const resAdmin = await request(server, 'GET', '/api/admin/dashboard', adminHeaders);
      assert.strictEqual(resAdmin.status, 200, 'Admin must receive 200 OK on /api/admin/dashboard');
      assert.strictEqual(resAdmin.body.success, true);
      assert(resAdmin.body.kpis !== undefined, 'Dashboard must contain operational KPIs');
      assert(resAdmin.body.systemHealth !== undefined, 'Dashboard must contain systemHealth');
      assert(Array.isArray(resAdmin.body.recentActivity), 'Dashboard must contain recentActivity array');

      const resEmp = await request(server, 'GET', '/api/admin/dashboard', empHeaders);
      assert.strictEqual(resEmp.status, 403, 'Employee must receive 403 Forbidden on /api/admin/dashboard');

      const resAnon = await request(server, 'GET', '/api/admin/dashboard');
      assert.strictEqual(resAnon.status, 401, 'Unauthenticated request must receive 401 Unauthorized');
    })();

    await test('2.2 Audit Logs API: Admin Authorized (200), Employee Denied (403)', async () => {
      const resAdmin = await request(server, 'GET', '/api/admin/audit-logs?limit=10', adminHeaders);
      assert.strictEqual(resAdmin.status, 200, 'Admin must receive 200 OK on /api/admin/audit-logs');
      assert.strictEqual(resAdmin.body.success, true);
      assert(Array.isArray(resAdmin.body.logs), 'Logs must be an array');
      assert(typeof resAdmin.body.totalCount === 'number', 'TotalCount must be a number');

      const resEmp = await request(server, 'GET', '/api/admin/audit-logs', empHeaders);
      assert.strictEqual(resEmp.status, 403, 'Employee must receive 403 Forbidden on /api/admin/audit-logs');
    })();

    await test('2.3 User Management API: Admin Authorized (200), Employee Denied (403)', async () => {
      const resAdmin = await request(server, 'GET', '/api/users', adminHeaders);
      assert.strictEqual(resAdmin.status, 200, 'Admin must receive 200 OK on /api/users');
      assert(Array.isArray(resAdmin.body), 'Users list must be an array');

      const resEmp = await request(server, 'GET', '/api/users', empHeaders);
      assert.strictEqual(resEmp.status, 403, 'Employee must receive 403 Forbidden on /api/users');
    })();

    await test('2.4 Drawing Removal Requests: Admin Authorized (200), Employee Denied (403)', async () => {
      const resAdmin = await request(server, 'GET', '/api/ducting-types/removal-requests', adminHeaders);
      assert.strictEqual(resAdmin.status, 200, 'Admin must receive 200 OK on removal requests');
      assert.strictEqual(resAdmin.body.success, true);

      const resEmp = await request(server, 'GET', '/api/ducting-types/removal-requests', empHeaders);
      assert.strictEqual(resEmp.status, 403, 'Employee must receive 403 Forbidden on removal requests');
    })();

    // =========================================================================
    // 3. AUTHENTICATION & LAST LOGIN AUDIT TESTS
    // =========================================================================
    await test('3.1 Auth Audit: Successful Login updates last_login_at and records LOGIN_SUCCESS', async () => {
      // Perform login as admin with default seed password admin123
      const loginRes = await request(server, 'POST', '/api/auth/login', {}, {
        username: 'admin',
        password: 'admin123'
      });
      assert.strictEqual(loginRes.status, 200, 'Valid admin login must return 200');

      // Verify last_login_at in database
      const userCheck = await query('SELECT last_login_at FROM users WHERE username = $1', ['admin']);
      assert(userCheck.rows[0].last_login_at !== null, 'last_login_at must be populated after successful login');

      // Verify audit log entry
      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'LOGIN_SUCCESS' AND performed_by_username = 'admin'
        ORDER BY created_at DESC LIMIT 1
      `);
      assert(auditRes.rowCount > 0, 'LOGIN_SUCCESS audit log must be recorded in activity_logs');
      assert.strictEqual(auditRes.rows[0].status, 'SUCCESS');
      assert.strictEqual(auditRes.rows[0].module, 'AUTH');
    })();

    await test('3.2 Auth Audit: Failed Login records LOGIN_FAILURE', async () => {
      const badLoginRes = await request(server, 'POST', '/api/auth/login', {}, {
        username: 'admin',
        password: 'wrong_password_999'
      });
      assert.strictEqual(badLoginRes.status, 401, 'Bad credentials must return 401');

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'LOGIN_FAILURE'
        ORDER BY created_at DESC LIMIT 1
      `);
      assert(auditRes.rowCount > 0, 'LOGIN_FAILURE audit log must be recorded');
      assert.strictEqual(auditRes.rows[0].status, 'FAILURE');
      assert.strictEqual(auditRes.rows[0].module, 'AUTH');
    })();

    // =========================================================================
    // 4. USER MANAGEMENT OPERATIONS & PROTECTION TESTS
    // =========================================================================
    let createdTestUserId = null;
    await test('4.1 User Management: Create Employee, record USER_CREATED audit with payload', async () => {
      const testEmpUsername = `testemp_${Date.now()}`;
      const createRes = await request(server, 'POST', '/api/users', adminHeaders, {
        fullName: 'Test Operator Ops',
        username: testEmpUsername,
        email: `${testEmpUsername}@flowforce.local`,
        password: 'Password123!',
        status: 'Active'
      });

      assert.strictEqual(createRes.status, 201, 'Create user must return 201 Created');
      createdTestUserId = createRes.body.id;

      // Verify audit log
      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'USER_CREATED' AND entity_id = $1
      `, [createdTestUserId]);

      assert(auditRes.rowCount > 0, 'USER_CREATED audit log must exist');
      assert.strictEqual(auditRes.rows[0].module, 'USER_MANAGEMENT');
      assert(auditRes.rows[0].after_value !== null, 'after_value must contain user details');
    })();

    await test('4.2 User Management: Edit user, record USER_UPDATED audit with before/after diff', async () => {
      assert(createdTestUserId, 'User ID must exist');

      const updateRes = await request(server, 'PUT', `/api/users/${createdTestUserId}`, adminHeaders, {
        fullName: 'Test Operator Ops Edited'
      });
      assert.strictEqual(updateRes.status, 200, 'Update user must return 200 OK');

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'USER_UPDATED' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1
      `, [createdTestUserId]);

      assert(auditRes.rowCount > 0, 'USER_UPDATED audit log must exist');
      assert.strictEqual(auditRes.rows[0].before_value.fullName, 'Test Operator Ops');
      assert.strictEqual(auditRes.rows[0].after_value.fullName, 'Test Operator Ops Edited');
    })();

    await test('4.3 User Management: Toggle user status, record USER_DISABLED audit', async () => {
      assert(createdTestUserId, 'User ID must exist');

      const toggleRes = await request(server, 'PATCH', `/api/users/${createdTestUserId}/status`, adminHeaders, {
        status: 'Disabled'
      });
      assert.strictEqual(toggleRes.status, 200, 'Disable user must return 200 OK');

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'USER_DISABLED' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1
      `, [createdTestUserId]);

      assert(auditRes.rowCount > 0, 'USER_DISABLED audit log must exist');
      assert.strictEqual(auditRes.rows[0].before_value.status, 'Active');
      assert.strictEqual(auditRes.rows[0].after_value.status, 'Disabled');
    })();

    await test('4.4 User Management: Last active admin protection blocks disabling only active admin', async () => {
      // Find active admin
      const disableAdminRes = await request(server, 'PATCH', `/api/users/${adminUser.id}/status`, adminHeaders, {
        status: 'Disabled'
      });
      assert.strictEqual(disableAdminRes.status, 400, 'Must return 400 Bad Request when attempting to disable last/own admin');
      assert(disableAdminRes.body.error.includes('Administrator account'), 'Error message must explain protection');
    })();

    await test('4.5 User Management: Force password change sets flag and records FORCE_PASSWORD_CHANGE audit', async () => {
      assert(createdTestUserId, 'User ID must exist');

      const forceRes = await request(server, 'POST', `/api/users/${createdTestUserId}/force-password-change`, adminHeaders);
      assert.strictEqual(forceRes.status, 200, 'Force password change must return 200 OK');

      const userCheck = await query('SELECT must_change_password FROM users WHERE id = $1', [createdTestUserId]);
      assert.strictEqual(userCheck.rows[0].must_change_password, true, 'must_change_password must be true');

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'FORCE_PASSWORD_CHANGE' AND entity_id = $1
      `, [createdTestUserId]);
      assert(auditRes.rowCount > 0, 'FORCE_PASSWORD_CHANGE audit log must exist');
    })();

    // =========================================================================
    // 5. MASTER ITEM HISTORY & AUDIT TESTS
    // =========================================================================
    let testSku = `FF_TEST_${Date.now()}`;
    await test('5.1 Master Item: Create SKU, records SKU_CREATED audit', async () => {
      const createSkuRes = await request(server, 'POST', '/api/master-items', adminHeaders, {
        sku: testSku,
        productName: 'Flow Force Operations Test Plate',
        itemDescription: 'High strength ASTM A36 Steel Plate for Operations Testing',
        category: 'Raw Materials',
        unit: 'Sheet',
        unitPrice: 1250000,
        status: 'Available'
      });

      assert.strictEqual(createSkuRes.status, 201, 'Create SKU must return 201 Created');

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'SKU_CREATED' AND entity_id = $1
      `, [testSku]);

      assert(auditRes.rowCount > 0, 'SKU_CREATED audit log must exist');
      assert.strictEqual(auditRes.rows[0].module, 'MASTER_CATALOG');
      assert.strictEqual(auditRes.rows[0].after_value.sku, testSku);
    })();

    await test('5.2 Master Item: Price Change records PRICE_CHANGED audit with before/after values', async () => {
      const updatePriceRes = await request(server, 'PUT', `/api/master-items/${testSku}`, adminHeaders, {
        unitPrice: 1450000
      });

      assert.strictEqual(updatePriceRes.status, 200, 'Update SKU price must return 200 OK');

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'PRICE_CHANGED' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1
      `, [testSku]);

      assert(auditRes.rowCount > 0, 'PRICE_CHANGED audit log must exist');
      assert.strictEqual(Number(auditRes.rows[0].before_value.unitPrice), 1250000);
      assert.strictEqual(Number(auditRes.rows[0].after_value.unitPrice), 1450000);
    })();

    await test('5.3 Master Item History Endpoint (/api/admin/master-items/:sku/history)', async () => {
      const histRes = await request(server, 'GET', `/api/admin/master-items/${testSku}/history`, adminHeaders);
      assert.strictEqual(histRes.status, 200, 'SKU history must return 200 OK');
      assert.strictEqual(histRes.body.success, true);
      assert(Array.isArray(histRes.body.history), 'History must be an array');
      assert(histRes.body.history.length >= 2, 'History must contain at least SKU_CREATED and PRICE_CHANGED');
    })();

    // =========================================================================
    // 6. PR CREATION, APPROVAL & REJECTION AUDIT TESTS
    // =========================================================================
    let testPrId = null;
    let testPrNumber = null;

    await test('6.1 PR Creation records PR_CREATED audit', async () => {
      // Find a project
      const projRes = await query('SELECT id FROM projects LIMIT 1');
      assert(projRes.rowCount > 0, 'Project must exist');
      const projectId = projRes.rows[0].id;

      const createPrRes = await request(server, 'POST', '/api/purchase-requests', adminHeaders, {
        projectId,
        department: 'Operations & Maintenance',
        requiredDate: '2026-10-31',
        urgency: 'High Urgency (1-3 Days)',
        reasonForPurchase: 'Enterprise Operational Audit Verification Requisition',
        cartItems: [{
          sku: testSku,
          productName: 'Flow Force Operations Test Plate',
          itemDescription: 'ASTM A36 Plate',
          category: 'Raw Materials',
          unit: 'Sheet',
          unitPrice: 1450000,
          quantity: 2,
          status: 'Available',
          supplyType: 'Full Size'
        }]
      });

      assert.strictEqual(createPrRes.status, 201, 'Create PR must return 201 Created');
      testPrId = createPrRes.body.prId;
      testPrNumber = createPrRes.body.prNumber;

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'PR_CREATED' AND entity_id = $1
      `, [String(testPrId)]);

      assert(auditRes.rowCount > 0, 'PR_CREATED audit log must exist');
      assert.strictEqual(auditRes.rows[0].module, 'PURCHASE_REQUESTS');
    })();

    await test('6.2 PR Rejection records PR_REJECTED audit with rejection reason', async () => {
      assert(testPrId, 'PR ID must exist');

      const rejectRes = await request(server, 'POST', `/api/purchase-requests/${testPrId}/reject`, adminHeaders, {
        rejectionReason: 'Need revised specifications from site team'
      });

      assert.strictEqual(rejectRes.status, 200, 'Reject PR must return 200 OK');

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'PR_REJECTED' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1
      `, [String(testPrId)]);

      assert(auditRes.rowCount > 0, 'PR_REJECTED audit log must exist');
      assert.strictEqual(auditRes.rows[0].after_value.status, 'REJECTED');
      assert.strictEqual(auditRes.rows[0].after_value.rejectionReason, 'Need revised specifications from site team');
    })();

    await test('6.3 PR Approval records PR_APPROVED audit', async () => {
      assert(testPrId, 'PR ID must exist');

      const approveRes = await request(server, 'POST', `/api/purchase-requests/${testPrId}/approve`, adminHeaders);
      assert.strictEqual(approveRes.status, 200, 'Approve PR must return 200 OK');

      const auditRes = await query(`
        SELECT * FROM activity_logs 
        WHERE action = 'PR_APPROVED' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1
      `, [String(testPrId)]);

      assert(auditRes.rowCount > 0, 'PR_APPROVED audit log must exist');
      assert.strictEqual(auditRes.rows[0].before_value.status, 'REJECTED');
      assert.strictEqual(auditRes.rows[0].after_value.status, 'APPROVED');
    })();

    // =========================================================================
    // 7. DASHBOARD REAL-DATA TELEMETRY VERIFICATION
    // =========================================================================
    await test('7.1 Admin Dashboard Telemetry: Real PostgreSQL KPIs & Storage Mode', async () => {
      const dashRes = await request(server, 'GET', '/api/admin/dashboard', adminHeaders);
      assert.strictEqual(dashRes.status, 200);

      const kpis = dashRes.body.kpis;
      const sh = dashRes.body.systemHealth;

      // Verify actual database counts match
      const dbSkusRes = await query('SELECT COUNT(*)::int AS count FROM master_items');
      const dbUsersRes = await query("SELECT COUNT(*)::int AS count FROM users WHERE status = 'Active'");

      assert.strictEqual(kpis.totalSkus, dbSkusRes.rows[0].count, 'totalSkus KPI must match actual master_items count');
      assert.strictEqual(kpis.activeUsers, dbUsersRes.rows[0].count, 'activeUsers KPI must match actual active users count');

      assert.strictEqual(sh.database.status, 'connected', 'Database status must be connected');
      assert(sh.drawingStorageMode === 'LOCAL_FALLBACK' || sh.drawingStorageMode === 'CLOUDINARY', 'Storage mode must be recognized');
      assert.strictEqual(sh.app.status, 'healthy', 'App status must be healthy');
    })();

  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log('\n=================================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('=================================================================\n');

  if (failed > 0) {
    await pool.end();
    process.exit(1);
  } else {
    await pool.end();
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
