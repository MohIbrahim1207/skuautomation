/**
 * Document Storage & Download Routes (/api/documents)
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query } = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// GET /api/documents/:id/download - Stream/Download PR Document
router.get('/:id/download', async (req, res) => {
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

    // Authorization: Employee can only download documents for their own PRs
    if (req.user.role !== 'ADMIN' && doc.created_by_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access Denied — You cannot access another employee’s documents.' });
    }

    const fullPath = path.isAbsolute(doc.file_path_or_storage_key)
      ? doc.file_path_or_storage_key
      : path.join(process.cwd(), doc.file_path_or_storage_key);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Physical document file not found on server storage.' });
    }

    const contentType = doc.document_type === 'PR_PDF'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    console.error('[Documents API] Download error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

module.exports = router;
