/**
 * =========================================================================
 * PRODUCTION ADMIN OPERATIONS & GOVERNANCE ROUTER
 * (/api/admin) - Strictly Administrator Access Required
 * =========================================================================
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db/pool');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { getStorageHealth } = require('../services/cloudinaryService');

// Strictly enforce authentication AND administrator role on all routes
router.use(authenticateToken);
router.use(requireAdmin);

/**
 * GET /api/admin/dashboard
 * Live operational KPIs, System Health status, and Recent Activity Stream
 */
router.get('/dashboard', async (req, res) => {
  try {
    // 1. Fetch real-time operational KPIs from PostgreSQL
    const [
      activeUsersRes,
      totalUsersRes,
      pendingPrsRes,
      totalPrsRes,
      approvedPrsRes,
      rejectedPrsRes,
      prsThisMonthRes,
      pendingDrawingRemovalsRes,
      activeDrawingsRes,
      totalSkusRes
    ] = await Promise.all([
      query(`SELECT COUNT(*)::int AS count FROM users WHERE status = 'Active'`),
      query(`SELECT COUNT(*)::int AS count FROM users`),
      query(`SELECT COUNT(*)::int AS count FROM purchase_requests WHERE status = 'PENDING_APPROVAL'`),
      query(`SELECT COUNT(*)::int AS count FROM purchase_requests`),
      query(`SELECT COUNT(*)::int AS count FROM purchase_requests WHERE status = 'APPROVED'`),
      query(`SELECT COUNT(*)::int AS count FROM purchase_requests WHERE status = 'REJECTED'`),
      query(`SELECT COUNT(*)::int AS count FROM purchase_requests WHERE created_at >= date_trunc('month', CURRENT_TIMESTAMP)`),
      query(`SELECT COUNT(*)::int AS count FROM drawing_removal_requests WHERE status = 'PENDING'`),
      query(`SELECT COUNT(*)::int AS count FROM standard_drawings WHERE status = 'ACTIVE'`),
      query(`SELECT COUNT(*)::int AS count FROM master_items`)
    ]);

    // 2. Fetch System Storage Health
    const storageHealth = await getStorageHealth();

    // 3. Fetch Recent Audit Activity Stream (Latest 25 events)
    const recentActivityRes = await query(`
      SELECT 
        id, entity_type, entity_id, action, module, description,
        performed_by_user_id, performed_by_username, role, ip_address,
        status, before_value, after_value, metadata, created_at
      FROM activity_logs
      ORDER BY created_at DESC
      LIMIT 25
    `);

    res.json({
      success: true,
      kpis: {
        activeUsers: activeUsersRes.rows[0].count,
        totalUsers: totalUsersRes.rows[0].count,
        pendingPrs: pendingPrsRes.rows[0].count,
        totalPrs: totalPrsRes.rows[0].count,
        approvedPrs: approvedPrsRes.rows[0].count,
        rejectedPrs: rejectedPrsRes.rows[0].count,
        prsThisMonth: prsThisMonthRes.rows[0].count,
        pendingDrawingRemovals: pendingDrawingRemovalsRes.rows[0].count,
        activeStandardDrawings: activeDrawingsRes.rows[0].count,
        totalSkus: totalSkusRes.rows[0].count
      },
      systemHealth: {
        database: {
          status: 'connected',
          provider: 'PostgreSQL',
          poolActive: true
        },
        storage: storageHealth,
        drawingStorageMode: storageHealth.mode || 'LOCAL_FALLBACK',
        app: {
          status: 'healthy',
          uptimeSeconds: Math.floor(process.uptime()),
          nodeVersion: process.version,
          memoryUsageMb: Math.round(process.memoryUsage().rss / (1024 * 1024))
        },
        timestamp: new Date().toISOString()
      },
      recentActivity: recentActivityRes.rows
    });
  } catch (err) {
    console.error('[Admin API] Dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch admin dashboard: ' + err.message });
  }
});

/**
 * GET /api/admin/audit-logs
 * Paginated, searchable, filterable enterprise audit log stream
 */
router.get('/audit-logs', async (req, res) => {
  try {
    const {
      module: filterModule,
      action: filterAction,
      status: filterStatus,
      userId: filterUserId,
      search,
      startDate,
      endDate,
      limit = 50,
      offset = 0
    } = req.query;

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const conditions = [];
    const params = [];

    if (filterModule) {
      params.push(filterModule.trim());
      conditions.push(`module = $${params.length}`);
    }

    if (filterAction) {
      params.push(filterAction.trim());
      conditions.push(`action = $${params.length}`);
    }

    if (filterStatus) {
      params.push(filterStatus.trim().toUpperCase());
      conditions.push(`status = $${params.length}`);
    }

    if (filterUserId) {
      params.push(filterUserId.trim());
      conditions.push(`performed_by_user_id = $${params.length}`);
    }

    if (startDate) {
      params.push(startDate.trim());
      conditions.push(`created_at >= $${params.length}::timestamp`);
    }

    if (endDate) {
      params.push(endDate.trim());
      conditions.push(`created_at <= $${params.length}::timestamp`);
    }

    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      const pIdx = params.length;
      conditions.push(`(
        LOWER(COALESCE(description, '')) LIKE $${pIdx} OR 
        LOWER(COALESCE(performed_by_username, '')) LIKE $${pIdx} OR 
        LOWER(COALESCE(entity_id, '')) LIKE $${pIdx} OR
        LOWER(action) LIKE $${pIdx}
      )`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `SELECT COUNT(*)::int AS total FROM activity_logs ${whereClause}`;
    const countRes = await query(countQuery, params);
    const totalCount = countRes.rows[0].total;

    params.push(safeLimit);
    const limitIdx = params.length;
    params.push(safeOffset);
    const offsetIdx = params.length;

    const selectQuery = `
      SELECT 
        id, entity_type, entity_id, action, module, description,
        performed_by_user_id, performed_by_username, role, ip_address,
        status, before_value, after_value, metadata, created_at
      FROM activity_logs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const logsRes = await query(selectQuery, params);

    res.json({
      success: true,
      totalCount,
      limit: safeLimit,
      offset: safeOffset,
      logs: logsRes.rows
    });
  } catch (err) {
    console.error('[Admin API] Audit logs error:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs: ' + err.message });
  }
});

/**
 * GET /api/admin/master-items/:sku/history
 * Audit trail for a specific Master Item / SKU
 */
router.get('/master-items/:sku/history', async (req, res) => {
  const { sku } = req.params;

  try {
    const result = await query(`
      SELECT 
        id, entity_type, entity_id, action, module, description,
        performed_by_user_id, performed_by_username, role, ip_address,
        status, before_value, after_value, metadata, created_at
      FROM activity_logs
      WHERE entity_type = 'MASTER_ITEM' AND (UPPER(entity_id) = UPPER($1) OR metadata->>'sku' = UPPER($1))
      ORDER BY created_at DESC
    `, [sku.trim()]);

    res.json({
      success: true,
      sku: sku.trim().toUpperCase(),
      history: result.rows
    });
  } catch (err) {
    console.error('[Admin API] SKU history error:', err);
    res.status(500).json({ error: 'Failed to fetch SKU history: ' + err.message });
  }
});

module.exports = router;
