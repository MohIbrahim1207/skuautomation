/**
 * =========================================================================
 * FLOW FORCE ENTERPRISE ACTIVITY & AUDIT LOGGER
 * PostgreSQL Persistent Audit Trail
 * =========================================================================
 */
const { query } = require('../db/pool');

/**
 * Strips any sensitive properties from metadata before recording
 */
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const cleaned = { ...meta };
  const forbiddenKeys = [
    'password', 'passwordHash', 'password_hash', 'token', 'jwt',
    'secret', 'apiKey', 'api_key', 'authorization', 'cookie'
  ];
  for (const key of Object.keys(cleaned)) {
    if (forbiddenKeys.some(f => key.toLowerCase().includes(f))) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

/**
 * Logs an activity into the activity_logs table
 *
 * @param {Object} params
 * @param {string} params.entityType - e.g. 'PURCHASE_REQUEST', 'DOCUMENT', 'USER'
 * @param {string|number} params.entityId - ID or Number of the entity
 * @param {string} params.action - e.g. 'DOCUMENT_GENERATED', 'SUBMITTED', 'APPROVED'
 * @param {string} [params.userId] - User ID performing action
 * @param {string} [params.username] - Username performing action
 * @param {Object} [params.metadata] - Additional contextual metadata (non-sensitive)
 */
async function logActivity({ entityType, entityId, action, userId = null, username = null, metadata = {} }) {
  try {
    const cleanMeta = sanitizeMetadata(metadata);
    await query(
      `INSERT INTO activity_logs (entity_type, entity_id, action, performed_by_user_id, performed_by_username, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entityType || 'PURCHASE_REQUEST',
        entityId ? String(entityId) : null,
        action,
        userId || null,
        username || null,
        JSON.stringify(cleanMeta)
      ]
    );
  } catch (err) {
    // Audit log failures should never crash core business operations, but should be logged to console
    console.error('[ActivityLogger] Failed to write activity log:', err.message);
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
  sanitizeMetadata
};
