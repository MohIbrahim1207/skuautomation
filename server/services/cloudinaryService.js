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

  if (isCloudinaryConfigured) {
    try {
      const folder = `flowforce/ducting/standard-drawings/${typeSlug}`;
      const resourceType = isPdf ? 'raw' : 'image';
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
      console.log(`[CloudinaryService] Uploaded ${fileName} to ${folder}/${publicId}`);
    } catch (cldErr) {
      console.warn(`[CloudinaryService] Cloudinary upload notice for ${fileName}:`, cldErr.message);
      // Fallback preserves local storage so operations never crash
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
    cloudinaryUrl: cloudinarySecureUrl || cloudinaryUrl || null,
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

module.exports = {
  isConfigured: () => isCloudinaryConfigured,
  getDuctingTypeSlug,
  uploadStandardDrawing,
  uploadProjectDrawing
};
