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
const absStorageDir = path.isAbsolute(STORAGE_DIR)
  ? STORAGE_DIR
  : path.resolve(process.cwd(), STORAGE_DIR);
if (!fs.existsSync(absStorageDir)) {
  fs.mkdirSync(absStorageDir, { recursive: true });
}

// Idempotent User Seed & Integrity Check (ADMIN: admin, EMPLOYEE: employee)
const ensureSeedUsers = async () => {
  try {
    const idRes = await query(`SELECT id FROM users WHERE id LIKE 'USR-%'`);
    let maxNum = 0;
    idRes.rows.forEach(r => {
      const m = r.id && r.id.match(/^USR-(\d+)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    });

    // 1. Admin account
    const adminCheck = await query(`SELECT id, username, role, status, password_hash, must_change_password FROM users WHERE LOWER(username) = 'admin'`);
    if (adminCheck.rowCount === 0) {
      maxNum++;
      const nextAdminId = `USR-${String(maxNum).padStart(3, '0')}`;
      const adminHash = await bcrypt.hash('admin123', 10);
      await query(
        `INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
         VALUES ($1, 'System Administrator', 'admin', 'admin@flowforce.local', $2, 'ADMIN', 'Active', false)`,
        [nextAdminId, adminHash]
      );
      console.log(`✅ [DB] Initialized default Admin user (admin) with ID ${nextAdminId}`);
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

      const knownAdminPasses = ['admin123', 'FlowForce2026!', 'admin', 'Admin123!', 'admin@123', 'flowforce_secure_password'];
      let adminPassMatched = false;
      for (const pass of knownAdminPasses) {
        if (admin.password_hash && await bcrypt.compare(pass, admin.password_hash)) {
          adminPassMatched = true;
          break;
        }
      }

      if (!admin.password_hash || !admin.password_hash.startsWith('$2') || !adminPassMatched) {
        const adminHash = await bcrypt.hash('admin123', 10);
        updates.push(`password_hash = $${idx++}`);
        params.push(adminHash);
        console.log('✅ [DB] Restored Admin password to admin123');
      }

      if (updates.length > 0) {
        params.push(admin.id);
        await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
        console.log('✅ [DB] Verified and updated Admin account');
      }
    }

    // 2. Employee account
    const empCheck = await query(`SELECT id, username, role, status, password_hash, must_change_password FROM users WHERE LOWER(username) = 'employee'`);
    if (empCheck.rowCount === 0) {
      maxNum++;
      const nextEmpId = `USR-${String(maxNum).padStart(3, '0')}`;
      const empHash = await bcrypt.hash('employee123', 10);
      await query(
        `INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
         VALUES ($1, 'Employee', 'employee', 'employee@flowforce.local', $2, 'EMPLOYEE', 'Active', true)`,
        [nextEmpId, empHash]
      );
      console.log(`✅ [DB] Initialized default Employee user (employee) with ID ${nextEmpId}`);
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
      const knownEmpPasses = ['employee123', 'FlowForce2026!', 'employee', 'Employee123!', 'password123'];
      let empPassMatched = false;
      for (const pass of knownEmpPasses) {
        if (emp.password_hash && await bcrypt.compare(pass, emp.password_hash)) {
          empPassMatched = true;
          break;
        }
      }
      if (!emp.password_hash || !emp.password_hash.startsWith('$2') || !empPassMatched) {
        const empHash = await bcrypt.hash('employee123', 10);
        updates.push(`password_hash = $${idx++}`);
        params.push(empHash);
        console.log('✅ [DB] Restored Employee password to employee123');
      }
      if (updates.length > 0) {
        params.push(emp.id);
        await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
        console.log('✅ [DB] Verified and updated Employee account');
      }
    }

    // 3. Ensure no NULL must_change_password
    await query(`UPDATE users SET must_change_password = false WHERE must_change_password IS NULL`);
    console.log('✅ [DB] User accounts verified in PostgreSQL');
  } catch (err) {
    console.warn('[DB User Seed Warning]:', err.message);
  }
};

// Health Check API (supports both /health and /api/health)
const handleHealthCheck = async (req, res) => {
  try {
    await ensureSeedUsers();
    const userRes = await query(`SELECT id, username, role, status, (password_hash IS NOT NULL AND length(password_hash) > 0) AS has_hash, substring(password_hash from 1 for 4) AS hash_prefix, must_change_password FROM users ORDER BY id ASC`);
    const masterCount = await query(`SELECT COUNT(*) FROM master_items`);
    res.json({
      status: 'ok',
      service: 'Flow Force Enterprise Portal API',
      database: 'connected',
      masterItemsCount: parseInt(masterCount.rows[0].count, 10),
      users: userRes.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      service: 'Flow Force Enterprise Portal API',
      database: 'unavailable',
      message: err.message,
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
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS ducting_type VARCHAR(100);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS dim_a VARCHAR(50);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS dim_b VARCHAR(50);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS dim_c VARCHAR(50);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS angle_d VARCHAR(50);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS angle_b VARCHAR(50);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS radius VARCHAR(50);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS dim_l1 VARCHAR(50);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS dim_l2 VARCHAR(50);
      ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS thickness VARCHAR(50);
      ALTER TABLE pr_items ALTER COLUMN sku DROP NOT NULL;
      ALTER TABLE purchase_requests DROP CONSTRAINT IF EXISTS purchase_requests_purchase_type_check;
      ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_purchase_type_check CHECK (purchase_type IN ('STANDARD STOCK ITEM', 'PROJECT-SPECIFIC CUT SIZE', 'PROJECT-SPECIFIC DUCTING'));
      UPDATE pr_items SET status = 'Available' WHERE status IS NULL OR status NOT IN ('Available', 'Out of Stock');
      UPDATE pr_items SET supply_type = 'Full Size' WHERE supply_type IS NULL OR supply_type NOT IN ('Full Size', 'Cut Size');
      UPDATE pr_items SET remarks = '' WHERE remarks IS NULL;

      -- Controlled Excel Import Staging & Review Tables
      CREATE TABLE IF NOT EXISTS import_submissions (
        id SERIAL PRIMARY KEY,
        import_id VARCHAR(50) UNIQUE NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        uploaded_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
        uploaded_by_username VARCHAR(100) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED')),
        total_rows INTEGER NOT NULL DEFAULT 0,
        approved_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
        approved_by_username VARCHAR(100),
        approved_at TIMESTAMP WITH TIME ZONE,
        rejected_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
        rejected_by_username VARCHAR(100),
        rejected_at TIMESTAMP WITH TIME ZONE,
        rejection_reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS import_submission_items (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER NOT NULL REFERENCES import_submissions(id) ON DELETE CASCADE,
        row_number INTEGER NOT NULL,
        source_sheet VARCHAR(100),
        sku VARCHAR(50),
        product_name VARCHAR(255),
        item_description TEXT,
        category VARCHAR(100),
        sub_category VARCHAR(100),
        material VARCHAR(100),
        size VARCHAR(255),
        specification TEXT,
        unit VARCHAR(50),
        weight_kg NUMERIC(12, 3),
        unit_price NUMERIC(15, 2),
        supply_type VARCHAR(50) DEFAULT 'Full Size',
        brand VARCHAR(255),
        supplier_name VARCHAR(255),
        remarks TEXT,
        dim_a VARCHAR(50),
        dim_b VARCHAR(50),
        dim_c VARCHAR(50),
        dim_d VARCHAR(50),
        dim_l1 VARCHAR(50),
        dim_l2 VARCHAR(50),
        assigned_master_sku VARCHAR(50),
        validation_status VARCHAR(50) DEFAULT 'VALID',
        validation_error TEXT,
        is_duplicate_sku BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_import_sub_id ON import_submissions(import_id);
      CREATE INDEX IF NOT EXISTS idx_import_sub_status ON import_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_import_sub_user ON import_submissions(uploaded_by_user_id);
      CREATE INDEX IF NOT EXISTS idx_import_sub_items_sub ON import_submission_items(submission_id);

      ALTER TABLE import_submission_items ADD COLUMN IF NOT EXISTS assigned_master_sku VARCHAR(50);
    `);
    console.log('✅ [DB] Verified schema (Status, Supply Type, Remarks, Ducting Specs, Import Submissions)');

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

    // Verify storage documents for approved PRs and safely regenerate any missing files into persistent storage
    try {
      const { restoreMissingApprovedPrDocuments } = require('./services/documentGenerator');
      await restoreMissingApprovedPrDocuments();
    } catch (storageErr) {
      console.warn('[Storage Check Warning]:', storageErr.message);
    }
  } catch (err) {
    console.warn('[DB Migration Warning] Startup migration check:', err.message);
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

