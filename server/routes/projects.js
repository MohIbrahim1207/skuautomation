/**
 * Projects / Job Location Routes (/api/projects)
 */
const express = require('express');
const router = express.Router();
const { query } = require('../db/pool');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

router.use(authenticateToken);

// GET /api/projects - List all projects
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT p.id, p.project_code, p.project_name, p.job_location, p.description, p.status, p.created_at,
              COUNT(DISTINCT pr.id) AS pr_count
       FROM projects p
       LEFT JOIN purchase_requests pr ON pr.project_id = p.id
       GROUP BY p.id, p.project_code, p.project_name, p.job_location, p.description, p.status, p.created_at
       ORDER BY p.project_code ASC`
    );

    const projects = result.rows.map(r => ({
      id: r.id,
      projectCode: r.project_code,
      projectName: r.project_name,
      jobLocation: r.job_location,
      description: r.description,
      status: r.status,
      prCount: parseInt(r.pr_count, 10) || 0,
      createdAt: r.created_at
    }));

    res.json(projects);
  } catch (err) {
    console.error('[Projects API] List error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/projects - Create a new Project / Job
router.post('/', async (req, res) => {
  const { projectCode, projectName, jobLocation, description } = req.body;

  const cleanCode = (projectCode || '').trim();
  const cleanName = (projectName || '').trim();
  const cleanLocation = (jobLocation || '').trim();

  if (!cleanCode) return res.status(400).json({ error: 'Project / PID code is required.' });
  if (!cleanName) return res.status(400).json({ error: 'Project Name is required.' });
  if (!cleanLocation) return res.status(400).json({ error: 'Job Location is required.' });

  try {
    const dup = await query('SELECT 1 FROM projects WHERE UPPER(project_code) = UPPER($1)', [cleanCode]);
    if (dup.rowCount > 0) {
      return res.status(400).json({ error: `Project code '${cleanCode}' already exists.` });
    }

    const insertRes = await query(
      `INSERT INTO projects (project_code, project_name, job_location, description, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_code, project_name, job_location, description, status, created_at`,
      [cleanCode, cleanName, cleanLocation, (description || '').trim() || null, req.user.id]
    );

    const p = insertRes.rows[0];
    res.status(201).json({
      id: p.id,
      projectCode: p.project_code,
      projectName: p.project_name,
      jobLocation: p.job_location,
      description: p.description,
      status: p.status,
      prCount: 0,
      createdAt: p.created_at
    });
  } catch (err) {
    console.error('[Projects API] Create error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// GET /api/projects/:id - Details & Linked PRs + Documents
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const pRes = await query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (pRes.rowCount === 0) return res.status(404).json({ error: 'Project not found.' });
    const p = pRes.rows[0];

    // Purchase requests under this project
    // Admin sees all PRs in project; Employee sees only their own PRs unless authorized
    let prQuery = `
      SELECT pr.id, pr.pr_number, pr.status, pr.created_at, pr.required_date, pr.urgency,
             u.full_name AS requester_name, u.username AS requester_username
      FROM purchase_requests pr
      LEFT JOIN users u ON u.id = pr.created_by_user_id
      WHERE pr.project_id = $1
    `;
    const params = [id];

    if (req.user.role !== 'ADMIN') {
      prQuery += ` AND pr.created_by_user_id = $2`;
      params.push(req.user.id);
    }
    prQuery += ` ORDER BY pr.created_at DESC`;

    const prsRes = await query(prQuery, params);

    // Linked documents
    const docRes = await query(
      `SELECT d.id, d.purchase_request_id, d.document_type, d.file_name, d.created_at,
              pr.pr_number
       FROM documents d
       LEFT JOIN purchase_requests pr ON pr.id = d.purchase_request_id
       WHERE d.project_id = $1
       ORDER BY d.created_at DESC`,
      [id]
    );

    res.json({
      id: p.id,
      projectCode: p.project_code,
      projectName: p.project_name,
      jobLocation: p.job_location,
      description: p.description,
      status: p.status,
      purchaseRequests: prsRes.rows.map(r => ({
        id: r.id,
        prNumber: r.pr_number,
        status: r.status,
        requesterName: r.requester_name,
        requesterUsername: r.requester_username,
        requiredDate: r.required_date,
        urgency: r.urgency,
        createdAt: r.created_at
      })),
      documents: docRes.rows.map(d => ({
        id: d.id,
        purchaseRequestId: d.purchase_request_id,
        prNumber: d.pr_number,
        documentType: d.document_type,
        fileName: d.file_name,
        createdAt: d.created_at
      }))
    });
  } catch (err) {
    console.error('[Projects API] Get details error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// PUT /api/projects/:id - Update Project (Admin only)
router.put('/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { projectName, jobLocation, description, status } = req.body;

  try {
    const result = await query(
      `UPDATE projects 
       SET project_name = COALESCE($1, project_name),
           job_location = COALESCE($2, job_location),
           description = COALESCE($3, description),
           status = COALESCE($4, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [(projectName || '').trim() || null, (jobLocation || '').trim() || null, description || null, status || null, id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found.' });

    res.json({ success: true, message: 'Project updated successfully.', project: result.rows[0] });
  } catch (err) {
    console.error('[Projects API] Update error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

module.exports = router;
