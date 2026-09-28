/**
 * =========================================================================
 * DUCTING TYPES & MASTER DRAWINGS API ROUTER (/api/ducting-types)
 * 
 * Manages reusable master engineering drawings per ducting type:
 * - Straight Duct
 * - Y-Duct
 * - Elbow
 * - Twin Duct
 * 
 * Rules:
 * - Uploaded once per ducting type
 * - Automatically attached to all future PRs for that type
 * - Replaced drawings preserve historical immutability on prior PRs
 * - Emits: DOCUMENT_UPLOADED, DOCUMENT_UPDATED, DOCUMENT_DELETED
 * =========================================================================
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query, pool } = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { logActivity } = require('../services/activityLogger');
const { getDocumentStorageDir } = require('../services/documentGenerator');

router.use(authenticateToken);

// Helper: Normalize type name for URL or slug matching
function normalizeTypeName(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

/**
 * GET /api/ducting-types
 * Returns all ducting types with current master drawing metadata
 */
router.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        dt.id,
        dt.type_name,
        dt.master_drawing_document_id,
        dt.updated_at,
        doc.id AS doc_id,
        doc.file_name,
        doc.original_file_name,
        doc.file_size_bytes,
        doc.mime_type,
        doc.revision AS doc_revision,
        doc.created_at AS doc_created_at,
        doc.uploaded_by_user_id,
        u.full_name AS uploaded_by_full_name,
        u.username AS uploaded_by_username
      FROM ducting_types dt
      LEFT JOIN documents doc ON doc.id = dt.master_drawing_document_id
      LEFT JOIN users u ON u.id = doc.uploaded_by_user_id
      ORDER BY dt.id ASC
    `);

    const ductingTypes = result.rows.map(row => {
      let masterDrawing = null;
      if (row.doc_id) {
        const isPdf = (row.mime_type && row.mime_type.includes('pdf')) || String(row.original_file_name || row.file_name || '').toLowerCase().endsWith('.pdf');
        const finalMime = row.mime_type || (isPdf ? 'application/pdf' : 'image/png');
        masterDrawing = {
          id: row.doc_id,
          documentId: row.doc_id,
          fileName: row.original_file_name || row.file_name,
          originalFilename: row.original_file_name || row.file_name,
          fileSize: row.file_size_bytes ? parseInt(row.file_size_bytes, 10) : 0,
          fileSizeBytes: row.file_size_bytes ? parseInt(row.file_size_bytes, 10) : 0,
          mimeType: finalMime,
          revision: row.doc_revision || 1,
          uploadedAt: row.doc_created_at,
          uploadedByFullName: row.uploaded_by_full_name || row.uploaded_by_username || 'Admin',
          uploadedByUsername: row.uploaded_by_username || 'admin',
          viewUrl: `/api/documents/${row.doc_id}/view`,
          downloadUrl: `/api/documents/${row.doc_id}/download`
        };
      }

      return {
        id: row.id,
        typeName: row.type_name,
        masterDrawingDocumentId: row.master_drawing_document_id,
        hasDrawing: Boolean(row.doc_id),
        masterDrawing,
        drawing: masterDrawing
      };
    });

    res.json({
      success: true,
      types: ductingTypes,
      ductingTypes
    });
  } catch (err) {
    console.error('[DuctingTypes API] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch ducting types: ' + err.message });
  }
});

/**
 * GET /api/ducting-types/:typeName/drawing
 * Returns the current master drawing for a specific ducting type
 */
router.get('/:typeName/drawing', async (req, res) => {
  const { typeName } = req.params;
  const norm = normalizeTypeName(typeName);

  try {
    const result = await query(`
      SELECT 
        dt.id,
        dt.type_name,
        dt.master_drawing_document_id,
        dt.updated_at,
        doc.id AS doc_id,
        doc.file_name,
        doc.original_file_name,
        doc.file_size_bytes,
        doc.mime_type,
        doc.revision AS doc_revision,
        doc.created_at AS doc_created_at,
        u.full_name AS uploaded_by_full_name,
        u.username AS uploaded_by_username
      FROM ducting_types dt
      LEFT JOIN documents doc ON doc.id = dt.master_drawing_document_id
      LEFT JOIN users u ON u.id = doc.uploaded_by_user_id
      WHERE LOWER(REGEXP_REPLACE(dt.type_name, '[^a-zA-Z0-9]', '', 'g')) = $1
    `, [norm]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Ducting type "${typeName}" not found.` });
    }

    const row = result.rows[0];
    let masterDrawing = null;
    if (row.doc_id) {
      const isPdf = (row.mime_type && row.mime_type.includes('pdf')) || String(row.original_file_name || row.file_name || '').toLowerCase().endsWith('.pdf');
      const finalMime = row.mime_type || (isPdf ? 'application/pdf' : 'image/png');
      masterDrawing = {
        id: row.doc_id,
        documentId: row.doc_id,
        fileName: row.original_file_name || row.file_name,
        originalFilename: row.original_file_name || row.file_name,
        fileSize: row.file_size_bytes ? parseInt(row.file_size_bytes, 10) : 0,
        fileSizeBytes: row.file_size_bytes ? parseInt(row.file_size_bytes, 10) : 0,
        mimeType: finalMime,
        revision: row.doc_revision || 1,
        uploadedAt: row.doc_created_at,
        uploadedByFullName: row.uploaded_by_full_name || row.uploaded_by_username,
        uploadedByUsername: row.uploaded_by_username,
        viewUrl: `/api/documents/${row.doc_id}/view`,
        downloadUrl: `/api/documents/${row.doc_id}/download`
      };
    }

    res.json({
      success: true,
      typeName: row.type_name,
      hasDrawing: Boolean(row.doc_id),
      drawing: masterDrawing,
      masterDrawing
    });
  } catch (err) {
    console.error('[DuctingTypes API] GET drawing error:', err);
    res.status(500).json({ error: 'Failed to fetch drawing: ' + err.message });
  }
});

/**
 * POST /api/ducting-types/:typeName/drawing
 * Upload or replace the reusable master drawing for a ducting type
 * Payload: { fileName, mimeType, dataUrl }
 */
router.post('/:typeName/drawing', async (req, res) => {
  const { typeName } = req.params;
  const { fileName, mimeType, dataUrl } = req.body;
  const norm = normalizeTypeName(typeName);

  if (!fileName || !dataUrl) {
    return res.status(400).json({ error: 'File name and data payload are required.' });
  }

  const isPdf = (mimeType && mimeType.includes('pdf')) || fileName.toLowerCase().endsWith('.pdf');
  const isImage = (mimeType && mimeType.startsWith('image/')) || /\.(png|jpe?g|webp|svg)$/i.test(fileName);

  if (!isPdf && !isImage) {
    return res.status(400).json({ error: 'Unsupported file format. Please upload a PDF or image engineering drawing.' });
  }

  try {
    // 1. Check ducting type exists
    const dtRes = await query(`
      SELECT dt.*, doc.revision AS prev_revision, doc.original_file_name AS prev_file_name
      FROM ducting_types dt
      LEFT JOIN documents doc ON doc.id = dt.master_drawing_document_id
      WHERE LOWER(REGEXP_REPLACE(dt.type_name, '[^a-zA-Z0-9]', '', 'g')) = $1
    `, [norm]);

    if (dtRes.rowCount === 0) {
      return res.status(404).json({ error: `Ducting type "${typeName}" not found.` });
    }

    const dt = dtRes.rows[0];
    const previousDocId = dt.master_drawing_document_id;
    const isReplacement = !!previousDocId;
    const nextRevision = (dt.prev_revision ? dt.prev_revision + 1 : (isReplacement ? 2 : 1));

    // 2. Decode and save file to persistent storage
    const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: 'File size exceeds maximum 15 MB limit.' });
    }

    const baseStorage = getDocumentStorageDir();
    const masterDrawingDir = path.join(baseStorage, 'master-drawings', 'ducting');
    if (!fs.existsSync(masterDrawingDir)) {
      fs.mkdirSync(masterDrawingDir, { recursive: true });
    }

    const safeOrigName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const diskFileName = `MASTER_DRW_${norm}_${Date.now()}_${safeOrigName}`;
    const absoluteFilePath = path.join(masterDrawingDir, diskFileName);
    const storageKey = path.relative(process.cwd(), absoluteFilePath).replace(/\\/g, '/');

    fs.writeFileSync(absoluteFilePath, buffer);

    const sha256Checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileSizeBytes = buffer.length;
    const finalMime = mimeType || (isPdf ? 'application/pdf' : 'image/png');

    // 3. Insert new document record (immutable copy)
    const insDoc = await query(`
      INSERT INTO documents (
        document_type,
        file_name,
        original_file_name,
        file_path_or_storage_key,
        uploaded_by_user_id,
        revision,
        sha256_checksum,
        file_size_bytes,
        mime_type
      ) VALUES ('ENGINEERING_DRAWING', $1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, created_at
    `, [
      safeOrigName,
      fileName,
      storageKey,
      req.user.id,
      nextRevision,
      sha256Checksum,
      fileSizeBytes,
      finalMime
    ]);

    const newDocId = insDoc.rows[0].id;

    // 4. Update ducting_types to reference the new master drawing
    await query(`
      UPDATE ducting_types
      SET master_drawing_document_id = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [newDocId, dt.id]);

    // 5. Activity Logging:
    // Log DOCUMENT_UPLOADED for the physical upload
    await logActivity({
      entityType: 'DOCUMENT',
      entityId: String(newDocId),
      action: 'DOCUMENT_UPLOADED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        documentId: newDocId,
        documentType: 'ENGINEERING_DRAWING',
        ductingType: dt.type_name,
        fileName: safeOrigName,
        originalFilename: fileName,
        fileSize: fileSizeBytes,
        isMasterDrawing: true,
        revision: nextRevision
      }
    });

    // If replacement: also log DOCUMENT_UPDATED on the ducting drawing
    if (isReplacement) {
      await logActivity({
        entityType: 'DOCUMENT',
        entityId: String(newDocId),
        action: 'DOCUMENT_UPDATED',
        userId: req.user.id,
        username: req.user.username,
        metadata: {
          documentId: newDocId,
          previousDocumentId: previousDocId,
          previousFileName: dt.prev_file_name,
          documentType: 'ENGINEERING_DRAWING',
          ductingType: dt.type_name,
          fileName: safeOrigName,
          originalFilename: fileName,
          fileSize: fileSizeBytes,
          isMasterDrawing: true,
          revision: nextRevision,
          actionDetail: `Replaced master drawing for ${dt.type_name}`
        }
      });
    }

    const drawingObj = {
      id: newDocId,
      documentId: newDocId,
      fileName: fileName,
      originalFilename: fileName,
      fileSize: fileSizeBytes,
      fileSizeBytes: fileSizeBytes,
      mimeType: finalMime,
      revision: nextRevision,
      uploadedAt: insDoc.rows[0].created_at,
      uploadedByFullName: req.user.fullName || req.user.username,
      uploadedByUsername: req.user.username,
      viewUrl: `/api/documents/${newDocId}/view`,
      downloadUrl: `/api/documents/${newDocId}/download`
    };

    res.status(isReplacement ? 200 : 201).json({
      success: true,
      message: `Master drawing for ${dt.type_name} ${isReplacement ? 'replaced' : 'saved'} successfully.`,
      typeName: dt.type_name,
      action: isReplacement ? 'REPLACED' : 'UPLOADED',
      isReplacement,
      drawing: drawingObj,
      masterDrawing: drawingObj
    });

  } catch (err) {
    console.error('[DuctingTypes API] Upload error:', err);
    res.status(500).json({ error: 'Failed to upload master drawing: ' + err.message });
  }
});

/**
 * DELETE /api/ducting-types/:typeName/drawing
 * Remove the master drawing reference for this ducting type (applies to future PRs).
 * Prior PRs preserve their historical drawing references.
 */
router.delete('/:typeName/drawing', async (req, res) => {
  const { typeName } = req.params;
  const norm = normalizeTypeName(typeName);

  try {
    const dtRes = await query(`
      SELECT dt.*, doc.original_file_name AS prev_file_name
      FROM ducting_types dt
      LEFT JOIN documents doc ON doc.id = dt.master_drawing_document_id
      WHERE LOWER(REGEXP_REPLACE(dt.type_name, '[^a-zA-Z0-9]', '', 'g')) = $1
    `, [norm]);

    if (dtRes.rowCount === 0) {
      return res.status(404).json({ error: `Ducting type "${typeName}" not found.` });
    }

    const dt = dtRes.rows[0];
    const previousDocId = dt.master_drawing_document_id;

    if (!previousDocId) {
      return res.status(400).json({ error: `No master drawing currently assigned to "${dt.type_name}".` });
    }

    // Unlink from ducting_types (does NOT delete physical document to preserve historical PRs)
    await query(`
      UPDATE ducting_types
      SET master_drawing_document_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [dt.id]);

    // Log Activity: DOCUMENT_DELETED
    await logActivity({
      entityType: 'DOCUMENT',
      entityId: String(previousDocId),
      action: 'DOCUMENT_DELETED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        documentId: previousDocId,
        documentType: 'ENGINEERING_DRAWING',
        ductingType: dt.type_name,
        fileName: dt.prev_file_name,
        isMasterDrawing: true,
        actionDetail: `Removed master drawing from ${dt.type_name}`
      }
    });

    res.json({
      success: true,
      message: `Master drawing removed from ${dt.type_name}. Existing PRs retain historical drawings.`
    });
  } catch (err) {
    console.error('[DuctingTypes API] Delete error:', err);
    res.status(500).json({ error: 'Failed to remove master drawing: ' + err.message });
  }
});

module.exports = router;
