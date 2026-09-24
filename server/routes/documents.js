/**
 * Document Storage & Download Routes (/api/documents)
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query } = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

/**
 * Resolves the physical file path for a stored document across different environments
 * (Windows, Linux, Docker container with persistent volumes, legacy paths).
 */
function resolveStoragePath(filePathOrKey) {
  if (!filePathOrKey) return null;

  const cwd = process.cwd();
  const baseStorageDir = process.env.STORAGE_DIR || './storage';
  const resolvedBaseStorage = path.isAbsolute(baseStorageDir)
    ? baseStorageDir
    : path.resolve(cwd, baseStorageDir);

  const candidates = [];

  // 1. Direct path if absolute
  if (path.isAbsolute(filePathOrKey)) {
    candidates.push(filePathOrKey);
  }

  // 2. Relative to process.cwd()
  candidates.push(path.resolve(cwd, filePathOrKey));

  // 3. If path starts with "app/" or "app\" (e.g. legacy container storage key)
  const strippedApp = filePathOrKey.replace(/^app[/\\]/, '');
  if (strippedApp !== filePathOrKey) {
    candidates.push(path.resolve(cwd, strippedApp));
  }

  // 4. Relative to root /
  candidates.push(path.resolve('/', filePathOrKey));

  // 5. Relative to configured storage directory
  const strippedStorage = filePathOrKey.replace(/^(app[/\\])?storage[/\\]/, '');
  candidates.push(path.resolve(resolvedBaseStorage, strippedStorage));
  candidates.push(path.resolve(resolvedBaseStorage, filePathOrKey));

  // Check candidates in order and return first that exists physically on disk
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to the most plausible canonical path
  return (strippedApp !== filePathOrKey ? path.resolve(cwd, strippedApp) : candidates[0]) || path.resolve(cwd, filePathOrKey);
}

// GET /api/documents/:id/download - Stream/Download PR Document
router.get('/:id/download', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await query(
      `SELECT d.*, pr.created_by_user_id
       FROM documents d
       LEFT JOIN purchase_requests pr ON pr.id = d.purchase_request_id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Document not found.' });
    const doc = result.rows[0];

    // Authorization: Employee can only download documents for their own PRs; Admins can access all
    const ownerId = doc.created_by_user_id || doc.uploaded_by_user_id;
    if (req.user.role !== 'ADMIN' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Access Denied — You cannot access another employee’s documents.' });
    }

    const fullPath = resolveStoragePath(doc.file_path_or_storage_key);
    const fileExists = fullPath ? fs.existsSync(fullPath) : false;

    // Safe diagnostic logging (PR ID, Doc ID, filename, resolved path, file exists, username, role)
    // NEVER log passwords, JWTs, API keys, database credentials, or secrets
    console.log(`[Documents API] Download request - PR ID: ${doc.purchase_request_id || 'N/A'}, Doc ID: ${doc.id}, File: ${doc.file_name}, Resolved Path: ${fullPath}, Exists: ${fileExists}, User: ${req.user.username} (${req.user.role})`);

    if (!fileExists) {
      return res.status(404).json({ error: 'Physical document file not found on server storage.' });
    }

    const contentType = doc.document_type === 'PR_PDF'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    console.error('[Documents API] Download error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

module.exports = router;
