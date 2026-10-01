/**
 * =========================================================================
 * FLOW FORCE CLOUDINARY & RESILIENT STORAGE SERVICE
 * Production Cloudinary integration for Ducting Standard & PR Drawings
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { getDocumentStorageDir } = require('./documentGenerator');

let isCloudinaryConfigured = false;

// Configure Cloudinary if environment variables are present
if (process.env.CLOUDINARY_URL) {
  try {
    cloudinary.config();
    isCloudinaryConfigured = true;
    console.log('[CloudinaryService] Configured via CLOUDINARY_URL');
  } catch (err) {
    console.warn('[CloudinaryService] Failed to configure from CLOUDINARY_URL:', err.message);
  }
} else if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  try {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });
    isCloudinaryConfigured = true;
    console.log(`[CloudinaryService] Configured with cloud_name: ${process.env.CLOUDINARY_CLOUD_NAME}`);
  } catch (err) {
    console.warn('[CloudinaryService] Failed to configure with explicit credentials:', err.message);
  }
} else {
  console.log('[CloudinaryService] No Cloudinary credentials found in environment. Local persistent storage fallback active.');
}

/**
 * Returns a slugified folder name for a ducting type
 * e.g. "Straight Duct" -> "straight-duct", "Y-Duct" -> "y-duct", "Elbow" -> "elbow"
 */
function getDuctingTypeSlug(typeName) {
  return String(typeName || 'general')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'general';
}

/**
 * Uploads a standard ducting drawing to Cloudinary (with local disk caching)
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - Drawing file buffer
 * @param {string} params.fileName - Original file name
 * @param {string} params.mimeType - MIME type (e.g. application/pdf, image/png)
 * @param {string} params.typeName - Ducting type name (e.g. Straight Duct, Y-Duct)
 * @param {number} params.version - Drawing version number
 * @returns {Promise<Object>} Upload result metadata
 */
async function uploadStandardDrawing({ buffer, fileName, mimeType, typeName, version = 1 }) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Valid buffer is required for upload');
  }

  const typeSlug = getDuctingTypeSlug(typeName);
  const isPdf = (mimeType && mimeType.includes('pdf')) || String(fileName).toLowerCase().endsWith('.pdf');
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const uniqueTag = `v${version}_${Date.now()}`;
  const diskFileName = `STD_${typeSlug}_${uniqueTag}_${safeName}`;

  // 1. Always save local cache for instantaneous PDF appendix generation and fallback
  const baseStorage = getDocumentStorageDir();
  const localDir = path.join(baseStorage, 'master-drawings', 'ducting', typeSlug);
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  const absoluteLocalPath = path.join(localDir, diskFileName);
  fs.writeFileSync(absoluteLocalPath, buffer);
  const storageKey = path.relative(process.cwd(), absoluteLocalPath).replace(/\\/g, '/');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // 2. Upload to Cloudinary if configured
  let cloudinaryPublicId = null;
  let cloudinaryUrl = null;
  let cloudinarySecureUrl = null;
  let thumbnailUrl = null;

  if (isCloudinaryConfigured) {
    try {
      const folder = `flowforce/ducting/standard-drawings/${typeSlug}`;
      // In Cloudinary, uploading PDF as 'image' or 'auto' allows page-by-page transformation (pg_1 thumbnail)
      const resourceType = isPdf ? 'image' : 'image';
      const publicId = `${typeSlug}_${uniqueTag}`;

      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            public_id: publicId,
            resource_type: resourceType,
            overwrite: true
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        stream.end(buffer);
      });

      cloudinaryPublicId = uploadResult.public_id;
      cloudinaryUrl = uploadResult.url;
      cloudinarySecureUrl = uploadResult.secure_url;

      if (isPdf) {
        thumbnailUrl = cloudinary.url(uploadResult.public_id, {
          resource_type: 'image',
          page: 1,
          format: 'jpg',
          width: 1000,
          crop: 'limit',
          quality: 'auto',
          secure: true
        });
      }

      console.log(`[CloudinaryService] Uploaded ${fileName} to ${folder}/${publicId}`);
    } catch (cldErr) {
      console.error(`[CloudinaryService] Cloudinary upload failure for ${fileName}:`, cldErr.message);
      // In production, do NOT silently fall back to local disk if Cloudinary is configured but fails
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`Production Cloudinary storage failure: ${cldErr.message}. Cannot fall back to non-persistent storage in production.`);
      }
      // Non-production fallback preserves local storage for dev/testing
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.warn(`[CloudinaryService] WARNING: Running in production without Cloudinary credentials configured!`);
  }

  return {
    fileName: safeName,
    originalFileName: fileName,
    fileSizeBytes: buffer.length,
    mimeType: mimeType || (isPdf ? 'application/pdf' : 'image/png'),
    sha256,
    storageKey,
    absoluteLocalPath,
    cloudinaryPublicId,
    cloudinaryUrl: cloudinarySecureUrl || cloudinaryUrl || null,
    thumbnailUrl,
    isCloudinaryStored: Boolean(cloudinarySecureUrl || cloudinaryUrl)
  };
}

/**
 * Uploads a project-specific PR drawing
 */
async function uploadProjectDrawing({ buffer, fileName, mimeType, projectCode = 'GENERAL', prNumber = 'PR' }) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Valid buffer is required for upload');
  }

  const cleanProjCode = String(projectCode || 'GENERAL').replace(/[^a-zA-Z0-9_-]/g, '_');
  const isPdf = (mimeType && mimeType.includes('pdf')) || String(fileName).toLowerCase().endsWith('.pdf');
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const diskFileName = `PR_DRW_${Date.now()}_${safeName}`;

  const baseStorage = getDocumentStorageDir();
  const localDir = path.join(baseStorage, 'projects', cleanProjCode, 'engineering-drawings');
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  const absoluteLocalPath = path.join(localDir, diskFileName);
  fs.writeFileSync(absoluteLocalPath, buffer);
  const storageKey = path.relative(process.cwd(), absoluteLocalPath).replace(/\\/g, '/');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  let cloudinaryPublicId = null;
  let cloudinaryUrl = null;

  if (isCloudinaryConfigured) {
    try {
      const folder = `flowforce/ducting/pr-drawings/${cleanProjCode}`;
      const resourceType = isPdf ? 'raw' : 'image';

      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: resourceType
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        stream.end(buffer);
      });

      cloudinaryPublicId = uploadResult.public_id;
      cloudinaryUrl = uploadResult.secure_url || uploadResult.url;
    } catch (cldErr) {
      console.warn(`[CloudinaryService] Project drawing Cloudinary upload notice:`, cldErr.message);
    }
  }

  return {
    fileName: safeName,
    originalFileName: fileName,
    fileSizeBytes: buffer.length,
    mimeType: mimeType || (isPdf ? 'application/pdf' : 'image/png'),
    sha256,
    storageKey,
    absoluteLocalPath,
    cloudinaryPublicId,
    cloudinaryUrl,
    isCloudinaryStored: Boolean(cloudinaryUrl)
  };
}

/**
 * Health check evaluator for active storage mode
 * Returns mode: 'CLOUDINARY' | 'LOCAL_FALLBACK', status, and details.
 */
async function getStorageHealth() {
  const isProd = process.env.NODE_ENV === 'production';

  if (isCloudinaryConfigured) {
    try {
      const pingResult = await Promise.race([
        cloudinary.api.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Cloudinary ping timed out')), 3000))
      ]);

      const isOk = pingResult && pingResult.status === 'ok';
      return {
        mode: 'CLOUDINARY',
        status: isOk ? 'HEALTHY' : 'DEGRADED',
        isCloudinaryConfigured: true,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME || (process.env.CLOUDINARY_URL ? 'configured' : null),
        details: pingResult
      };
    } catch (err) {
      return {
        mode: 'CLOUDINARY',
        status: isProd ? 'UNHEALTHY' : 'DEGRADED',
        isCloudinaryConfigured: true,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME || (process.env.CLOUDINARY_URL ? 'configured' : null),
        error: `Cloudinary ping error: ${err.message}`,
        warning: isProd ? 'Cloudinary is configured but currently unreachable. Drawings may not be persistent across container restarts.' : undefined
      };
    }
  }

  return {
    mode: 'LOCAL_FALLBACK',
    status: isProd ? 'DEGRADED' : 'HEALTHY',
    isCloudinaryConfigured: false,
    warning: isProd ? 'Production environment lacks Cloudinary credentials. Storage fallback to local disk is active and may not be persistent across restarts.' : undefined,
    localStorageDir: getDocumentStorageDir()
  };
}

/**
 * Derives a page-1 PDF thumbnail URL from Cloudinary metadata if available
 */
function derivePdfThumbnail(cloudinaryUrl, cloudinaryPublicId) {
  if (!cloudinaryUrl && !cloudinaryPublicId) return null;
  if (cloudinaryPublicId && isCloudinaryConfigured) {
    try {
      return cloudinary.url(cloudinaryPublicId, {
        resource_type: 'image',
        page: 1,
        format: 'jpg',
        width: 1000,
        crop: 'limit',
        quality: 'auto',
        secure: true
      });
    } catch (e) {}
  }
  if (cloudinaryUrl && typeof cloudinaryUrl === 'string' && cloudinaryUrl.includes('res.cloudinary.com')) {
    if (cloudinaryUrl.includes('/upload/')) {
      return cloudinaryUrl.replace('/upload/', '/upload/pg_1,f_jpg,w_1000,c_limit/').replace(/\.pdf$/i, '.jpg');
    }
  }
  return null;
}

module.exports = {
  isConfigured: () => isCloudinaryConfigured,
  getDuctingTypeSlug,
  uploadStandardDrawing,
  uploadProjectDrawing,
  getStorageHealth,
  derivePdfThumbnail
};
