-- =========================================================================
-- FLOW FORCE SKU & PURCHASE REQUEST AUTOMATION - POSTGRESQL SCHEMA
-- Single Source of Truth for Master Items, Projects, PRs, and Audit Logs
-- =========================================================================

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK (role IN ('ADMIN', 'EMPLOYEE', 'ENGINEERING', 'PURCHASING', 'WAREHOUSE')),
  status VARCHAR(50) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Disabled')),
  must_change_password BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. PROJECTS TABLE (Project / Job System)
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  project_code VARCHAR(100) UNIQUE NOT NULL,
  project_name VARCHAR(255) NOT NULL,
  job_location VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'ACTIVE',
  created_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. MASTER ITEMS TABLE (Verified Reference Items)
CREATE TABLE IF NOT EXISTS master_items (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  product_name VARCHAR(255),
  item_description TEXT,
  category VARCHAR(100) DEFAULT 'Raw Materials',
  sub_category VARCHAR(100),
  material VARCHAR(100),
  size VARCHAR(255),
  specification TEXT,
  unit VARCHAR(50) DEFAULT 'Sheet',
  weight_kg NUMERIC(12, 3),
  status VARCHAR(50) DEFAULT 'Available',
  supply_type VARCHAR(50) DEFAULT 'Full Size',
  remarks TEXT DEFAULT '',
  brand VARCHAR(255),
  unit_price NUMERIC(15, 2), -- IDR Currency
  source_sheet VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. PURCHASE REQUESTS TABLE
CREATE TABLE IF NOT EXISTS purchase_requests (
  id SERIAL PRIMARY KEY,
  pr_number VARCHAR(100) UNIQUE NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT,
  created_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  department VARCHAR(100),
  required_date DATE,
  urgency VARCHAR(100),
  reason_for_purchase TEXT,
  remarks TEXT,
  purchase_type VARCHAR(100) DEFAULT 'STANDARD STOCK ITEM' CHECK (purchase_type IN ('STANDARD STOCK ITEM', 'PROJECT-SPECIFIC CUT SIZE')),
  required_cut_size TEXT,
  approved_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP WITH TIME ZONE,
  rejected_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. PR ITEMS (Historical Snapshot of Master Item Data)
CREATE TABLE IF NOT EXISTS pr_items (
  id SERIAL PRIMARY KEY,
  purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  master_item_id INTEGER REFERENCES master_items(id) ON DELETE SET NULL,
  sku VARCHAR(50) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  item_description TEXT NOT NULL,
  material_grade VARCHAR(100),
  size_dimensions VARCHAR(255),
  specification TEXT,
  unit VARCHAR(50),
  quantity NUMERIC(12, 2) NOT NULL DEFAULT 1,
  weight NUMERIC(12, 3),
  unit_price NUMERIC(15, 2), -- Snapshot of IDR price at PR creation
  estimated_total_cost NUMERIC(15, 2), -- quantity * unit_price
  purchase_type VARCHAR(100) DEFAULT 'STANDARD STOCK ITEM',
  required_cut_size TEXT,
  status VARCHAR(50) DEFAULT 'Available',
  supply_type VARCHAR(50) DEFAULT 'Full Size',
  cut_length VARCHAR(100) DEFAULT '',
  cut_width VARCHAR(100) DEFAULT '',
  remarks TEXT DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. PR APPROVAL HISTORY (Immutable Audit Trail)
CREATE TABLE IF NOT EXISTS pr_approval_history (
  id SERIAL PRIMARY KEY,
  purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL CHECK (action IN ('SUBMITTED', 'APPROVED', 'REJECTED')),
  performed_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  performed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  remarks TEXT
);

-- 7. DOCUMENTS TABLE (Project / Job Location Document Metadata)
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  purchase_request_id INTEGER REFERENCES purchase_requests(id) ON DELETE CASCADE,
  purchase_request_item_id INTEGER REFERENCES pr_items(id) ON DELETE CASCADE,
  document_type VARCHAR(50) NOT NULL CHECK (document_type IN ('PR_EXCEL', 'PR_PDF', 'ENGINEERING_DRAWING')),
  file_name VARCHAR(255) NOT NULL,
  original_file_name VARCHAR(255),
  file_path_or_storage_key TEXT NOT NULL,
  uploaded_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  sha256_checksum VARCHAR(64),
  file_size_bytes BIGINT,
  mime_type VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. INDEXES FOR HIGH-PERFORMANCE SEARCH & FILTERING
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_projects_code ON projects(project_code);
CREATE INDEX IF NOT EXISTS idx_master_items_sku ON master_items(sku);
CREATE INDEX IF NOT EXISTS idx_pr_number ON purchase_requests(pr_number);
CREATE INDEX IF NOT EXISTS idx_pr_status ON purchase_requests(status);
CREATE INDEX IF NOT EXISTS idx_pr_creator ON purchase_requests(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_pr_project ON purchase_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_pr_items_pr ON pr_items(purchase_request_id);
CREATE INDEX IF NOT EXISTS idx_pr_items_drawing ON pr_items(drawing_document_id);
CREATE INDEX IF NOT EXISTS idx_pr_history_pr ON pr_approval_history(purchase_request_id);
CREATE INDEX IF NOT EXISTS idx_documents_pr ON documents(purchase_request_id);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_documents_pr_item ON documents(purchase_request_item_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);

-- 7a. MASTER DUCTING TYPES TABLE (Reusable Master Engineering Drawing Configuration)
CREATE TABLE IF NOT EXISTS ducting_types (
  id SERIAL PRIMARY KEY,
  type_name VARCHAR(100) UNIQUE NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  current_standard_drawing_id INTEGER,
  master_drawing_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ducting_types (type_name) VALUES
  ('Straight Duct'),
  ('Y-Duct'),
  ('Elbow'),
  ('Twin Duct')
ON CONFLICT (type_name) DO NOTHING;

-- 7a-1. STANDARD DRAWINGS TABLE (Cloudinary Storage & Reusable Versioned Reference)
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
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_standard_drawing_type_version UNIQUE(ducting_type_id, version)
);

ALTER TABLE ducting_types 
  DROP CONSTRAINT IF EXISTS fk_ducting_types_curr_std,
  ADD CONSTRAINT fk_ducting_types_curr_std FOREIGN KEY (current_standard_drawing_id) REFERENCES standard_drawings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_std_drawings_type ON standard_drawings(ducting_type_id);
CREATE INDEX IF NOT EXISTS idx_std_drawings_status ON standard_drawings(status);
CREATE INDEX IF NOT EXISTS idx_ducting_types_drawing ON ducting_types(master_drawing_document_id);
CREATE INDEX IF NOT EXISTS idx_ducting_types_curr_std ON ducting_types(current_standard_drawing_id);

-- 7a-2. DRAWING REMOVAL REQUESTS TABLE
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

CREATE INDEX IF NOT EXISTS idx_removal_req_drawing ON drawing_removal_requests(standard_drawing_id);
CREATE INDEX IF NOT EXISTS idx_removal_req_status ON drawing_removal_requests(status);

-- 7b. ACTIVITY LOGS TABLE (Enterprise Activity & Document Audit Logging)
CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100),
  action VARCHAR(50) NOT NULL,
  performed_by_user_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  performed_by_username VARCHAR(100),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);

-- 7c. DOCUMENT VERSIONING & CHECKSUM EXTENSIONS
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sha256_checksum VARCHAR(64);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;

-- 9. IDEMPOTENT MIGRATIONS FOR MASTER_ITEMS
ALTER TABLE master_items ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Available';
ALTER TABLE master_items ADD COLUMN IF NOT EXISTS supply_type VARCHAR(50) DEFAULT 'Full Size';
ALTER TABLE master_items ADD COLUMN IF NOT EXISTS remarks TEXT DEFAULT '';
UPDATE master_items SET status = 'Available' WHERE status IS NULL OR status NOT IN ('Available', 'Out of Stock');
UPDATE master_items SET supply_type = 'Full Size' WHERE supply_type IS NULL OR supply_type NOT IN ('Full Size', 'Cut Size');
UPDATE master_items SET remarks = '' WHERE remarks IS NULL;

-- 10. IDEMPOTENT MIGRATIONS FOR PR_ITEMS
ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Available';
ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS supply_type VARCHAR(50) DEFAULT 'Full Size';
ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS cut_length VARCHAR(100) DEFAULT '';
ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS cut_width VARCHAR(100) DEFAULT '';
ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS remarks TEXT DEFAULT '';
UPDATE pr_items SET status = 'Available' WHERE status IS NULL OR status NOT IN ('Available', 'Out of Stock');
UPDATE pr_items SET supply_type = 'Full Size' WHERE supply_type IS NULL OR supply_type NOT IN ('Full Size', 'Cut Size');
UPDATE pr_items SET remarks = '' WHERE remarks IS NULL;

-- 11. IMPORT SUBMISSIONS TABLE (Controlled Excel Import Staging & Review)
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

-- 12. IMPORT SUBMISSION ITEMS TABLE
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

-- 13. IDEMPOTENT MIGRATIONS FOR IMPORT_SUBMISSION_ITEMS
ALTER TABLE import_submission_items ADD COLUMN IF NOT EXISTS assigned_master_sku VARCHAR(50);

-- 14. IDEMPOTENT MIGRATIONS FOR DUCTING IN PR_ITEMS
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

-- 15. SEED INITIAL USERS IF NOT EXISTS (Bcrypt cost 10)
INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
VALUES 
  ('USR-001', 'System Administrator', 'admin', 'admin@flowforce.local', '$2a$10$jMQQbGYWhMzOGOZ1ZtCZ9enyo1vrQEk56VOHSD0bUPmhglwDxpXZK', 'ADMIN', 'Active', true),
  ('USR-002', 'Employee', 'employee', 'employee@flowforce.local', '$2a$10$5Yct6.qI2hO7hZLU3Vw/weuVvgGb48rD0Z/RD2pPMfuLA6.dK6xLe', 'EMPLOYEE', 'Active', true)
ON CONFLICT (username) DO NOTHING;



