/**
 * =========================================================================
 * FLOW FORCE ENTERPRISE SKU & PR AUTOMATION PORTAL - SERVER
 * Node.js / Express.js Backend + PostgreSQL Storage
 * =========================================================================
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { query } = require('./db/pool');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ensure base storage directory exists
const STORAGE_DIR = process.env.STORAGE_DIR || './storage';
const absStorageDir = path.join(process.cwd(), STORAGE_DIR);
if (!fs.existsSync(absStorageDir)) {
  fs.mkdirSync(absStorageDir, { recursive: true });
}

// Health Check API (supports both /health and /api/health)
const handleHealthCheck = async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({
      status: 'ok',
      service: 'Flow Force Enterprise Portal API',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      service: 'Flow Force Enterprise Portal API',
      database: 'unavailable',
      message: 'Database connection unavailable. Please contact the administrator.',
      timestamp: new Date().toISOString()
    });
  }
};
app.get('/health', handleHealthCheck);
app.get('/api/health', handleHealthCheck);

// Mount Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/master-items', require('./routes/masterItems'));
app.use('/api/purchase-requests', require('./routes/purchaseRequests'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/import-submissions', require('./routes/importSubmissions'));

// Serve Static Frontend Assets (no-cache for real-time frontend updates)
app.use(express.static(path.join(__dirname, '..'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

// Fallback for Single Page App
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  res.sendFile(path.join(__dirname, '../index.html'));
});

// Auto-run idempotent migrations on startup to guarantee all columns exist
const runStartupMigrations = async () => {
  try {
    await query(`
      ALTER TABLE master_items ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Available';
      ALTER TABLE master_items ADD COLUMN IF NOT EXISTS supply_type VARCHAR(50) DEFAULT 'Full Size';
      ALTER TABLE master_items ADD COLUMN IF NOT EXISTS remarks TEXT DEFAULT '';
      UPDATE master_items SET status = 'Available' WHERE status IS NULL OR status NOT IN ('Available', 'Out of Stock');
      UPDATE master_items SET supply_type = 'Full Size' WHERE supply_type IS NULL OR supply_type NOT IN ('Full Size', 'Cut Size');
      UPDATE master_items SET remarks = '' WHERE remarks IS NULL;

      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Available';
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS supply_type VARCHAR(50) DEFAULT 'Full Size';
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS cut_length VARCHAR(100) DEFAULT '';
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS cut_width VARCHAR(100) DEFAULT '';
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS remarks TEXT DEFAULT '';
      UPDATE pr_items SET status = 'Available' WHERE status IS NULL OR status NOT IN ('Available', 'Out of Stock');
      UPDATE pr_items SET supply_type = 'Full Size' WHERE supply_type IS NULL OR supply_type NOT IN ('Full Size', 'Cut Size');
      UPDATE pr_items SET remarks = '' WHERE remarks IS NULL;
    `);
    console.log('✅ [DB] Verified schema (Status: Available/Out of Stock, Supply Type: Full Size/Cut Size, Remarks)');

    // Ensure initial seed users exist in PostgreSQL (ADMIN: admin, EMPLOYEE: employee)
    await ensureSeedUsers();

    // Check if master_items has items; populate from raw_materials_master.json if empty
    const checkItems = await query('SELECT COUNT(*) FROM master_items');
    if (parseInt(checkItems.rows[0].count, 10) === 0) {
      const masterJsonPath = path.join(__dirname, '../raw_materials_master.json');
      if (fs.existsSync(masterJsonPath)) {
        const rawMaterials = JSON.parse(fs.readFileSync(masterJsonPath, 'utf8'));
        for (const item of rawMaterials) {
          await query(
            `INSERT INTO master_items (
              sku, product_name, item_description, category, sub_category, 
              material, size, specification, unit, weight_kg, status, supply_type, remarks, brand, unit_price, source_sheet
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            ON CONFLICT (sku) DO NOTHING`,
            [
              item.sku,
              item.productName,
              item.itemDescription || item.productName,
              item.category || 'Raw Materials',
              item.subCategory || null,
              item.material || null,
              item.size || null,
              item.specification || null,
              item.unit || 'Sheet',
              item.weightKg || null,
              (item.status === 'Out of Stock' ? 'Out of Stock' : 'Available'),
              (item.supplyType === 'Cut Size' ? 'Cut Size' : 'Full Size'),
              item.remarks || '',
              item.brand || 'PT Persada Nusantara Steel',
              item.unitPrice || null,
              item.sourceSheet || 'Catalog'
            ]
          );
        }
        console.log(`✅ [DB] Populated master_items from raw_materials_master.json (${rawMaterials.length} items).`);
      }
    }
  } catch (err) {
    console.warn('[DB Migration Warning] Startup migration check:', err.message);
  }
};

const ensureSeedUsers = async () => {
  try {
    // 1. Admin account
    const adminCheck = await query(`SELECT id, username, role, status, password_hash, must_change_password FROM users WHERE LOWER(username) = 'admin'`);
    if (adminCheck.rowCount === 0) {
      const adminHash = await bcrypt.hash('admin123', 10);
      await query(
        `INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
         VALUES ('USR-001', 'System Administrator', 'admin', 'admin@flowforce.local', $1, 'ADMIN', 'Active', true)`,
        [adminHash]
      );
      console.log('✅ [DB] Initialized default Admin user (admin)');
    } else {
      const admin = adminCheck.rows[0];
      const updates = [];
      const params = [];
      let idx = 1;
      if (admin.role !== 'ADMIN') {
        updates.push(`role = $${idx++}`);
        params.push('ADMIN');
      }
      if (admin.status !== 'Active') {
        updates.push(`status = $${idx++}`);
        params.push('Active');
      }
      if (!admin.password_hash || !admin.password_hash.startsWith('$2')) {
        const adminHash = await bcrypt.hash('admin123', 10);
        updates.push(`password_hash = $${idx++}`);
        params.push(adminHash);
        updates.push(`must_change_password = true`);
      }
      if (updates.length > 0) {
        params.push(admin.id);
        await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
        console.log('✅ [DB] Verified and updated Admin account status/role');
      }
    }

    // 2. Employee account
    const empCheck = await query(`SELECT id, username, role, status, password_hash, must_change_password FROM users WHERE LOWER(username) = 'employee'`);
    if (empCheck.rowCount === 0) {
      const empHash = await bcrypt.hash('employee123', 10);
      await query(
        `INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
         VALUES ('USR-002', 'Employee', 'employee', 'employee@flowforce.local', $1, 'EMPLOYEE', 'Active', true)`,
        [empHash]
      );
      console.log('✅ [DB] Initialized default Employee user (employee)');
    } else {
      const emp = empCheck.rows[0];
      const updates = [];
      const params = [];
      let idx = 1;
      if (emp.role !== 'EMPLOYEE') {
        updates.push(`role = $${idx++}`);
        params.push('EMPLOYEE');
      }
      if (emp.status !== 'Active') {
        updates.push(`status = $${idx++}`);
        params.push('Active');
      }
      if (!emp.password_hash || !emp.password_hash.startsWith('$2')) {
        const empHash = await bcrypt.hash('employee123', 10);
        updates.push(`password_hash = $${idx++}`);
        params.push(empHash);
        updates.push(`must_change_password = true`);
      }
      if (updates.length > 0) {
        params.push(emp.id);
        await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
        console.log('✅ [DB] Verified and updated Employee account status/role');
      }
    }

    // 3. Ensure no NULL must_change_password
    await query(`UPDATE users SET must_change_password = false WHERE must_change_password IS NULL`);
    console.log('✅ [DB] User accounts verified in PostgreSQL');
  } catch (err) {
    console.warn('[DB User Seed Warning]:', err.message);
  }
};

// Start Server
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n⚡ Flow Force Enterprise Server running on http://0.0.0.0:${PORT}`);
    console.log(`📁 File Storage directory: ${absStorageDir}`);
    console.log(`🛡️ Role-Based Access Control active: ADMIN & EMPLOYEE accounts.\n`);
    await runStartupMigrations();
  });
}

module.exports = app;

