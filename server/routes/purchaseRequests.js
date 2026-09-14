/**
 * Purchase Requests API Routes (/api/purchase-requests)
 * Implements PR Cart checkout, historical item snapshot, role filtering & admin approval
 */
const express = require('express');
const router = express.Router();
const { query, pool } = require('../db/pool');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { generatePrDocuments } = require('../services/documentGenerator');
const { REQUIRE_UNIT_PRICE } = require('../config/pricing');

router.use(authenticateToken);

// GET /api/purchase-requests - List PRs
// Admin retrieves all PRs; Employee strictly retrieves own PRs (Backend Enforced)
router.get('/', async (req, res) => {
  try {
    let sql = `
      SELECT pr.id, pr.pr_number, pr.status, pr.department, pr.required_date, pr.urgency,
             pr.reason_for_purchase, pr.remarks, pr.purchase_type, pr.required_cut_size,
             pr.created_at, pr.approved_at, pr.rejected_at, pr.rejection_reason,
             p.project_code, p.project_name, p.job_location,
             u_req.full_name AS requester_name, u_req.username AS requester_username,
             u_app.full_name AS approver_name, u_app.username AS approver_username,
             u_rej.full_name AS rejecter_name, u_rej.username AS rejecter_username,
             SUM(it.estimated_total_cost) AS total_cost,
             COUNT(it.id) AS item_count,
             COUNT(CASE WHEN it.unit_price IS NULL OR it.estimated_total_cost IS NULL THEN 1 END) AS missing_price_count
      FROM purchase_requests pr
      LEFT JOIN projects p ON p.id = pr.project_id
      LEFT JOIN users u_req ON u_req.id = pr.created_by_user_id
      LEFT JOIN users u_app ON u_app.id = pr.approved_by_user_id
      LEFT JOIN users u_rej ON u_rej.id = pr.rejected_by_user_id
      LEFT JOIN pr_items it ON it.purchase_request_id = pr.id
    `;
    const params = [];

    if (req.user.role !== 'ADMIN') {
      sql += ` WHERE pr.created_by_user_id = $1`;
      params.push(req.user.id);
    }

    sql += ` GROUP BY pr.id, p.project_code, p.project_name, p.job_location,
                      u_req.full_name, u_req.username, u_app.full_name, u_app.username,
                      u_rej.full_name, u_rej.username
             ORDER BY pr.created_at DESC`;

    const result = await query(sql, params);

    const prs = result.rows.map(r => ({
      id: r.id,
      prNumber: r.pr_number,
      projectCode: r.project_code,
      projectName: r.project_name,
      jobLocation: r.job_location,
      status: r.status,
      department: r.department,
      requiredDate: r.required_date,
      urgency: r.urgency,
      reasonForPurchase: r.reason_for_purchase,
      remarks: r.remarks,
      purchaseType: r.purchase_type,
      requiredCutSize: r.required_cut_size,
      requesterName: r.requester_name,
      requesterUsername: r.requester_username,
      approverName: r.approver_name,
      approverUsername: r.approver_username,
      approvedAt: r.approved_at,
      rejecterName: r.rejecter_name,
      rejecterUsername: r.rejecter_username,
      rejectedAt: r.rejected_at,
      rejectionReason: r.rejection_reason,
      totalCost: (parseInt(r.missing_price_count, 10) > 0 || r.total_cost === null) ? null : parseFloat(r.total_cost),
      itemCount: parseInt(r.item_count, 10) || 0,
      createdAt: r.created_at
    }));

    res.json(prs);
  } catch (err) {
    console.error('[PR API] List error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/purchase-requests - Create Purchase Request from PR Cart
router.post('/', async (req, res) => {
  const {
    projectId, department, requiredDate, urgency,
    reasonForPurchase, remarks, purchaseType, requiredCutSize,
    cartItems
  } = req.body;

  if (!projectId) return res.status(400).json({ error: 'Project / PID selection is required.' });
  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'PR Cart is empty. Please add materials to the cart.' });
  }

  // Price Requirement: Controlled by REQUIRE_UNIT_PRICE switch
  for (const item of cartItems) {
    if (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '') {
      const p = Number(item.unitPrice);
      if (isNaN(p) || !isFinite(p) || p < 0) {
        return res.status(400).json({
          error: `Invalid price for item: ${item.sku} - ${item.productName || item.sku}`
        });
      }
    } else if (REQUIRE_UNIT_PRICE) {
      return res.status(400).json({
        error: `Cannot create PR. Current Unit Price is missing for: ${item.sku} - ${item.productName || item.sku}`
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify project exists
    const projRes = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (projRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Selected project does not exist.' });
    }
    const project = projRes.rows[0];

    // Generate prospective PR Number: PR-[YEAR]-[4 DIGIT SEQ]
    const year = new Date().getFullYear();
    const countRes = await client.query(
      `SELECT COUNT(id) FROM purchase_requests WHERE pr_number LIKE $1`,
      [`PR-${year}-%`]
    );
    const seq = parseInt(countRes.rows[0].count, 10) + 1;
    const prNumber = `PR-${year}-${String(seq).padStart(4, '0')}`;

    const hasAnyCutSize = cartItems.some(i => i.supplyType === 'Cut Size' || i.purchaseType === 'PROJECT-SPECIFIC CUT SIZE');

    // Insert purchase_requests (Initial Status: PENDING_APPROVAL)
    const prInsertRes = await client.query(
      `INSERT INTO purchase_requests (
        pr_number, project_id, created_by_user_id, status,
        department, required_date, urgency, reason_for_purchase, remarks,
        purchase_type, required_cut_size
      ) VALUES ($1, $2, $3, 'PENDING_APPROVAL', $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, pr_number, status, created_at`,
      [
        prNumber,
        projectId,
        req.user.id, // Authenticated user is automatically recorded as requester
        department || 'Procurement',
        requiredDate || null,
        urgency || 'Standard (1-2 Weeks)',
        reasonForPurchase || null,
        remarks || null,
        hasAnyCutSize ? 'PROJECT-SPECIFIC CUT SIZE' : 'STANDARD STOCK ITEM',
        requiredCutSize || null
      ]
    );

    const prId = prInsertRes.rows[0].id;

    // Insert pr_items with HISTORICAL SNAPSHOT of Master Item data, Status, and Supply Type
    for (const item of cartItems) {
      const qty = parseFloat(item.quantity) || 1;
      const hasPrice = item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '' && !isNaN(Number(item.unitPrice)) && Number(item.unitPrice) >= 0;
      const price = hasPrice ? parseFloat(item.unitPrice) : null;
      const totalCost = hasPrice ? (qty * price) : null;

      const itemStatus = (item.status === 'Out of Stock') ? 'Out of Stock' : 'Available';
      const isItemCutSize = (item.supplyType === 'Cut Size' || item.purchaseType === 'PROJECT-SPECIFIC CUT SIZE');
      const itemSupplyType = isItemCutSize ? 'Cut Size' : 'Full Size';

      let cutLength = '';
      let cutWidth = '';
      let itemRequiredCutSize = null;

      if (isItemCutSize) {
        const cDim = item.cutDimensions || {};
        cutLength = String(cDim.length || item.cutLength || '').trim();
        cutWidth = String(cDim.width || item.cutWidth || '').trim();

        const lenNum = Number(cutLength);
        if (!cutLength || isNaN(lenNum) || lenNum <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Required cut length must be a valid positive number for Cut Size material: ${item.sku}.`
          });
        }

        const isPlateSheet = /plate|sheet|plat/i.test(`${item.productName || ''} ${item.itemDescription || ''} ${item.unit || ''}`);
        if (isPlateSheet) {
          const widNum = Number(cutWidth);
          if (!cutWidth || isNaN(widNum) || widNum <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Required cut dimensions (Length and Width) are mandatory for Cut Size plate/sheet material: ${item.sku}.`
            });
          }
        } else if (cutWidth) {
          const widNum = Number(cutWidth);
          if (isNaN(widNum) || widNum <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Cut width must be a valid positive number if specified for Cut Size material: ${item.sku}.`
            });
          }
        }

        itemRequiredCutSize = cutWidth ? `${cutLength} × ${cutWidth}` : `${cutLength}`;
      }

      await client.query(
        `INSERT INTO pr_items (
          purchase_request_id, master_item_id, sku, product_name, item_description,
          material_grade, size_dimensions, specification, unit, quantity, weight,
          unit_price, estimated_total_cost, purchase_type, required_cut_size,
          status, supply_type, cut_length, cut_width
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          prId,
          item.masterItemId || null,
          item.sku,
          item.productName || '',
          item.itemDescription || '', // Preserves multiline text
          item.material || item.materialGrade || null,
          item.size || item.sizeDimensions || item.originalDimensions || null,
          item.specification || null,
          item.unit || 'Sheet',
          qty,
          item.weight || item.weightKg || null,
          price,
          totalCost,
          isItemCutSize ? 'PROJECT-SPECIFIC CUT SIZE' : 'STANDARD STOCK ITEM',
          itemRequiredCutSize,
          itemStatus,
          itemSupplyType,
          cutLength,
          cutWidth
        ]
      );
    }

    // Insert audit record into pr_approval_history (Action: SUBMITTED)
    await client.query(
      `INSERT INTO pr_approval_history (purchase_request_id, action, performed_by_user_id, remarks)
       VALUES ($1, 'SUBMITTED', $2, $3)`,
      [prId, req.user.id, `Requisition submitted with ${cartItems.length} material items`]
    );

    await client.query('COMMIT');

    // Automatically generate PR Excel (.xlsx) and PDF (.pdf) in background
    try {
      await generatePrDocuments(prId);
    } catch (docErr) {
      console.error('[Document Generator] Failed to generate PR files:', docErr);
    }

    res.status(201).json({
      success: true,
      message: `Purchase Request ${prNumber} created successfully and submitted for Admin approval.`,
      prId,
      prNumber
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PR API] Create error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  } finally {
    client.release();
  }
});

// GET /api/purchase-requests/:id - PR Details
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const prRes = await query(
      `SELECT pr.*, 
              p.project_code, p.project_name, p.job_location,
              u_req.full_name AS requester_name, u_req.username AS requester_username,
              u_app.full_name AS approver_name, u_app.username AS approver_username,
              u_rej.full_name AS rejecter_name, u_rej.username AS rejecter_username
       FROM purchase_requests pr
       LEFT JOIN projects p ON p.id = pr.project_id
       LEFT JOIN users u_req ON u_req.id = pr.created_by_user_id
       LEFT JOIN users u_app ON u_app.id = pr.approved_by_user_id
       LEFT JOIN users u_rej ON u_rej.id = pr.rejected_by_user_id
       WHERE pr.id = $1`,
      [id]
    );

    if (prRes.rowCount === 0) return res.status(404).json({ error: 'Purchase Request not found.' });
    const pr = prRes.rows[0];

    // Backend authorization: Employee can only view their own PR
    if (req.user.role !== 'ADMIN' && pr.created_by_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access Denied — You cannot access another employee’s Purchase Request.' });
    }

    const itemsRes = await query(
      `SELECT * FROM pr_items WHERE purchase_request_id = $1 ORDER BY id ASC`,
      [id]
    );

    const historyRes = await query(
      `SELECT h.*, u.full_name, u.username, u.role
       FROM pr_approval_history h
       LEFT JOIN users u ON u.id = h.performed_by_user_id
       WHERE h.purchase_request_id = $1
       ORDER BY h.performed_at ASC`,
      [id]
    );

    const docsRes = await query(
      `SELECT * FROM documents WHERE purchase_request_id = $1 ORDER BY id ASC`,
      [id]
    );

    res.json({
      pr: {
        id: pr.id,
        prNumber: pr.pr_number,
        status: pr.status,
        projectCode: pr.project_code,
        projectName: pr.project_name,
        jobLocation: pr.job_location,
        department: pr.department,
        requiredDate: pr.required_date,
        urgency: pr.urgency,
        reasonForPurchase: pr.reason_for_purchase,
        remarks: pr.remarks,
        purchaseType: pr.purchase_type,
        requiredCutSize: pr.required_cut_size,
        requesterName: pr.requester_name,
        requesterUsername: pr.requester_username,
        approverName: pr.approver_name,
        approverUsername: pr.approver_username,
        approvedAt: pr.approved_at,
        rejecterName: pr.rejecter_name,
        rejecterUsername: pr.rejecter_username,
        rejectedAt: pr.rejected_at,
        rejectionReason: pr.rejection_reason,
        createdAt: pr.created_at
      },
      items: itemsRes.rows.map(it => {
        const isCut = (it.supply_type === 'Cut Size' || it.purchase_type === 'PROJECT-SPECIFIC CUT SIZE');
        return {
          id: it.id,
          sku: it.sku,
          productName: it.product_name,
          itemDescription: it.item_description, // Multiline preserved
          materialGrade: it.material_grade,
          sizeDimensions: it.size_dimensions,
          originalDimensions: it.size_dimensions,
          specification: it.specification,
          unit: it.unit,
          quantity: parseFloat(it.quantity),
          weight: it.weight ? parseFloat(it.weight) : null,
          unitPrice: it.unit_price ? parseFloat(it.unit_price) : null,
          estimatedTotalCost: (it.estimated_total_cost !== null && it.estimated_total_cost !== undefined) ? parseFloat(it.estimated_total_cost) : null,
          status: (it.status === 'Out of Stock') ? 'Out of Stock' : 'Available',
          supplyType: isCut ? 'Cut Size' : 'Full Size',
          cutLength: it.cut_length || '',
          cutWidth: it.cut_width || '',
          cutDimensions: isCut ? { length: it.cut_length || '', width: it.cut_width || '' } : null,
          purchaseType: it.purchase_type,
          requiredCutSize: it.required_cut_size
        };
      }),
      history: historyRes.rows.map(h => ({
        id: h.id,
        action: h.action,
        performedByName: h.full_name,
        performedByUsername: h.username,
        role: h.role,
        performedAt: h.performed_at,
        remarks: h.remarks
      })),
      documents: docsRes.rows.map(d => ({
        id: d.id,
        documentType: d.document_type,
        fileName: d.file_name,
        filePathOrStorageKey: d.file_path_or_storage_key,
        createdAt: d.created_at
      }))
    });
  } catch (err) {
    console.error('[PR API] Get PR error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/purchase-requests/:id/approve - Admin Approve PR
router.post('/:id/approve', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await query('SELECT * FROM purchase_requests WHERE id = $1', [id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Purchase Request not found.' });
    const pr = existing.rows[0];

    if (pr.status === 'APPROVED') {
      return res.status(400).json({ error: 'This Purchase Request is already approved.' });
    }

    await query(
      `UPDATE purchase_requests
       SET status = 'APPROVED',
           approved_by_user_id = $1,
           approved_at = CURRENT_TIMESTAMP,
           rejected_by_user_id = NULL,
           rejected_at = NULL,
           rejection_reason = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [req.user.id, id]
    );

    // Audit trail
    await query(
      `INSERT INTO pr_approval_history (purchase_request_id, action, performed_by_user_id, remarks)
       VALUES ($1, 'APPROVED', $2, $3)`,
      [id, req.user.id, 'Purchase Request approved for procurement']
    );

    // Regenerate documents with Approved stamp
    try {
      await generatePrDocuments(id);
    } catch (e) {
      console.error('[Document Generator] Regenerate failed on approve:', e);
    }

    res.json({
      success: true,
      message: `Purchase Request ${pr.pr_number} approved successfully.`,
      status: 'APPROVED',
      approvedBy: req.user.fullName,
      approvedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[PR API] Approve error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/purchase-requests/:id/reject - Admin Reject PR (Requires Reason)
router.post('/:id/reject', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { rejectionReason } = req.body;

  if (!rejectionReason || !rejectionReason.trim()) {
    return res.status(400).json({ error: 'Rejection reason is required.' });
  }

  try {
    const existing = await query('SELECT * FROM purchase_requests WHERE id = $1', [id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Purchase Request not found.' });
    const pr = existing.rows[0];

    await query(
      `UPDATE purchase_requests
       SET status = 'REJECTED',
           rejected_by_user_id = $1,
           rejected_at = CURRENT_TIMESTAMP,
           rejection_reason = $2,
           approved_by_user_id = NULL,
           approved_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [req.user.id, rejectionReason.trim(), id]
    );

    // Audit trail
    await query(
      `INSERT INTO pr_approval_history (purchase_request_id, action, performed_by_user_id, remarks)
       VALUES ($1, 'REJECTED', $2, $3)`,
      [id, req.user.id, `Rejected: ${rejectionReason.trim()}`]
    );

    // Regenerate documents with Rejected stamp
    try {
      await generatePrDocuments(id);
    } catch (e) {
      console.error('[Document Generator] Regenerate failed on reject:', e);
    }

    res.json({
      success: true,
      message: `Purchase Request ${pr.pr_number} has been rejected.`,
      status: 'REJECTED',
      rejectedBy: req.user.fullName,
      rejectedAt: new Date().toISOString(),
      rejectionReason: rejectionReason.trim()
    });
  } catch (err) {
    console.error('[PR API] Reject error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// GET /api/purchase-requests/:id/history - Audit Trail
router.get('/:id/history', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await query(
      `SELECT h.*, u.full_name, u.username, u.role
       FROM pr_approval_history h
       LEFT JOIN users u ON u.id = h.performed_by_user_id
       WHERE h.purchase_request_id = $1
       ORDER BY h.performed_at ASC`,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[PR API] History error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

module.exports = router;
