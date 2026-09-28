/**
 * =========================================================================
 * PR DOCUMENT QR VERIFICATION ROUTE & PAGE
 * Public Verification for Official Flow Force Documents
 * =========================================================================
 */
const express = require('express');
const router = express.Router();
const { query } = require('../db/pool');

/**
 * Renders the HTML verification page
 */
function renderVerificationHtml({ found, pr, doc, verifiedAt }) {
  if (!found) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document Verification — Flow Force</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 2rem 1rem; display: flex; justify-content: center; }
    .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); max-width: 520px; width: 100%; padding: 2rem; }
    .header { text-align: center; border-bottom: 2px solid #ef4444; padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 9999px; font-weight: 700; font-size: 0.85rem; background: #fee2e2; color: #b91c1c; }
    .msg { color: #64748b; font-size: 0.95rem; text-align: center; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="badge">❌ INVALID DOCUMENT</div>
      <h2 style="margin: 0.75rem 0 0.25rem;">Verification Failed</h2>
    </div>
    <div class="msg">
      The requested Purchase Requisition could not be verified in the Flow Force Enterprise registry.
      Please check the document number or contact Flow Force Procurement.
    </div>
  </div>
</body>
</html>`;
  }

  const isApproved = pr.status === 'APPROVED';
  const statusColor = isApproved ? '#059669' : (pr.status === 'REJECTED' ? '#e11d48' : '#d97706');
  const badgeBg = isApproved ? '#d1fae5' : (pr.status === 'REJECTED' ? '#ffe4e6' : '#fef3c7');
  const badgeText = isApproved ? 'OFFICIAL VERIFIED DOCUMENT' : `DOCUMENT STATUS: ${pr.status}`;
  const revStr = `Rev ${String(pr.revision || 0).padStart(2, '0')}`;
  const reqDate = pr.created_at ? new Date(pr.created_at).toLocaleDateString('en-GB') : '—';
  const appDate = pr.approved_at ? new Date(pr.approved_at).toLocaleDateString('en-GB') : '—';
  const checksumDisplay = doc && doc.sha256_checksum 
    ? `${doc.sha256_checksum.substring(0, 16)}...${doc.sha256_checksum.substring(doc.sha256_checksum.length - 8)}`
    : 'Verified by Flow Force Digital Audit';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document Verification — Flow Force PR ${escapeHtml(pr.pr_number)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f1f5f9; color: #0f172a; margin: 0; padding: 2rem 1rem; display: flex; justify-content: center; }
    .card { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.07); max-width: 580px; width: 100%; overflow: hidden; }
    .top-bar { background: #0284c7; height: 6px; }
    .content { padding: 2rem 2.25rem; }
    .company-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #e2e8f0; padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
    .company-name { font-size: 1.15rem; font-weight: 800; color: #0f172a; letter-spacing: -0.3px; }
    .company-sub { font-size: 0.75rem; color: #64748b; margin-top: 2px; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 9999px; font-weight: 700; font-size: 0.82rem; background: ${badgeBg}; color: ${statusColor}; border: 1px solid ${statusColor}33; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem 1.5rem; margin: 1.5rem 0; font-size: 0.88rem; }
    .field-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; }
    .field-val { font-weight: 600; color: #0f172a; margin-top: 2px; }
    .field-val.highlight { color: #0284c7; font-family: monospace; font-size: 1rem; }
    .audit-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem; font-size: 0.8rem; color: #475569; margin-top: 1.25rem; }
    .checksum { font-family: monospace; font-size: 0.75rem; color: #0284c7; word-break: break-all; margin-top: 4px; }
    .footer { text-align: center; border-top: 1px solid #f1f5f9; padding: 1rem; font-size: 0.75rem; color: #94a3b8; background: #fafafa; }
  </style>
</head>
<body>
  <div class="card">
    <div class="top-bar"></div>
    <div class="content">
      <div class="company-header">
        <div>
          <div class="company-name">PT. Flow Force Indonesia</div>
          <div class="company-sub">Industrial Requisition Verification Registry</div>
        </div>
        <div class="status-badge">
          <span>${isApproved ? '✓' : 'ℹ'}</span>
          <span>${badgeText}</span>
        </div>
      </div>

      <div style="text-align: center; margin-bottom: 1.5rem;">
        <div style="font-size: 0.8rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Official Requisition Document</div>
        <div style="font-size: 1.5rem; font-weight: 800; color: #0f172a; font-family: monospace; margin: 4px 0;">${escapeHtml(pr.pr_number)}</div>
        <div style="font-size: 0.85rem; color: #64748b;">Version: <strong>${revStr}</strong></div>
      </div>

      <div class="grid">
        <div>
          <div class="field-label">Project / PID</div>
          <div class="field-val">${escapeHtml(pr.project_code || '—')} ${pr.project_name ? `(${escapeHtml(pr.project_name)})` : ''}</div>
        </div>
        <div>
          <div class="field-label">Department</div>
          <div class="field-val">${escapeHtml(pr.department || 'Engineering')}</div>
        </div>
        <div>
          <div class="field-label">Requisitioned By</div>
          <div class="field-val">${escapeHtml(pr.requester_name || pr.requester_username || '—')}</div>
        </div>
        <div>
          <div class="field-label">Submission Date</div>
          <div class="field-val">${reqDate}</div>
        </div>
        <div>
          <div class="field-label">Approval Status</div>
          <div class="field-val" style="color: ${statusColor}; font-weight: 700;">${escapeHtml(pr.status)}</div>
        </div>
        <div>
          <div class="field-label">${isApproved ? 'Approved By' : 'Review Status'}</div>
          <div class="field-val">${isApproved ? `${escapeHtml(pr.approver_name || 'Admin')} on ${appDate}` : 'Pending Administrative Review'}</div>
        </div>
      </div>

      <div class="audit-box">
        <div style="font-weight: 700; color: #334155; margin-bottom: 4px;">Security &amp; Integrity Verification</div>
        <div>Digital Document Checksum (SHA-256):</div>
        <div class="checksum">${checksumDisplay}</div>
        <div style="margin-top: 6px; font-size: 0.72rem; color: #94a3b8;">
          Verified live against PostgreSQL registry: ${verifiedAt}
        </div>
      </div>
    </div>
    <div class="footer">
      Flow Force Procurement &amp; Engineering Automation System &bull; www.flow-force.com
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Handle verification request (returns JSON or HTML)
 */
async function handleVerification(req, res) {
  const prIdOrNumber = req.params.prNumber || req.params.id;
  if (!prIdOrNumber) return res.status(400).send('PR number required');

  try {
    const isNumeric = /^\d+$/.test(String(prIdOrNumber).trim());
    const prRes = isNumeric
      ? await query(
          `SELECT pr.*, p.project_code, p.project_name,
                  u_req.full_name AS requester_name, u_req.username AS requester_username,
                  u_app.full_name AS approver_name, u_app.username AS approver_username
           FROM purchase_requests pr
           LEFT JOIN projects p ON p.id = pr.project_id
           LEFT JOIN users u_req ON u_req.id = pr.created_by_user_id
           LEFT JOIN users u_app ON u_app.id = pr.approved_by_user_id
           WHERE pr.id = $1`,
          [parseInt(prIdOrNumber, 10)]
        )
      : await query(
          `SELECT pr.*, p.project_code, p.project_name,
                  u_req.full_name AS requester_name, u_req.username AS requester_username,
                  u_app.full_name AS approver_name, u_app.username AS approver_username
           FROM purchase_requests pr
           LEFT JOIN projects p ON p.id = pr.project_id
           LEFT JOIN users u_req ON u_req.id = pr.created_by_user_id
           LEFT JOIN users u_app ON u_app.id = pr.approved_by_user_id
           WHERE LOWER(pr.pr_number) = LOWER($1)`,
          [String(prIdOrNumber).trim()]
        );

    if (prRes.rowCount === 0) {
      if (req.accepts('json') && !req.accepts('html')) {
        return res.status(404).json({ error: 'Purchase Request not found.', verified: false });
      }
      return res.status(404).send(renderVerificationHtml({ found: false }));
    }

    const pr = prRes.rows[0];

    // Fetch latest PDF document metadata
    const docRes = await query(
      `SELECT * FROM documents 
       WHERE purchase_request_id = $1 AND document_type = 'PR_PDF'
       ORDER BY id DESC LIMIT 1`,
      [pr.id]
    );
    const doc = docRes.rows[0] || null;

    const verifiedAt = new Date().toISOString();

    if (req.accepts('json') && !req.accepts('html')) {
      return res.json({
        verified: true,
        prNumber: pr.pr_number,
        status: pr.status,
        revision: pr.revision || 0,
        revisionString: `Rev ${String(pr.revision || 0).padStart(2, '0')}`,
        projectCode: pr.project_code,
        department: pr.department,
        requestedBy: pr.requester_name || pr.requester_username,
        submissionDate: pr.created_at,
        approvedBy: pr.status === 'APPROVED' ? (pr.approver_name || pr.approver_username) : null,
        approvedAt: pr.approved_at,
        sha256Checksum: doc ? doc.sha256_checksum : null,
        verifiedAt
      });
    }

    res.send(renderVerificationHtml({ found: true, pr, doc, verifiedAt }));
  } catch (err) {
    console.error('[Verification API] Error:', err);
    res.status(500).send('Database connection error during verification.');
  }
}

// Routes
router.get('/:prNumber/verify', handleVerification);
router.get('/:prNumber/qr', async (req, res) => {
  const prNumber = req.params.prNumber;
  try {
    const QRCode = require('qrcode');
    const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const verifyUrl = `${baseUrl}/pr/${encodeURIComponent(prNumber)}/verify`;
    const qrBuf = await QRCode.toBuffer(verifyUrl, { width: 120, margin: 0 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(qrBuf);
  } catch (err) {
    console.error('[QR API] Error generating QR:', err);
    res.status(500).send('Error generating QR code');
  }
});
router.get('/:prNumber', handleVerification);

module.exports = router;
