-- =========================================================================
-- FLOW FORCE - 002 CREATE IMPORT SUBMISSIONS & IMPORT SUBMISSION ITEMS TABLES
-- Safe, forward-only idempotent migration for Controlled Excel Import Staging
-- =========================================================================

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
