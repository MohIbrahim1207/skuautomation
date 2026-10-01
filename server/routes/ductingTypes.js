/**
 * =========================================================================
 * PRODUCTION DUCTING STANDARD DRAWINGS & LIFECYCLE MANAGEMENT ROUTER
 * (/api/ducting-types)
 * 
 * Capabilities:
 * - Dynamic Ducting Types (Straight Duct, Y-Duct, Elbow, Twin Duct, & future types)
 * - Versioned Standard Drawings stored via Cloudinary & PostgreSQL Source-of-Truth
 * - Immutable PR Item Version Snapshots (Past PRs never mutate)
 * - Dual Permissions:
 *     * ADMIN & EMPLOYEE: View, Upload, Replace, Request Removal
 *     * ADMIN ONLY: View Removal Requests, Approve Removal, Reject Removal
 * - Audit Trail: UPLOADED, REPLACED, REMOVAL_REQUESTED, REMOVAL_APPROVED,
 *                REMOVAL_REJECTED, ACTIVATED, DEACTIVATED
 * =========================================================================
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const { query, pool } = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { uploadRateLimiter } = require('../middleware/rateLimiter');
const { logActivity } = require('../services/activityLogger');
const { uploadStandardDrawing, getDuctingTypeSlug, derivePdfThumbnail } = require('../services/cloudinaryService');

router.use(authenticateToken);

function normalizeTypeName(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

/**
 * GET /api/ducting-types
 * Returns all ducting types, active standard drawing details, version, and removal status.
 * Accessible by both ADMIN and EMPLOYEE.
 */
router.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        dt.id,
        dt.type_name,
        dt.status AS type_status,
        dt.current_standard_drawing_id,
        dt.master_drawing_document_id,
        dt.updated_at,
        sd.id AS std_id,
        sd.version AS std_version,
        sd.file_name AS std_file_name,
        sd.original_file_name AS std_orig_file_name,
        sd.file_size_bytes AS std_file_size,
        sd.mime_type AS std_mime_type,
        sd.cloudinary_url AS std_cloudinary_url,
        sd.cloudinary_public_id AS std_cloudinary_public_id,
        sd.thumbnail_url AS std_thumbnail_url,
        sd.status AS std_status,
        sd.uploaded_at AS std_uploaded_at,
        u.full_name AS std_uploaded_by_full_name,
        u.username AS std_uploaded_by_username,
        drr.id AS pending_removal_request_id,
        drr.reason AS pending_removal_reason,
        drr.requested_at AS pending_removal_requested_at,
        u_req.full_name AS pending_removal_requested_by
      FROM ducting_types dt
      LEFT JOIN standard_drawings sd ON sd.id = dt.current_standard_drawing_id
      LEFT JOIN users u ON u.id = sd.uploaded_by_user_id
      LEFT JOIN drawing_removal_requests drr ON drr.standard_drawing_id = sd.id AND drr.status = 'PENDING'
      LEFT JOIN users u_req ON u_req.id = drr.requested_by_user_id
      ORDER BY dt.id ASC
    `);

    const ductingTypes = result.rows.map(row => {
      let drawing = null;
      if (row.std_id) {
        const isPdf = (row.std_mime_type && row.std_mime_type.includes('pdf')) || String(row.std_orig_file_name || row.std_file_name || '').toLowerCase().endsWith('.pdf');
        drawing = {
          id: row.std_id,
          documentId: row.std_id,
          standardDrawingId: row.std_id,
          version: row.std_version || 1,
          fileName: row.std_orig_file_name || row.std_file_name,
          originalFilename: row.std_orig_file_name || row.std_file_name,
          fileSize: row.std_file_size ? parseInt(row.std_file_size, 10) : 0,
          fileSizeBytes: row.std_file_size ? parseInt(row.std_file_size, 10) : 0,
          mimeType: row.std_mime_type || (isPdf ? 'application/pdf' : 'image/png'),
          cloudinaryUrl: row.std_cloudinary_url || null,
          url: row.std_cloudinary_url || null,
          thumbnailUrl: row.std_thumbnail_url || derivePdfThumbnail(row.std_cloudinary_url, row.std_cloudinary_public_id),
          status: row.std_status || 'ACTIVE',
          uploadedAt: row.std_uploaded_at,
          uploadedByFullName: row.std_uploaded_by_full_name || row.std_uploaded_by_username || 'Engineering',
          uploadedByUsername: row.std_uploaded_by_username || 'engineering',
          viewUrl: `/api/documents/standard-drawings/${row.std_id}/view`,
          downloadUrl: `/api/documents/standard-drawings/${row.std_id}/download`
        };
      }

      const hasDrawing = Boolean(row.std_id && row.std_status !== 'REMOVED');
      const isPendingRemoval = Boolean(row.pending_removal_request_id || (drawing && drawing.status === 'PENDING_REMOVAL'));

      return {
        id: row.id,
        typeName: row.type_name,
        name: row.type_name,
        status: row.type_status || 'ACTIVE',
        currentStandardDrawingId: row.current_standard_drawing_id,
        hasDrawing,
        isPendingRemoval,
        pendingRemovalRequest: row.pending_removal_request_id ? {
          id: row.pending_removal_request_id,
          reason: row.pending_removal_reason,
          requestedAt: row.pending_removal_requested_at,
          requestedBy: row.pending_removal_requested_by
        } : null,
        drawing,
        masterDrawing: drawing
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
 * GET /api/ducting-types/:typeName/standard-drawing
 * Returns active standard drawing metadata and current version for a specific ducting type.
 */
router.get('/:typeName/standard-drawing', async (req, res) => {
  const { typeName } = req.params;
  const norm = normalizeTypeName(typeName);

  try {
    const result = await query(`
      SELECT 
        dt.id,
        dt.type_name,
        dt.current_standard_drawing_id,
        dt.status AS type_status,
        sd.id AS std_id,
        sd.version AS std_version,
        sd.file_name AS std_file_name,
        sd.original_file_name AS std_orig_file_name,
        sd.file_size_bytes AS std_file_size,
        sd.mime_type AS std_mime_type,
        sd.cloudinary_url AS std_cloudinary_url,
        sd.cloudinary_public_id AS std_cloudinary_public_id,
        sd.thumbnail_url AS std_thumbnail_url,
        sd.status AS std_status,
        sd.uploaded_at AS std_uploaded_at,
        u.full_name AS std_uploaded_by_full_name,
        dt.master_drawing_document_id,
        u.username AS std_uploaded_by_username,
        drr.id AS pending_removal_request_id,
        drr.reason AS pending_removal_reason
      FROM ducting_types dt
      LEFT JOIN standard_drawings sd ON sd.id = dt.current_standard_drawing_id
      LEFT JOIN users u ON u.id = sd.uploaded_by_user_id
      LEFT JOIN drawing_removal_requests drr ON drr.standard_drawing_id = sd.id AND drr.status = 'PENDING'
      WHERE LOWER(REGEXP_REPLACE(dt.type_name, '[^a-zA-Z0-9]', '', 'g')) = $1
    `, [norm]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Ducting type "${typeName}" not found.` });
    }

    const row = result.rows[0];
    let drawing = null;
    if (row.std_id) {
      const isPdf = (row.std_mime_type && row.std_mime_type.includes('pdf')) || String(row.std_orig_file_name || row.std_file_name || '').toLowerCase().endsWith('.pdf');
      drawing = {
        id: row.std_id,
        documentId: row.master_drawing_document_id || row.std_id,
        standardDrawingId: row.std_id,
        version: row.std_version || 1,
        fileName: row.std_orig_file_name || row.std_file_name,
        originalFilename: row.std_orig_file_name || row.std_file_name,
        fileSize: row.std_file_size ? parseInt(row.std_file_size, 10) : 0,
        mimeType: row.std_mime_type || (isPdf ? 'application/pdf' : 'image/png'),
        cloudinaryUrl: row.std_cloudinary_url || null,
        url: row.std_cloudinary_url || null,
        thumbnailUrl: row.std_thumbnail_url || derivePdfThumbnail(row.std_cloudinary_url, row.std_cloudinary_public_id),
        status: row.std_status || 'ACTIVE',
        uploadedAt: row.std_uploaded_at,
        uploadedByFullName: row.std_uploaded_by_full_name || row.std_uploaded_by_username,
        uploadedByUsername: row.std_uploaded_by_username,
        viewUrl: `/api/documents/standard-drawings/${row.std_id}/view`,
        downloadUrl: `/api/documents/standard-drawings/${row.std_id}/download`
      };
    }

    res.json({
      success: true,
      typeName: row.type_name,
      hasDrawing: Boolean(row.std_id && row.std_status !== 'REMOVED'),
      isPendingRemoval: Boolean(row.pending_removal_request_id || (drawing && drawing.status === 'PENDING_REMOVAL')),
      drawing,
      masterDrawing: drawing
    });
  } catch (err) {
    console.error('[DuctingTypes API] GET standard-drawing error:', err);
    res.status(500).json({ error: 'Failed to fetch standard drawing: ' + err.message });
  }
});

/**
 * Backward compatibility route: GET /api/ducting-types/:typeName/drawing
 */
router.get('/:typeName/drawing', async (req, res) => {
  const { typeName } = req.params;
  const norm = normalizeTypeName(typeName);

  try {
    const result = await query(`
      SELECT 
        dt.id,
        dt.type_name,
        dt.current_standard_drawing_id,
        dt.master_drawing_document_id,
        sd.id AS std_id,
        sd.version AS std_version,
        sd.file_name AS std_file_name,
        sd.original_file_name AS std_orig_file_name,
        sd.file_size_bytes AS std_file_size,
        sd.mime_type AS std_mime_type,
        sd.cloudinary_url AS std_cloudinary_url,
        sd.status AS std_status,
        sd.uploaded_at AS std_uploaded_at,
        u.full_name AS std_uploaded_by_full_name,
        u.username AS std_uploaded_by_username,
        drr.id AS pending_removal_request_id
      FROM ducting_types dt
      LEFT JOIN standard_drawings sd ON sd.id = dt.current_standard_drawing_id
      LEFT JOIN users u ON u.id = sd.uploaded_by_user_id
      LEFT JOIN drawing_removal_requests drr ON drr.standard_drawing_id = sd.id AND drr.status = 'PENDING'
      WHERE LOWER(REGEXP_REPLACE(dt.type_name, '[^a-zA-Z0-9]', '', 'g')) = $1
    `, [norm]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Ducting type "${typeName}" not found.` });
    }

    const row = result.rows[0];
    let drawing = null;
    if (row.std_id) {
      const isPdf = (row.std_mime_type && row.std_mime_type.includes('pdf')) || String(row.std_orig_file_name || row.std_file_name || '').toLowerCase().endsWith('.pdf');
      drawing = {
        id: row.std_id,
        documentId: row.master_drawing_document_id || row.std_id,
        standardDrawingId: row.std_id,
        revision: row.std_version || 1,
        version: row.std_version || 1,
        fileName: row.std_orig_file_name || row.std_file_name,
        originalFilename: row.std_orig_file_name || row.std_file_name,
        fileSize: row.std_file_size ? parseInt(row.std_file_size, 10) : 0,
        fileSizeBytes: row.std_file_size ? parseInt(row.std_file_size, 10) : 0,
        mimeType: row.std_mime_type || (isPdf ? 'application/pdf' : 'image/png'),
        cloudinaryUrl: row.std_cloudinary_url || null,
        url: row.std_cloudinary_url || null,
        status: row.std_status || 'ACTIVE',
        uploadedAt: row.std_uploaded_at,
        uploadedByFullName: row.std_uploaded_by_full_name || row.std_uploaded_by_username,
        uploadedByUsername: row.std_uploaded_by_username,
        viewUrl: `/api/documents/standard-drawings/${row.std_id}/view`,
        downloadUrl: `/api/documents/standard-drawings/${row.std_id}/download`
      };
    }

    res.json({
      success: true,
      typeName: row.type_name,
      hasDrawing: Boolean(row.std_id && row.std_status !== 'REMOVED'),
      isPendingRemoval: Boolean(row.pending_removal_request_id || (drawing && drawing.status === 'PENDING_REMOVAL')),
      drawing,
      masterDrawing: drawing
    });
  } catch (err) {
    console.error('[DuctingTypes API] GET drawing error:', err);
    res.status(500).json({ error: 'Failed to fetch drawing: ' + err.message });
  }
});

/**
 * GET /api/ducting-types/:typeName/history
 * Returns complete version history of standard drawings for a ducting type.
 */
router.get('/:typeName/history', async (req, res) => {
  const { typeName } = req.params;
  const norm = normalizeTypeName(typeName);

  try {
    const dtRes = await query(`
      SELECT id, type_name, current_standard_drawing_id
      FROM ducting_types
      WHERE LOWER(REGEXP_REPLACE(type_name, '[^a-zA-Z0-9]', '', 'g')) = $1
    `, [norm]);

    if (dtRes.rowCount === 0) {
      return res.status(404).json({ error: `Ducting type "${typeName}" not found.` });
    }

    const dt = dtRes.rows[0];
    const historyRes = await query(`
      SELECT 
        sd.*,
        u.full_name AS uploaded_by_full_name,
        u.username AS uploaded_by_username
      FROM standard_drawings sd
      LEFT JOIN users u ON u.id = sd.uploaded_by_user_id
      WHERE sd.ducting_type_id = $1
      ORDER BY sd.version DESC
    `, [dt.id]);

    const versions = historyRes.rows.map(sd => ({
      id: sd.id,
      version: sd.version,
      fileName: sd.original_file_name || sd.file_name,
      fileSize: sd.file_size_bytes ? parseInt(sd.file_size_bytes, 10) : 0,
      mimeType: sd.mime_type,
      status: sd.status,
      isCurrent: sd.id === dt.current_standard_drawing_id,
      uploadedAt: sd.uploaded_at,
      uploadedByName: sd.uploaded_by_full_name || sd.uploaded_by_username || 'Engineering',
      viewUrl: `/api/documents/standard-drawings/${sd.id}/view`,
      downloadUrl: `/api/documents/standard-drawings/${sd.id}/download`
    }));

    res.json({
      success: true,
      typeName: dt.type_name,
      currentStandardDrawingId: dt.current_standard_drawing_id,
      versions
    });
  } catch (err) {
    console.error('[DuctingTypes API] History error:', err);
    res.status(500).json({ error: 'Failed to fetch drawing history: ' + err.message });
  }
});

/**
 * Validate actual magic bytes of uploaded drawing files (PRIORITY 2 - File Security).
 * Validates actual binary signatures:
 * - PDF: %PDF- (0x25 0x50 0x44 0x46 0x2D)
 * - PNG: 89 50 4E 47 (0x89 0x50 0x4E 0x47)
 * - JPEG: FF D8 FF (0xFF 0xD8 0xFF)
 */
function validateDrawingMagicBytes(buffer) {
  if (!buffer || buffer.length < 4) {
    return { valid: false, error: 'File payload is empty or corrupted.' };
  }

  // 1. PDF signature: %PDF- (0x25 0x50 0x44 0x46 0x2D)
  const isPdf = (buffer.length >= 5 && buffer.slice(0, 5).toString('ascii') === '%PDF-') ||
                (buffer.indexOf(Buffer.from('%PDF-')) >= 0 && buffer.indexOf(Buffer.from('%PDF-')) < 1024);

  // 2. PNG signature: 89 50 4E 47 (0x89 0x50 0x4E 0x47)
  const isPng = buffer.length >= 4 &&
                buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;

  // 3. JPEG signature: FF D8 FF (0xFF 0xD8 0xFF)
  const isJpeg = buffer.length >= 3 &&
                 buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;

  if (isPdf) {
    return { valid: true, type: 'PDF', mimeType: 'application/pdf', extension: '.pdf' };
  }
  if (isPng) {
    return { valid: true, type: 'PNG', mimeType: 'image/png', extension: '.png' };
  }
  if (isJpeg) {
    return { valid: true, type: 'JPEG', mimeType: 'image/jpeg', extension: '.jpg' };
  }

  return {
    valid: false,
    error: 'Invalid file signature (magic bytes mismatch). Only authentic PDF (%PDF-), PNG (89 50 4E 47), and JPEG (FF D8 FF) engineering drawings are permitted.'
  };
}

/**
 * Unified Handler: Upload or Replace Standard Drawing
 * Both ADMIN and EMPLOYEE are allowed to upload and update standard drawings.
 * Uses PostgreSQL row-level locking (SELECT ... FOR UPDATE) to guarantee race-free versioning.
 */
async function handleStandardDrawingUpload(req, res) {
  const { typeName } = req.params;
  const { fileName, mimeType, dataUrl } = req.body;
  const norm = normalizeTypeName(typeName);

  if (!fileName || !dataUrl) {
    return res.status(400).json({ error: 'File name and data payload are required.' });
  }

  try {
    // 1. Decode base64 buffer
    const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // 2. Validate file size (15 MB maximum)
    if (buffer.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: 'File size exceeds maximum 15 MB limit.' });
    }

    // 3. Validate Magic Bytes (PRIORITY 2 - File Security)
    const magicValidation = validateDrawingMagicBytes(buffer);
    if (!magicValidation.valid) {
      return res.status(400).json({ error: magicValidation.error });
    }

    const determinedMimeType = magicValidation.mimeType;

    // 4. Resolve or create ducting type dynamically to support future types
    let dtRes = await query(`
      SELECT dt.*, sd.version AS current_version, sd.file_name AS current_file_name
      FROM ducting_types dt
      LEFT JOIN standard_drawings sd ON sd.id = dt.current_standard_drawing_id
      WHERE LOWER(REGEXP_REPLACE(dt.type_name, '[^a-zA-Z0-9]', '', 'g')) = $1
    `, [norm]);

    let dt;
    if (dtRes.rowCount === 0) {
      const insType = await query(`
        INSERT INTO ducting_types (type_name, status)
        VALUES ($1, 'ACTIVE')
        RETURNING *
      `, [typeName.trim()]);
      dt = insType.rows[0];
    } else {
      dt = dtRes.rows[0];
    }

    // 5. PRIORITY 1 — Concurrency Transaction with Row-Level Locking (SELECT ... FOR UPDATE)
    const client = await pool.connect();
    let newStdId;
    let legacyDocId;
    let nextVersion;
    let isReplacement;
    let uploadMeta;
    let thumbnailUrl;
    let stdCreatedAt;

    try {
      await client.query('BEGIN');

      // Row-level exclusive lock on the ducting type row
      const lockRes = await client.query(`
        SELECT id, type_name, current_standard_drawing_id
        FROM ducting_types
        WHERE id = $1
        FOR UPDATE
      `, [dt.id]);

      const lockedDt = lockRes.rows[0];

      // Calculate next version while locked (guarantees strictly incremented versions without collisions)
      const maxVerRes = await client.query(`
        SELECT COALESCE(MAX(version), 0) AS max_v
        FROM standard_drawings
        WHERE ducting_type_id = $1
      `, [dt.id]);
      nextVersion = parseInt(maxVerRes.rows[0].max_v, 10) + 1;
      isReplacement = nextVersion > 1 && Boolean(lockedDt.current_standard_drawing_id);

      // Upload to Cloudinary (with local disk caching)
      uploadMeta = await uploadStandardDrawing({
        buffer,
        fileName,
        mimeType: determinedMimeType,
        typeName: dt.type_name,
        version: nextVersion
      });

      thumbnailUrl = uploadMeta.thumbnailUrl || derivePdfThumbnail(uploadMeta.cloudinaryUrl, uploadMeta.cloudinaryPublicId);

      // Insert new standard_drawings row
      const insStd = await client.query(`
        INSERT INTO standard_drawings (
          ducting_type_id, version, file_name, original_file_name,
          file_size_bytes, mime_type, cloudinary_public_id, cloudinary_url,
          file_path_or_storage_key, uploaded_by_user_id, status, thumbnail_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11)
        RETURNING id, created_at
      `, [
        dt.id,
        nextVersion,
        uploadMeta.fileName,
        uploadMeta.originalFileName,
        uploadMeta.fileSizeBytes,
        uploadMeta.mimeType,
        uploadMeta.cloudinaryPublicId,
        uploadMeta.cloudinaryUrl,
        uploadMeta.storageKey,
        req.user.id,
        thumbnailUrl || null
      ]);
      newStdId = insStd.rows[0].id;
      stdCreatedAt = insStd.rows[0].created_at;

      // Also register document record for backward-compatible document queries
      const insDoc = await client.query(`
        INSERT INTO documents (
          document_type, file_name, original_file_name, file_path_or_storage_key,
          uploaded_by_user_id, revision, sha256_checksum, file_size_bytes, mime_type
        ) VALUES ('ENGINEERING_DRAWING', $1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `, [
        uploadMeta.fileName,
        uploadMeta.originalFileName,
        uploadMeta.storageKey,
        req.user.id,
        nextVersion,
        uploadMeta.sha256,
        uploadMeta.fileSizeBytes,
        uploadMeta.mimeType
      ]);
      legacyDocId = insDoc.rows[0].id;

      // Update ducting_types to reference new standard drawing as current
      await client.query(`
        UPDATE ducting_types
        SET current_standard_drawing_id = $1, master_drawing_document_id = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [newStdId, legacyDocId, dt.id]);

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // 6. Audit Logging: UPLOADED / REPLACED & ACTIVATED
    const primaryAction = isReplacement ? 'REPLACED' : 'UPLOADED';

    await logActivity({
      entityType: 'STANDARD_DRAWING',
      entityId: String(newStdId),
      action: primaryAction,
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        drawingId: newStdId,
        ductingType: dt.type_name,
        version: nextVersion,
        fileName: uploadMeta.fileName,
        originalFilename: fileName,
        fileSize: uploadMeta.fileSizeBytes,
        cloudinaryUrl: uploadMeta.cloudinaryUrl,
        uploadedBy: req.user.username,
        uploadedByRole: req.user.role,
        isReplacement
      }
    });

    await logActivity({
      entityType: 'STANDARD_DRAWING',
      entityId: String(newStdId),
      action: 'ACTIVATED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        drawingId: newStdId,
        ductingType: dt.type_name,
        version: nextVersion,
        status: 'ACTIVE'
      }
    });

    // Backward-compatible DOCUMENT_UPLOADED / DOCUMENT_UPDATED logs
    await logActivity({
      entityType: 'DOCUMENT',
      entityId: String(legacyDocId || newStdId),
      action: isReplacement ? 'DOCUMENT_UPDATED' : 'DOCUMENT_UPLOADED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        documentId: legacyDocId || newStdId,
        documentType: 'ENGINEERING_DRAWING',
        ductingType: dt.type_name,
        fileName: uploadMeta.fileName,
        revision: nextVersion
      }
    });

    const drawingObj = {
      id: newStdId,
      documentId: legacyDocId || newStdId,
      standardDrawingId: newStdId,
      version: nextVersion,
      revision: nextVersion,
      fileName: uploadMeta.fileName,
      originalFilename: fileName,
      fileSize: uploadMeta.fileSizeBytes,
      fileSizeBytes: uploadMeta.fileSizeBytes,
      mimeType: uploadMeta.mimeType,
      cloudinaryUrl: uploadMeta.cloudinaryUrl,
      url: uploadMeta.cloudinaryUrl,
      thumbnailUrl: thumbnailUrl || null,
      status: 'ACTIVE',
      uploadedAt: stdCreatedAt || new Date().toISOString(),
      uploadedByFullName: req.user.fullName || req.user.username,
      uploadedByUsername: req.user.username,
      viewUrl: `/api/documents/standard-drawings/${newStdId}/view`,
      downloadUrl: `/api/documents/standard-drawings/${newStdId}/download`
    };

    res.status(isReplacement ? 200 : 201).json({
      success: true,
      message: `Standard drawing for ${dt.type_name} ${isReplacement ? 'replaced (Version ' + nextVersion + ')' : 'saved (Version 1)'} successfully.`,
      typeName: dt.type_name,
      action: primaryAction,
      isReplacement,
      version: nextVersion,
      drawing: drawingObj,
      masterDrawing: drawingObj
    });

  } catch (err) {
    console.error('[DuctingTypes API] Standard drawing upload error:', err);
    res.status(500).json({ error: 'Failed to upload standard drawing: ' + err.message });
  }
}

/**
 * POST /api/ducting-types/:typeName/standard-drawing
 * Protected with upload rate limiting (PRIORITY 3)
 */
router.post('/:typeName/standard-drawing', uploadRateLimiter, handleStandardDrawingUpload);

/**
 * Backward-compatible endpoint: POST /api/ducting-types/:typeName/drawing
 * Protected with upload rate limiting (PRIORITY 3)
 */
router.post('/:typeName/drawing', uploadRateLimiter, handleStandardDrawingUpload);

/**
 * POST /api/ducting-types/standard-drawings/:drawingId/request-removal
 * Both ADMIN and EMPLOYEE can request removal.
 * Sets status to PENDING_REMOVAL. Does NOT delete file or break PR references!
 */
router.post('/standard-drawings/:drawingId/request-removal', async (req, res) => {
  const { drawingId } = req.params;
  const { reason } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A valid reason is required to request drawing removal.' });
  }

  try {
    const stdRes = await query(`
      SELECT sd.*, dt.type_name
      FROM standard_drawings sd
      JOIN ducting_types dt ON dt.id = sd.ducting_type_id
      WHERE sd.id = $1
    `, [parseInt(drawingId, 10)]);

    if (stdRes.rowCount === 0) {
      return res.status(404).json({ error: 'Standard drawing not found.' });
    }

    const drawing = stdRes.rows[0];

    // Check if there is already an active pending request
    const existingReq = await query(`
      SELECT id FROM drawing_removal_requests
      WHERE standard_drawing_id = $1 AND status = 'PENDING'
    `, [drawing.id]);

    if (existingReq.rowCount > 0) {
      return res.status(400).json({ error: 'A removal request for this drawing is already pending Admin review.' });
    }

    // Insert removal request
    const insReq = await query(`
      INSERT INTO drawing_removal_requests (
        standard_drawing_id, requested_by_user_id, reason, status
      ) VALUES ($1, $2, $3, 'PENDING')
      RETURNING id, requested_at
    `, [drawing.id, req.user.id, String(reason).trim()]);

    const reqId = insReq.rows[0].id;

    // Set drawing status to PENDING_REMOVAL
    await query(`
      UPDATE standard_drawings
      SET status = 'PENDING_REMOVAL', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [drawing.id]);

    // Audit Log: REMOVAL_REQUESTED
    await logActivity({
      entityType: 'STANDARD_DRAWING',
      entityId: String(drawing.id),
      action: 'REMOVAL_REQUESTED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        requestId: reqId,
        drawingId: drawing.id,
        ductingType: drawing.type_name,
        version: drawing.version,
        reason: String(reason).trim(),
        requestedBy: req.user.username
      }
    });

    res.json({
      success: true,
      message: `Removal request submitted for ${drawing.type_name} (Version ${drawing.version}). Status is now PENDING_REMOVAL pending Admin review.`,
      requestId: reqId,
      removalRequestId: reqId
    });
  } catch (err) {
    console.error('[DuctingTypes API] Removal request error:', err);
    res.status(500).json({ error: 'Failed to submit removal request: ' + err.message });
  }
});

/**
 * Backward-compatible endpoint: DELETE /api/ducting-types/:typeName/drawing
 * Routes to removal request or administrative removal.
 */
router.delete('/:typeName/drawing', async (req, res) => {
  const { typeName } = req.params;
  const norm = normalizeTypeName(typeName);

  try {
    const dtRes = await query(`
      SELECT dt.*, sd.id AS std_id, sd.version, sd.file_name
      FROM ducting_types dt
      LEFT JOIN standard_drawings sd ON sd.id = dt.current_standard_drawing_id
      WHERE LOWER(REGEXP_REPLACE(dt.type_name, '[^a-zA-Z0-9]', '', 'g')) = $1
    `, [norm]);

    if (dtRes.rowCount === 0) {
      return res.status(404).json({ error: `Ducting type "${typeName}" not found.` });
    }

    const dt = dtRes.rows[0];
    if (!dt.std_id && !dt.master_drawing_document_id) {
      return res.status(400).json({ error: `No standard drawing assigned to "${dt.type_name}".` });
    }

    const drawingId = dt.std_id || dt.master_drawing_document_id;

    // Unlink from ducting_types (does not destroy historical PR references)
    await query(`
      UPDATE ducting_types
      SET current_standard_drawing_id = NULL, master_drawing_document_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [dt.id]);

    if (dt.std_id) {
      await query(`UPDATE standard_drawings SET status = 'INACTIVE' WHERE id = $1`, [dt.std_id]);
    }

    // Log Activity
    await logActivity({
      entityType: 'STANDARD_DRAWING',
      entityId: String(drawingId),
      action: 'DEACTIVATED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        drawingId,
        ductingType: dt.type_name,
        actionDetail: `Unlinked master drawing from ${dt.type_name}`
      }
    });

    const docEntityId = dt.master_drawing_document_id || drawingId;
    await logActivity({
      entityType: 'DOCUMENT',
      entityId: String(docEntityId),
      action: 'DOCUMENT_DELETED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        documentId: docEntityId,
        ductingType: dt.type_name
      }
    });

    res.json({
      success: true,
      message: `Standard drawing unlinked from ${dt.type_name}. Historical PR references remain intact.`
    });
  } catch (err) {
    console.error('[DuctingTypes API] Delete error:', err);
    res.status(500).json({ error: 'Failed to remove drawing: ' + err.message });
  }
});

/**
 * =========================================================================
 * ADMIN-ONLY REMOVAL APPROVAL WORKFLOW
 * =========================================================================
 */

/**
 * GET /api/ducting-types/removal-requests
 * Lists all pending and past removal requests.
 * ONLY ADMIN can view removal requests.
 */
router.get('/removal-requests', async (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access Denied — Only System Administrators can review drawing removal requests.' });
  }

  try {
    const result = await query(`
      SELECT 
        drr.*,
        sd.version AS drawing_version,
        sd.file_name AS drawing_file_name,
        sd.original_file_name AS drawing_orig_name,
        sd.status AS drawing_status,
        dt.type_name AS ducting_type_name,
        dt.id AS ducting_type_id,
        u_req.full_name AS requested_by_full_name,
        u_req.username AS requested_by_username,
        u_rev.full_name AS reviewed_by_full_name,
        u_rev.username AS reviewed_by_username
      FROM drawing_removal_requests drr
      JOIN standard_drawings sd ON sd.id = drr.standard_drawing_id
      JOIN ducting_types dt ON dt.id = sd.ducting_type_id
      LEFT JOIN users u_req ON u_req.id = drr.requested_by_user_id
      LEFT JOIN users u_rev ON u_rev.id = drr.reviewed_by_user_id
      ORDER BY 
        CASE WHEN drr.status = 'PENDING' THEN 1 ELSE 2 END,
        drr.requested_at DESC
    `);

    const requests = result.rows.map(r => ({
      id: r.id,
      standardDrawingId: r.standard_drawing_id,
      ductingTypeName: r.ducting_type_name,
      ductingTypeId: r.ducting_type_id,
      drawingVersion: r.drawing_version,
      drawingFileName: r.drawing_orig_name || r.drawing_file_name,
      reason: r.reason,
      status: r.status,
      requestedAt: r.requested_at,
      requestedBy: r.requested_by_full_name || r.requested_by_username || 'Employee',
      requestedByUsername: r.requested_by_username,
      reviewedAt: r.reviewed_at,
      reviewedBy: r.reviewed_by_full_name || r.reviewed_by_username,
      adminComment: r.admin_comment
    }));

    res.json({
      success: true,
      requests
    });
  } catch (err) {
    console.error('[DuctingTypes API] Removal requests list error:', err);
    res.status(500).json({ error: 'Failed to fetch removal requests: ' + err.message });
  }
});

/**
 * POST /api/ducting-types/removal-requests/:id/approve
 * Admin approves removal request:
 * - Request becomes APPROVED
 * - Drawing becomes REMOVED / INACTIVE
 * - Unlinked from ducting_types.current_standard_drawing_id
 * - Historical PR records remain intact
 * - Emits REMOVAL_APPROVED and DEACTIVATED audit logs
 */
router.post('/removal-requests/:id/approve', async (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access Denied — Only System Administrators can approve drawing removal requests.' });
  }

  const { id } = req.params;
  const { adminComment } = req.body || {};

  try {
    const reqRes = await query(`
      SELECT drr.*, sd.ducting_type_id, sd.version, sd.file_name, dt.type_name, dt.current_standard_drawing_id
      FROM drawing_removal_requests drr
      JOIN standard_drawings sd ON sd.id = drr.standard_drawing_id
      JOIN ducting_types dt ON dt.id = sd.ducting_type_id
      WHERE drr.id = $1
    `, [parseInt(id, 10)]);

    if (reqRes.rowCount === 0) {
      return res.status(404).json({ error: 'Removal request not found.' });
    }

    const r = reqRes.rows[0];

    if (r.status !== 'PENDING') {
      return res.status(400).json({ error: `This removal request is already ${r.status}.` });
    }

    // 1. Update removal request to APPROVED
    await query(`
      UPDATE drawing_removal_requests
      SET status = 'APPROVED', reviewed_by_user_id = $1, reviewed_at = CURRENT_TIMESTAMP, admin_comment = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [req.user.id, adminComment ? String(adminComment).trim() : null, r.id]);

    // 2. Mark standard drawing as REMOVED (preserves historical PR references)
    await query(`
      UPDATE standard_drawings
      SET status = 'REMOVED', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [r.standard_drawing_id]);

    // 3. Unlink from ducting_types if it was current
    if (r.current_standard_drawing_id === r.standard_drawing_id) {
      await query(`
        UPDATE ducting_types
        SET current_standard_drawing_id = NULL, master_drawing_document_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [r.ducting_type_id]);
    }

    // 4. Audit Logging: REMOVAL_APPROVED & DEACTIVATED
    await logActivity({
      entityType: 'STANDARD_DRAWING',
      entityId: String(r.standard_drawing_id),
      action: 'REMOVAL_APPROVED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        requestId: r.id,
        drawingId: r.standard_drawing_id,
        ductingType: r.type_name,
        version: r.version,
        approvedBy: req.user.username,
        adminComment: adminComment || null
      }
    });

    await logActivity({
      entityType: 'STANDARD_DRAWING',
      entityId: String(r.standard_drawing_id),
      action: 'DEACTIVATED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        drawingId: r.standard_drawing_id,
        ductingType: r.type_name,
        version: r.version,
        status: 'REMOVED'
      }
    });

    res.json({
      success: true,
      message: `Removal request approved. Standard drawing for ${r.type_name} (Version ${r.version}) is now REMOVED. Historical PRs remain intact.`
    });
  } catch (err) {
    console.error('[DuctingTypes API] Approve error:', err);
    res.status(500).json({ error: 'Failed to approve removal: ' + err.message });
  }
});

/**
 * POST /api/ducting-types/removal-requests/:id/reject
 * Admin rejects removal request:
 * - Request becomes REJECTED
 * - Drawing is restored to ACTIVE
 * - Emits REMOVAL_REJECTED audit log
 */
router.post('/removal-requests/:id/reject', async (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Access Denied — Only System Administrators can reject drawing removal requests.' });
  }

  const { id } = req.params;
  const { adminComment } = req.body || {};

  try {
    const reqRes = await query(`
      SELECT drr.*, sd.ducting_type_id, sd.version, sd.file_name, dt.type_name
      FROM drawing_removal_requests drr
      JOIN standard_drawings sd ON sd.id = drr.standard_drawing_id
      JOIN ducting_types dt ON dt.id = sd.ducting_type_id
      WHERE drr.id = $1
    `, [parseInt(id, 10)]);

    if (reqRes.rowCount === 0) {
      return res.status(404).json({ error: 'Removal request not found.' });
    }

    const r = reqRes.rows[0];

    if (r.status !== 'PENDING') {
      return res.status(400).json({ error: `This removal request is already ${r.status}.` });
    }

    // 1. Update removal request to REJECTED
    await query(`
      UPDATE drawing_removal_requests
      SET status = 'REJECTED', reviewed_by_user_id = $1, reviewed_at = CURRENT_TIMESTAMP, admin_comment = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [req.user.id, adminComment ? String(adminComment).trim() : null, r.id]);

    // 2. Restore standard drawing to ACTIVE
    await query(`
      UPDATE standard_drawings
      SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [r.standard_drawing_id]);

    // 3. Audit Logging: REMOVAL_REJECTED
    await logActivity({
      entityType: 'STANDARD_DRAWING',
      entityId: String(r.standard_drawing_id),
      action: 'REMOVAL_REJECTED',
      userId: req.user.id,
      username: req.user.username,
      metadata: {
        requestId: r.id,
        drawingId: r.standard_drawing_id,
        ductingType: r.type_name,
        version: r.version,
        rejectedBy: req.user.username,
        adminComment: adminComment || null
      }
    });

    res.json({
      success: true,
      message: `Removal request rejected. Standard drawing for ${r.type_name} (Version ${r.version}) remains ACTIVE.`
    });
  } catch (err) {
    console.error('[DuctingTypes API] Reject error:', err);
    res.status(500).json({ error: 'Failed to reject removal: ' + err.message });
  }
});

module.exports = router;
