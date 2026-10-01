/**
 * Migration: Production Admin Operations & Append-Only Audit Trail
 * - Enhances activity_logs with enterprise audit attributes
 * - Adds database-level trigger prohibiting UPDATE/DELETE on activity_logs (append-only)
 * - Adds last_login_at column to users table
 */

const { query } = require('../pool');

async function migrateAdminOperations() {
  console.log('[Migration] Running Admin Operations & Audit Trail schema updates...');

  // 1. Extend activity_logs table
  await query(`
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS role VARCHAR(50);
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS module VARCHAR(50);
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(50);
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'SUCCESS';
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS before_value JSONB;
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS after_value JSONB;
  `);

  // Indexes for fast administrative querying & filtering
  await query(`
    CREATE INDEX IF NOT EXISTS idx_activity_logs_module ON activity_logs(module);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_status ON activity_logs(status);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(performed_by_user_id);
  `);

  // 2. PostgreSQL engine-level append-only guard (Trigger preventing UPDATE or DELETE)
  await query(`
    CREATE OR REPLACE FUNCTION prevent_activity_logs_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'activity_logs is an append-only audit trail. Mutation (UPDATE/DELETE) is strictly prohibited.';
    END;
    $$ LANGUAGE plpgsql;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_activity_logs_immutable'
      ) THEN
        CREATE TRIGGER trg_activity_logs_immutable
        BEFORE UPDATE OR DELETE ON activity_logs
        FOR EACH ROW
        EXECUTE FUNCTION prevent_activity_logs_mutation();
      END IF;
    END $$;
  `);

  // 3. Extend users table for last login tracking
  await query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;
  `);

  console.log('[Migration] Admin Operations schema & append-only trigger successfully verified.');
}

module.exports = {
  migrateAdminOperations
};

if (require.main === module) {
  migrateAdminOperations()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[Migration Error]', err);
      process.exit(1);
    });
}
