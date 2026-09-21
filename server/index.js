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

