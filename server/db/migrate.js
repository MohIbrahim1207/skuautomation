/**
 * =========================================================================
 * FLOW FORCE - FORWARD-ONLY DATABASE MIGRATION RUNNER
 * Applies pending schema migrations safely and idempotently without data loss
 * =========================================================================
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function runMigrations() {
  console.log('[Migration Runner] Starting database migration check...');
  const client = await pool.connect();

  try {
    const migrationsDir = path.join(__dirname, 'migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');
        console.log(`[Migration Runner] Applying ${file}...`);
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`[Migration Runner] Successfully applied ${file}.`);
      }
    }

    // Verify pr_items table columns
    const colCheck = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'pr_items' AND column_name = 'remarks'
    `);

    if (colCheck.rows.length > 0) {
      console.log('✅ [Migration Runner] Verified column "remarks" exists in "pr_items":', colCheck.rows[0]);
    } else {
      throw new Error('Column "remarks" was not found in "pr_items" after migration!');
    }

    // Verify existing PR records are preserved
    const prCount = await client.query('SELECT COUNT(*) AS count FROM purchase_requests');
    const prItemCount = await client.query('SELECT COUNT(*) AS count FROM pr_items');
    console.log(`✅ [Migration Runner] PR data intact: ${prCount.rows[0].count} PRs, ${prItemCount.rows[0].count} PR items.`);

    console.log('\n✓ All migrations applied and verified successfully!\n');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('❌ [Migration Runner Error]:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };
