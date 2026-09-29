/**
 * Migration: Ducting Standard Drawing Management & Historical Versioning
 * Creates standard_drawings and drawing_removal_requests tables.
 * Extends ducting_types and pr_items with version-safe foreign keys.
 */

const { query } = require('../pool');

async function migrate() {
  console.log('[Migration] Starting Ducting Standard Drawing schema migration...');

  // 1. Ensure ducting_types exists and has status and current_standard_drawing_id
  await query(`
    CREATE TABLE IF NOT EXISTS ducting_types (
      id SERIAL PRIMARY KEY,
      type_name VARCHAR(100) UNIQUE NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
      master_drawing_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`ALTER TABLE ducting_types ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE';`);

  // Seed default 4 ducting types if missing
  await query(`
    INSERT INTO ducting_types (type_name) VALUES
      ('Straight Duct'),
      ('Y-Duct'),
      ('Elbow'),
      ('Twin Duct')
    ON CONFLICT (type_name) DO NOTHING;
  `);

  // 2. Create standard_drawings table
  await query(`
    CREATE TABLE IF NOT EXISTS standard_drawings (
      id SERIAL PRIMARY KEY,
      ducting_type_id INTEGER NOT NULL REFERENCES ducting_types(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      file_name VARCHAR(255) NOT NULL,
      original_file_name VARCHAR(255),
      file_size_bytes BIGINT,
      mime_type VARCHAR(100),
      cloudinary_public_id VARCHAR(500),
      cloudinary_url TEXT,
      file_path_or_storage_key TEXT,
      uploaded_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, PENDING_REMOVAL, INACTIVE, REMOVED
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_standard_drawing_type_version UNIQUE(ducting_type_id, version)
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_std_drawings_type ON standard_drawings(ducting_type_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_std_drawings_status ON standard_drawings(status);`);

  // 3. Link current_standard_drawing_id to ducting_types
  await query(`ALTER TABLE ducting_types ADD COLUMN IF NOT EXISTS current_standard_drawing_id INTEGER REFERENCES standard_drawings(id) ON DELETE SET NULL;`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ducting_types_curr_std ON ducting_types(current_standard_drawing_id);`);

  // 4. Create drawing_removal_requests table
  await query(`
    CREATE TABLE IF NOT EXISTS drawing_removal_requests (
      id SERIAL PRIMARY KEY,
      standard_drawing_id INTEGER NOT NULL REFERENCES standard_drawings(id) ON DELETE CASCADE,
      requested_by_user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE SET NULL,
      requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      reason TEXT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      reviewed_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP WITH TIME ZONE,
      admin_comment TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_removal_req_drawing ON drawing_removal_requests(standard_drawing_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_removal_req_status ON drawing_removal_requests(status);`);

  // 5. Extend pr_items for standard drawing snapshot & project-specific drawing
  await query(`ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS standard_drawing_id INTEGER REFERENCES standard_drawings(id) ON DELETE SET NULL;`);
  await query(`ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS standard_drawing_version INTEGER;`);
  await query(`ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS project_drawing_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL;`);
  await query(`CREATE INDEX IF NOT EXISTS idx_pr_items_std_drawing ON pr_items(standard_drawing_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_pr_items_proj_drawing ON pr_items(project_drawing_document_id);`);

  // 6. Migrate existing documents in ducting_types.master_drawing_document_id into standard_drawings if not yet migrated
  const existingMasters = await query(`
    SELECT dt.id AS type_id, dt.type_name, doc.* 
    FROM ducting_types dt
    JOIN documents doc ON doc.id = dt.master_drawing_document_id
    WHERE dt.current_standard_drawing_id IS NULL
  `);

  for (const row of existingMasters.rows) {
    const checkExist = await query(`SELECT id FROM standard_drawings WHERE ducting_type_id = $1 AND version = 1`, [row.type_id]);
    let stdId;
    if (checkExist.rowCount === 0) {
      const ins = await query(`
        INSERT INTO standard_drawings (
          ducting_type_id, version, file_name, original_file_name,
          file_size_bytes, mime_type, file_path_or_storage_key,
          uploaded_by_user_id, status, created_at
        ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)
        RETURNING id
      `, [
        row.type_id,
        row.file_name,
        row.original_file_name || row.file_name,
        row.file_size_bytes,
        row.mime_type,
        row.file_path_or_storage_key,
        row.uploaded_by_user_id,
        row.created_at
      ]);
      stdId = ins.rows[0].id;
    } else {
      stdId = checkExist.rows[0].id;
    }
    await query(`UPDATE ducting_types SET current_standard_drawing_id = $1 WHERE id = $2`, [stdId, row.type_id]);
  }

  console.log('[Migration] Ducting Standard Drawing schema migration completed successfully.');
}

module.exports = { migrate };

if (require.main === module) {
  const { pool } = require('../pool');
  migrate()
    .then(() => pool.end())
    .catch(err => {
      console.error('[Migration] Failed:', err);
      process.exit(1);
    });
}
