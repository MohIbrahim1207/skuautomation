/**
 * =========================================================================
 * FLOW FORCE - DATABASE INITIALIZATION & MIGRATION SCRIPT
 * Connects to PostgreSQL, creates database/schema, and migrates raw materials
 * =========================================================================
 */
const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl || dbUrl.includes('USERNAME:PASSWORD')) {
    console.error('\n[Database Setup Required]');
    console.error('Please configure your valid PostgreSQL connection string in .env:');
    console.error('Example: DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/flow_force\n');
    process.exit(1);
  }

  // Parse connection URL to check target database name
  let targetDbName = 'flow_force';
  let defaultDbUrl = dbUrl;
  try {
    const urlObj = new URL(dbUrl);
    targetDbName = urlObj.pathname.replace(/^\//, '') || 'flow_force';
    // Create connection URL pointing to default 'postgres' db for database creation
    urlObj.pathname = '/postgres';
    defaultDbUrl = urlObj.toString();
  } catch (e) {
    console.warn('[Database] Could not parse DATABASE_URL with URL parser; proceeding directly.');
  }

  console.log(`[Database] Connecting to PostgreSQL to verify database "${targetDbName}"...`);
  
  // 1. Create target database if not exists
  let adminClient;
  try {
    adminClient = new Client({ connectionString: defaultDbUrl, connectionTimeoutMillis: 5000 });
    await adminClient.connect();
    const checkDb = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDbName]);
    if (checkDb.rowCount === 0) {
      console.log(`[Database] Creating database "${targetDbName}"...`);
      await adminClient.query(`CREATE DATABASE "${targetDbName}" ENCODING 'UTF8'`);
      console.log(`[Database] Successfully created database "${targetDbName}".`);
    } else {
      console.log(`[Database] Database "${targetDbName}" already exists.`);
    }
    await adminClient.end();
  } catch (err) {
    if (adminClient) {
      try { await adminClient.end(); } catch (e) {}
    }
    console.warn(`[Database] Notice during database existence check: ${err.message}. Proceeding to connect to target database directly.`);
  }

  // 2. Connect to target database and apply schema
  console.log(`[Database] Connecting to "${targetDbName}"...`);
  const targetPool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });

  try {
    const client = await targetPool.connect();
    console.log('[Database] Connected successfully to target database.');

    // Read and apply schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    console.log('[Database] Applying schema.sql...');
    await client.query(schemaSql);
    console.log('[Database] Schema successfully applied.');

    // 3. Migrate verified 50 Raw Materials (FF4186 - FF4235)
    const masterJsonPath = path.join(__dirname, '../../raw_materials_master.json');
    if (fs.existsSync(masterJsonPath)) {
      const rawMaterials = JSON.parse(fs.readFileSync(masterJsonPath, 'utf8'));
      console.log(`[Database] Found ${rawMaterials.length} verified Raw Materials in master JSON.`);

      let insertedCount = 0;
      for (const item of rawMaterials) {
        const checkItem = await client.query('SELECT 1 FROM master_items WHERE UPPER(sku) = UPPER($1)', [item.sku]);
        if (checkItem.rowCount === 0) {
          await client.query(
            `INSERT INTO master_items (
              sku, product_name, item_description, category, sub_category, 
              material, size, specification, unit, weight_kg, brand, unit_price, source_sheet
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
              item.brand || 'PT Persada Nusantara Steel',
              item.unitPrice || null,
              item.sourceSheet || 'Catalog'
            ]
          );
          insertedCount++;
        }
      }
      console.log(`[Database] Raw Materials migration complete. Inserted ${insertedCount} new items. (Total: ${rawMaterials.length})`);
    } else {
      console.warn('[Database] raw_materials_master.json not found; skipping initial material import.');
    }

    // 4. Seed initial User Accounts (Admin and Employee)
    const adminPassHash = await bcrypt.hash('admin123', 10);
    const employeePassHash = await bcrypt.hash('employee123', 10);

    const checkAdmin = await client.query('SELECT 1 FROM users WHERE username = $1', ['admin']);
    if (checkAdmin.rowCount === 0) {
      await client.query(
        `INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['USR-001', 'System Administrator', 'admin', 'admin@flowforce.local', adminPassHash, 'ADMIN', 'Active', true]
      );
      console.log('[Database] Seeded Admin account (username: admin).');
    }

    const checkEmp = await client.query('SELECT 1 FROM users WHERE username = $1', ['employee']);
    if (checkEmp.rowCount === 0) {
      await client.query(
        `INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['USR-002', 'Employee', 'employee', 'employee@flowforce.local', employeePassHash, 'EMPLOYEE', 'Active', true]
      );
      console.log('[Database] Seeded Employee account (username: employee).');
    }

    console.log('[Database] NOTE: No fake business projects were seeded. Actual projects will be created by users.');

    client.release();
    await targetPool.end();
    console.log('\n✓ PostgreSQL initialization and migration completed successfully!\n');
    process.exit(0);

  } catch (err) {
    console.error('\n[Database Error] Failed during database initialization:');
    console.error(err.message);
    if (err.code === '28P01' || err.message.includes('password authentication failed')) {
      console.error('\n--> Authentication failed. Please verify the password in your .env file:');
      console.error('    DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/flow_force\n');
    }
    await targetPool.end();
    process.exit(1);
  }
}

if (require.main === module) {
  initDatabase();
}

module.exports = { initDatabase };
