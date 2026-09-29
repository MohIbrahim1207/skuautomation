/**
 * Document Storage, Download & Engineering Drawing Routes (/api/documents)
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { logActivity } = require('../services/activityLogger');
const { getDocumentStorageDir } = require('../services/documentGenerator');

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

/**
 * Maps document or extension to accurate MIME Content-Type
 */
function getContentType(doc) {
  if (doc.mime_type) return doc.mime_type;
  const fileName = doc.original_file_name || doc.file_name || '';
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls': return 'application/vnd.ms-excel';
    default:
      if (doc.document_type === 'PR_PDF') return 'application/pdf';
      if (doc.document_type === 'PR_EXCEL') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      return 'application/octet-stream';
  }
}

// POST /api/documents/upload-drawing - Upload & Persist Engineering Drawing / PDF
router.post('/upload-drawing', async (req, res) => {
  try {
    const { fileName, mimeType, dataUrl, projectId } = req.body;

    if (!fileName || !dataUrl) {
      return res.status(400).json({ error: 'File name and data payload are required.' });
    }

    const isPdf = (mimeType && mimeType.includes('pdf')) || fileName.toLowerCase().endsWith('.pdf');
    const isImage = (mimeType && mimeType.startsWith('image/')) || /\.(png|jpe?g|webp|svg)$/i.test(fileName);

    if (!isPdf && !isImage) {
      return res.status(400).json({ error: 'Unsupported file format. Please upload a PDF or image engineering drawing.' });
    }

    // Decode base64 buffer
    const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: 'File size exceeds maximum 15 MB limit.' });
    }

    // Resolve project folder
    let cleanProjCode = 'GENERAL';
    let resolvedProjectId = null;

    if (projectId) {
      const projRes = await query('SELECT id, project_code FROM projects WHERE id = $1 OR project_code = $2', [
        isNaN(Number(projectId)) ? -1 : Number(projectId),
        String(projectId)
      ]);
      if (projRes.rowCount > 0) {
        cleanProjCode = (projRes.rows[0].project_code || 'GENERAL').replace(/[^a-zA-Z0-9_-]/g, '_');
        resolvedProjectId = projRes.rows[0].id;
      }
    }

    const baseStorage = getDocumentStorageDir();
    const drawingDir = path.join(baseStorage, 'projects', cleanProjCode, 'engineering-drawings');
    if (!fs.existsSync(drawingDir)) {
      fs.mkdirSync(drawingDir, { recursive: true });
    }

    const safeOrigName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const diskFileName = `DRW_${Date.now()}_${safeOrigName}`;
    const absoluteFilePath = path.join(drawingDir, diskFileName);
    const storageKey = path.relative(process.cwd(), absoluteFilePath).replace(/\\/g, '/');

    fs.writeFileSync(absoluteFilePath, buffer);

    const sha256Checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileSizeBytes = buffer.length;
    const finalMime = mimeType || (isPdf ? 'application/pdf' : 'image/png');

    const ins = await query(
      `INSERT INTO documents (
        project_id, document_type, file_name, original_file_name,
        file_path_or_storage_key, uploaded_by_user_id, sha256_checksum,
        file_size_bytes, mime_type
      ) VALUES ($1, 'ENGINEERING_DRAWING', $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, created_at`,
      [
        resolvedProjectId,
        safeOrigName,
        fileName,
        storageKey,
        req.user.id,
        sha256Checksum,
        fileSizeBytes,
        finalMime
      ]
    );

    const docId = ins.rows[0].id;

    // Log Activity: DOCUMENT_UPLOADED
    await logActivity({
      entityType: 'DOCUMENT',
      entityId: String(docId),
      action: 'DOCUMENT_UPLOADED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        documentId: docId,
        documentType: 'ENGINEERING_DRAWING',
        fileName: safeOrigName,
        originalFilename: fileName,
        fileSize: fileSizeBytes,
        sha256Checksum
      }
    });

    res.status(201).json({
      success: true,
      document: {
        id: docId,
        documentId: docId,
        fileName: fileName,
        originalFilename: fileName,
        mimeType: finalMime,
        fileSize: fileSizeBytes,
        fileSizeBytes: fileSizeBytes,
        sha256Checksum,
        viewUrl: `/api/documents/${docId}/view`,
        downloadUrl: `/api/documents/${docId}/download`
      }
    });
  } catch (err) {
    console.error('[Documents API] Upload drawing error:', err);
    res.status(500).json({ error: 'Failed to upload engineering drawing: ' + err.message });
  }
});

// GET /api/documents/standard-drawings/:id/view - View standard drawing inline
router.get('/standard-drawings/:id/view', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query(
      `SELECT sd.*, dt.type_name
       FROM standard_drawings sd
       LEFT JOIN ducting_types dt ON dt.id = sd.ducting_type_id
       WHERE sd.id = $1`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Standard drawing not found.' });
    const doc = result.rows[0];

    const safeDispName = doc.original_file_name || doc.file_name || `standard_drawing_v${doc.version}`;
    const contentType = getContentType(doc);

    const fullPath = resolveStoragePath(doc.file_path_or_storage_key);
    if (fullPath && fs.existsSync(fullPath)) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(safeDispName)}"`);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return fs.createReadStream(fullPath).pipe(res);
    }

    if (doc.cloudinary_url) {
      return res.redirect(doc.cloudinary_url);
    }

    return res.status(404).json({ error: 'Physical drawing file not found on server storage.' });
  } catch (err) {
    console.error('[Documents API] View standard drawing error:', err);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// GET /api/documents/standard-drawings/:id/download - Stream/download standard drawing
router.get('/standard-drawings/:id/download', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query(
      `SELECT sd.*, dt.type_name
       FROM standard_drawings sd
       LEFT JOIN ducting_types dt ON dt.id = sd.ducting_type_id
       WHERE sd.id = $1`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Standard drawing not found.' });
    const doc = result.rows[0];

    const rawDispName = doc.original_file_name || doc.file_name || `standard_drawing_v${doc.version}`;
    const safeDispName = rawDispName.replace(/["\r\n]/g, '').trim().replace(/[^\w.-]/g, '_');
    const encodedFileName = encodeURIComponent(rawDispName);
    const contentType = getContentType(doc);

    const fullPath = resolveStoragePath(doc.file_path_or_storage_key);
    if (fullPath && fs.existsSync(fullPath)) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeDispName}"; filename*=UTF-8''${encodedFileName}`);
      return fs.createReadStream(fullPath).pipe(res);
    }

    if (doc.cloudinary_url) {
      return res.redirect(doc.cloudinary_url);
    }

    return res.status(404).json({ error: 'Physical drawing file not found on server storage.' });
  } catch (err) {
    console.error('[Documents API] Download standard drawing error:', err);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// GET /api/documents/:id/view - Inline view (PDF viewer / Image rendering)
router.get('/:id/view', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await query(
      `SELECT d.*, pr.created_by_user_id, pr.pr_number
       FROM documents d
       LEFT JOIN purchase_requests pr ON pr.id = d.purchase_request_id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      // Check standard_drawings fallback
      const stdRes = await query('SELECT * FROM standard_drawings WHERE id = $1', [id]);
      if (stdRes.rowCount > 0) {
        const stdDoc = stdRes.rows[0];
        const safeDispName = stdDoc.original_file_name || stdDoc.file_name;
        const fullPath = resolveStoragePath(stdDoc.file_path_or_storage_key);
        if (fullPath && fs.existsSync(fullPath)) {
          res.setHeader('Content-Type', getContentType(stdDoc));
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(safeDispName)}"`);
          return fs.createReadStream(fullPath).pipe(res);
        }
        if (stdDoc.cloudinary_url) return res.redirect(stdDoc.cloudinary_url);
      }
      return res.status(404).json({ error: 'Document not found.' });
    }
    const doc = result.rows[0];

    // Authorization: Admin has full access; Employee can view own documents, master drawings, and unattached templates
    let isAllowed = (req.user.role === 'ADMIN');
    const ownerId = doc.created_by_user_id || doc.uploaded_by_user_id;
    if (!isAllowed && ownerId && ownerId === req.user.id) {
      isAllowed = true;
    }
    if (!isAllowed) {
      const masterCheck = await query(
        `SELECT 1 FROM ducting_types WHERE master_drawing_document_id = $1`,
        [id]
      );
      if (masterCheck.rowCount > 0) {
        isAllowed = true;
      }
    }
    if (!isAllowed) {
      const prCheck = await query(
        `SELECT 1 FROM pr_items pi
         JOIN purchase_requests pr ON pr.id = pi.purchase_request_id
         WHERE (pi.drawing_document_id = $1 OR pi.id = $2) AND pr.created_by_user_id = $3`,
        [id, doc.purchase_request_item_id || -1, req.user.id]
      );
      if (prCheck.rowCount > 0) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      return res.status(403).json({ error: 'Access Denied — You cannot access another employee’s documents.' });
    }

    const fullPath = resolveStoragePath(doc.file_path_or_storage_key);
    const fileExists = fullPath ? fs.existsSync(fullPath) : false;

    if (!fileExists) {
      return res.status(404).json({ error: 'Physical document file not found on server storage.' });
    }

    const contentType = getContentType(doc);
    const safeDispName = doc.original_file_name || doc.file_name;

    // Log Activity: DOCUMENT_VIEWED
    await logActivity({
      entityType: 'DOCUMENT',
      entityId: String(doc.id),
      action: 'DOCUMENT_VIEWED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        documentId: doc.id,
        documentType: doc.document_type,
        fileName: safeDispName,
        prNumber: doc.pr_number || null,
        prId: doc.purchase_request_id || null,
        itemId: doc.purchase_request_item_id || null
      }
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(safeDispName)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    console.error('[Documents API] View error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// GET /api/documents/:id/download - Stream/Download Document
router.get('/:id/download', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await query(
      `SELECT d.*, pr.created_by_user_id, pr.pr_number
       FROM documents d
       LEFT JOIN purchase_requests pr ON pr.id = d.purchase_request_id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      // Check standard_drawings fallback
      const stdRes = await query('SELECT * FROM standard_drawings WHERE id = $1', [id]);
      if (stdRes.rowCount > 0) {
        const stdDoc = stdRes.rows[0];
        const rawDispName = stdDoc.original_file_name || stdDoc.file_name || `standard_drawing_v${stdDoc.version}`;
        const safeDispName = rawDispName.replace(/["\r\n]/g, '').trim().replace(/[^\w.-]/g, '_');
        const fullPath = resolveStoragePath(stdDoc.file_path_or_storage_key);
        if (fullPath && fs.existsSync(fullPath)) {
          res.setHeader('Content-Type', getContentType(stdDoc));
          res.setHeader('Content-Disposition', `attachment; filename="${safeDispName}"`);
          return fs.createReadStream(fullPath).pipe(res);
        }
        if (stdDoc.cloudinary_url) return res.redirect(stdDoc.cloudinary_url);
      }
      return res.status(404).json({ error: 'Document not found.' });
    }
    const doc = result.rows[0];

    // Authorization: Admin has full access; Employee can download own PR documents, master drawings, and unattached templates
    let isAllowed = (req.user.role === 'ADMIN');
    const ownerId = doc.created_by_user_id || doc.uploaded_by_user_id;
    if (!isAllowed && ownerId && ownerId === req.user.id) {
      isAllowed = true;
    }
    if (!isAllowed) {
      const masterCheck = await query(
        `SELECT 1 FROM ducting_types WHERE master_drawing_document_id = $1`,
        [id]
      );
      if (masterCheck.rowCount > 0) {
        isAllowed = true;
      }
    }
    if (!isAllowed) {
      const prCheck = await query(
        `SELECT 1 FROM pr_items pi
         JOIN purchase_requests pr ON pr.id = pi.purchase_request_id
         WHERE (pi.drawing_document_id = $1 OR pi.id = $2) AND pr.created_by_user_id = $3`,
        [id, doc.purchase_request_item_id || -1, req.user.id]
      );
      if (prCheck.rowCount > 0) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      return res.status(403).json({ error: 'Access Denied — You cannot access another employee’s documents.' });
    }

    const fullPath = resolveStoragePath(doc.file_path_or_storage_key);
    const fileExists = fullPath ? fs.existsSync(fullPath) : false;

    console.log(`[Documents API] Download request - PR ID: ${doc.purchase_request_id || 'N/A'}, Doc ID: ${doc.id}, File: ${doc.file_name}, Resolved Path: ${fullPath}, Exists: ${fileExists}, User: ${req.user.username} (${req.user.role})`);

    if (!fileExists) {
      return res.status(404).json({ error: 'Physical document file not found on server storage.' });
    }

    const contentType = getContentType(doc);
    const rawDispName = doc.original_file_name || doc.file_name || 'drawing';
    const safeDispName = rawDispName.replace(/["\r\n]/g, '').trim().replace(/[^\w.-]/g, '_');
    const encodedFileName = encodeURIComponent(rawDispName);

    // Log Activity: DOCUMENT_DOWNLOADED
    await logActivity({
      entityType: 'DOCUMENT',
      entityId: String(doc.id),
      action: 'DOCUMENT_DOWNLOADED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        documentId: doc.id,
        documentType: doc.document_type,
        fileName: safeDispName,
        prNumber: doc.pr_number || null,
        prId: doc.purchase_request_id || null,
        itemId: doc.purchase_request_item_id || null
      }
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeDispName}"; filename*=UTF-8''${encodedFileName}`);
    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    console.error('[Documents API] Download error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// DELETE /api/documents/:id - Delete Document / Unlink Drawing
router.delete('/:id', async (req, res) => {
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

    const ownerId = doc.created_by_user_id || doc.uploaded_by_user_id;
    if (req.user.role !== 'ADMIN' && ownerId && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Access Denied — You cannot delete this document.' });
    }

    // Unlink from pr_items
    await query(`UPDATE pr_items SET drawing_document_id = NULL WHERE drawing_document_id = $1`, [id]);
    await query(`DELETE FROM documents WHERE id = $1`, [id]);

    // Attempt physical deletion if storage file exists
    try {
      const fullPath = resolveStoragePath(doc.file_path_or_storage_key);
      if (fullPath && fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (e) {
      console.warn('[Documents API] Physical delete warning:', e.message);
    }

    // Log Activity: DOCUMENT_DELETED
    await logActivity({
      entityType: 'DOCUMENT',
      entityId: String(id),
      action: 'DOCUMENT_DELETED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        documentId: id,
        documentType: doc.document_type,
        fileName: doc.original_file_name || doc.file_name
      }
    });

    res.json({ success: true, message: 'Document removed successfully.' });
  } catch (err) {
    console.error('[Documents API] Delete error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

module.exports = router;
module.exports.resolveStoragePath = resolveStoragePath;
