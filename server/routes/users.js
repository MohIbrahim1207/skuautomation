/**
 * User Management Routes (/api/users) - Admin Only
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../db/pool');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { logActivity, extractClientIp } = require('../services/activityLogger');

// Apply authentication and admin verification across all user management routes
router.use(authenticateToken);
router.use(requireAdmin);

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, full_name, username, email, role, status, must_change_password, last_login_at, created_at 
       FROM users 
       ORDER BY created_at ASC`
    );

    const users = result.rows.map(u => ({
      id: u.id,
      fullName: u.full_name,
      username: u.username,
      email: u.email,
      role: u.role,
      status: u.status,
      mustChangePassword: u.must_change_password,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at
    }));

    res.json(users);
  } catch (err) {
    console.error('[Users API] List error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// GET /api/users/check-username?username=...
router.get('/check-username', async (req, res) => {
  const cleanUsername = (req.query.username || '').trim().toLowerCase();

  if (!cleanUsername) {
    return res.status(400).json({ error: 'Username is required.' });
  }

  try {
    const check = await query('SELECT 1 FROM users WHERE LOWER(username) = $1', [cleanUsername]);
    res.json({
      available: check.rowCount === 0,
      username: cleanUsername
    });
  } catch (err) {
    console.error('[Users API] Check username error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/users - Add Employee
router.post('/', async (req, res) => {
  const { fullName, username, email, password, status } = req.body;

  const cleanUsername = (username || '').trim().toLowerCase();
  const cleanFullName = (fullName || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();

  if (!cleanFullName) return res.status(400).json({ error: 'Full Name is required.' });
  if (!cleanUsername) return res.status(400).json({ error: 'Username is required.' });
  if (!password || !password.trim()) return res.status(400).json({ error: 'Password is required.' });

  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid corporate email address.' });
  }

  try {
    // Check duplicate username
    const dupUser = await query('SELECT 1 FROM users WHERE LOWER(username) = $1', [cleanUsername]);
    if (dupUser.rowCount > 0) {
      return res.status(400).json({ error: `Username '${cleanUsername}' is already taken. Please choose another.` });
    }

    if (cleanEmail) {
      const dupEmail = await query('SELECT 1 FROM users WHERE LOWER(email) = $1', [cleanEmail]);
      if (dupEmail.rowCount > 0) {
        return res.status(400).json({ error: `Email '${cleanEmail}' is already registered.` });
      }
    }

    // Determine next sequential USR ID
    const idRes = await query(`SELECT id FROM users WHERE id LIKE 'USR-%'`);
    let maxNum = 0;
    idRes.rows.forEach(r => {
      const m = r.id.match(/^USR-(\d+)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    });
    const nextId = `USR-${String(maxNum + 1).padStart(3, '0')}`;

    const hash = await bcrypt.hash(password.trim(), 10);
    const assignedRole = 'EMPLOYEE'; // Strictly EMPLOYEE for Add Employee
    const initialStatus = status === 'Disabled' ? 'Disabled' : 'Active';

    await query(
      `INSERT INTO users (id, full_name, username, email, password_hash, role, status, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [nextId, cleanFullName, cleanUsername, cleanEmail || `${cleanUsername}@flowforce.local`, hash, assignedRole, initialStatus]
    );

    await logActivity({
      entityType: 'USER',
      entityId: nextId,
      action: 'USER_CREATED',
      module: 'USER_MANAGEMENT',
      description: `Administrator ${req.user.username} created user account ${cleanUsername} (${cleanFullName}, ID: ${nextId})`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS',
      afterValue: {
        id: nextId,
        fullName: cleanFullName,
        username: cleanUsername,
        email: cleanEmail || `${cleanUsername}@flowforce.local`,
        role: assignedRole,
        status: initialStatus
      }
    });

    res.status(201).json({
      id: nextId,
      fullName: cleanFullName,
      username: cleanUsername,
      email: cleanEmail || `${cleanUsername}@flowforce.local`,
      role: assignedRole,
      status: initialStatus,
      mustChangePassword: true
    });
  } catch (err) {
    console.error('[Users API] Create user error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// PUT /api/users/:id - Edit User
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { fullName, username, email, status } = req.body;

  const cleanUsername = (username || '').trim().toLowerCase();
  const cleanFullName = (fullName || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();

  try {
    const existing = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = existing.rows[0];

    if (cleanUsername && cleanUsername !== user.username.toLowerCase()) {
      const dup = await query('SELECT 1 FROM users WHERE id <> $1 AND LOWER(username) = $2', [id, cleanUsername]);
      if (dup.rowCount > 0) return res.status(400).json({ error: `Username '${cleanUsername}' is already taken.` });
    }

    if (cleanEmail && cleanEmail !== (user.email || '').toLowerCase()) {
      const dup = await query('SELECT 1 FROM users WHERE id <> $1 AND LOWER(email) = $2', [id, cleanEmail]);
      if (dup.rowCount > 0) return res.status(400).json({ error: `Email '${cleanEmail}' is already registered.` });
    }

    // Check last active admin protection
    if (user.role === 'ADMIN' && status === 'Disabled') {
      const activeAdmins = await query("SELECT 1 FROM users WHERE role = 'ADMIN' AND status = 'Active'");
      if (activeAdmins.rowCount <= 1) {
        return res.status(400).json({ error: 'Cannot disable the only active Administrator account.' });
      }
    }

    await query(
      `UPDATE users 
       SET full_name = COALESCE($1, full_name),
           username = COALESCE($2, username),
           email = COALESCE($3, email),
           status = COALESCE($4, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [cleanFullName || null, cleanUsername || null, cleanEmail || null, status || null, id]
    );

    await logActivity({
      entityType: 'USER',
      entityId: id,
      action: 'USER_UPDATED',
      module: 'USER_MANAGEMENT',
      description: `Administrator ${req.user.username} updated profile for user ${user.username} (${id})`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS',
      beforeValue: {
        fullName: user.full_name,
        username: user.username,
        email: user.email,
        status: user.status
      },
      afterValue: {
        fullName: cleanFullName || user.full_name,
        username: cleanUsername || user.username,
        email: cleanEmail || user.email,
        status: status || user.status
      }
    });

    res.json({ success: true, message: 'User updated successfully.' });
  } catch (err) {
    console.error('[Users API] Update user error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// PATCH /api/users/:id/status - Toggle Status
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (status !== 'Active' && status !== 'Disabled') {
    return res.status(400).json({ error: 'Invalid user status.' });
  }

  try {
    const existing = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    const user = existing.rows[0];

    // Protect last active admin
    if (user.role === 'ADMIN' && status === 'Disabled') {
      const activeAdmins = await query("SELECT 1 FROM users WHERE role = 'ADMIN' AND status = 'Active'");
      if (activeAdmins.rowCount <= 1) {
        return res.status(400).json({ error: 'Cannot disable the only active Administrator account. The system must always have at least one active Admin.' });
      }
      if (req.user.id === user.id) {
        return res.status(400).json({ error: 'You cannot disable your own active Administrator account.' });
      }
    }

    await query('UPDATE users SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, id]);

    const action = status === 'Active' ? 'USER_ENABLED' : 'USER_DISABLED';
    await logActivity({
      entityType: 'USER',
      entityId: id,
      action,
      module: 'USER_MANAGEMENT',
      description: `Administrator ${req.user.username} set user ${user.username} status to ${status}`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS',
      beforeValue: { status: user.status },
      afterValue: { status }
    });

    res.json({ success: true, message: `User status updated to ${status}.` });
  } catch (err) {
    console.error('[Users API] Status toggle error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/users/:id/reset-password - Admin Reset Password
router.post('/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { tempPassword } = req.body;

  const targetPass = tempPassword || 'FlowForce2026!';

  try {
    const hash = await bcrypt.hash(targetPass, 10);
    const result = await query(
      `UPDATE users SET password_hash = $1, must_change_password = true, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING full_name, username`,
      [hash, id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    const user = result.rows[0];

    await logActivity({
      entityType: 'USER',
      entityId: id,
      action: 'PASSWORD_RESET',
      module: 'USER_MANAGEMENT',
      description: `Administrator ${req.user.username} reset password for user ${user.username} (${user.full_name}, ID: ${id}) with must_change_password required`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS'
    });

    res.json({
      success: true,
      message: `Temporary password set for ${user.full_name}. User must change it upon next login.`
    });
  } catch (err) {
    console.error('[Users API] Reset password error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/users/:id/force-password-change - Force user to change password on next login
router.post('/:id/force-password-change', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await query(
      `UPDATE users SET must_change_password = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING full_name, username`,
      [id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    const user = result.rows[0];

    await logActivity({
      entityType: 'USER',
      entityId: id,
      action: 'FORCE_PASSWORD_CHANGE',
      module: 'USER_MANAGEMENT',
      description: `Administrator ${req.user.username} flagged user ${user.username} (${user.full_name}) to force password change on next login`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS'
    });

    res.json({
      success: true,
      message: `Password change required flag set for ${user.full_name}.`
    });
  } catch (err) {
    console.error('[Users API] Force password change error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

module.exports = router;
