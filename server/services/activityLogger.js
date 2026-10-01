/**
 * =========================================================================
 * FLOW FORCE ENTERPRISE ACTIVITY & AUDIT LOGGER
 * PostgreSQL Append-Only Audit Trail (Enterprise Governance)
 * =========================================================================
 */
const { query } = require('../db/pool');

/**
 * Strips sensitive properties (passwords, tokens, keys) from audit payloads
 */
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const cleaned = Array.isArray(meta) ? [...meta] : { ...meta };
  const forbiddenKeys = [
    'password', 'passwordHash', 'password_hash', 'tempPassword',
    'token', 'jwt', 'secret', 'apiKey', 'api_key', 'authorization', 'cookie'
  ];

  if (Array.isArray(cleaned)) {
    return cleaned.map(item => (typeof item === 'object' ? sanitizeMetadata(item) : item));
  }

  for (const key of Object.keys(cleaned)) {
    if (forbiddenKeys.some(f => key.toLowerCase().includes(f))) {
      cleaned[key] = '[REDACTED]';
    } else if (typeof cleaned[key] === 'object' && cleaned[key] !== null) {
      cleaned[key] = sanitizeMetadata(cleaned[key]);
    }
  }
  return cleaned;
}

/**
 * Extracts client IP from Express request if available
 */
function extractClientIp(req) {
  if (!req) return null;
  return (
    req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    null
  );
}

/**
 * Logs an append-only audit event into the activity_logs table
 *
 * @param {Object} params
 * @param {string} params.entityType - e.g. 'USER', 'MASTER_ITEM', 'PURCHASE_REQUEST', 'STANDARD_DRAWING', 'AUTH'
 * @param {string|number} [params.entityId] - Unique ID or SKU of entity
 * @param {string} params.action - e.g. 'LOGIN_SUCCESS', 'SKU_CREATED', 'PRICE_CHANGED', 'PR_APPROVED'
 * @param {string} [params.module] - e.g. 'AUTH', 'USER_MANAGEMENT', 'MASTER_CATALOG', 'PURCHASE_REQUESTS', 'DUCTING'
 * @param {string} [params.description] - Human-readable summary of the event
 * @param {string} [params.userId] - ID of actor
 * @param {string} [params.username] - Username of actor
 * @param {string} [params.role] - Role of actor ('ADMIN', 'EMPLOYEE', etc.)
 * @param {string} [params.ipAddress] - IP address of actor
 * @param {string} [params.status] - 'SUCCESS' or 'FAILURE'
 * @param {Object} [params.beforeValue] - Snapshot before change
 * @param {Object} [params.afterValue] - Snapshot after change
 * @param {Object} [params.metadata] - Additional contextual metadata (non-sensitive)
 */
async function logActivity({
  entityType = 'SYSTEM',
  entityId = null,
  action,
  module = null,
  description = null,
  userId = null,
  username = null,
  role = null,
  ipAddress = null,
  status = 'SUCCESS',
  beforeValue = null,
  afterValue = null,
  metadata = {}
}) {
  try {
    const cleanMeta = sanitizeMetadata(metadata);
    const cleanBefore = sanitizeMetadata(beforeValue);
    const cleanAfter = sanitizeMetadata(afterValue);

    // Auto-derive module from entityType if omitted
    const effectiveModule = module || (
      entityType === 'USER' ? 'USER_MANAGEMENT' :
      entityType === 'MASTER_ITEM' ? 'MASTER_CATALOG' :
      entityType === 'PURCHASE_REQUEST' ? 'PURCHASE_REQUESTS' :
      entityType === 'STANDARD_DRAWING' ? 'DUCTING' :
      entityType === 'DOCUMENT' ? 'DOCUMENTS' :
      'SYSTEM'
    );

    // Auto-generate human-readable description if omitted
    const effectiveDesc = description || `${action} on ${entityType}${entityId ? ' #' + entityId : ''}`;

    await query(
      `INSERT INTO activity_logs (
        entity_type, entity_id, action, module, description,
        performed_by_user_id, performed_by_username, role, ip_address,
        status, before_value, after_value, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
      [
        entityType,
        entityId ? String(entityId) : null,
        action,
        effectiveModule,
        effectiveDesc,
        userId || null,
        username || null,
        role || null,
        ipAddress || null,
        status || 'SUCCESS',
        cleanBefore ? JSON.stringify(cleanBefore) : null,
        cleanAfter ? JSON.stringify(cleanAfter) : null,
        cleanMeta ? JSON.stringify(cleanMeta) : null
      ]
    );
  } catch (err) {
    // Audit log failures must never crash operations, but should be reported
    console.error('[ActivityLogger] Failed to write audit log:', err.message);
  }
}

/**
 * Retrieves activity logs for an entity
 */
async function getEntityActivityLogs(entityType, entityId) {
  try {
    const res = await query(
      `SELECT * FROM activity_logs 
       WHERE entity_type = $1 AND entity_id = $2 
       ORDER BY created_at DESC`,
      [entityType, String(entityId)]
    );
    return res.rows;
  } catch (err) {
    console.error('[ActivityLogger] Failed to fetch activity logs:', err.message);
    return [];
  }
}

module.exports = {
  logActivity,
  getEntityActivityLogs,
  sanitizeMetadata,
  extractClientIp
};
