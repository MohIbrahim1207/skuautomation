/**
 * Authentication Routes (/api/auth)
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');

const { logActivity, extractClientIp } = require('../services/activityLogger');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Please enter both username/email and password.' });
  }

  const clientIp = extractClientIp(req);

  try {
    const clean = username.trim().toLowerCase();
    const result = await query(
      `SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1`,
      [clean]
    );

    if (result.rowCount === 0) {
      await logActivity({
        entityType: 'USER',
        action: 'LOGIN_FAILURE',
        module: 'AUTH',
        description: `Failed login attempt: User not found (${clean})`,
        ipAddress: clientIp,
        status: 'FAILURE',
        metadata: { attemptedUsername: clean }
      });
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    const user = result.rows[0];

    if (user.status === 'Disabled') {
      await logActivity({
        entityType: 'USER',
        entityId: user.id,
        action: 'LOGIN_BLOCKED',
        module: 'AUTH',
        description: `Disabled account attempted login: ${user.username} (${user.id})`,
        userId: user.id,
        username: user.username,
        role: user.role,
        ipAddress: clientIp,
        status: 'FAILURE',
        metadata: { userId: user.id, username: user.username }
      });
      return res.status(403).json({ error: 'This account has been disabled. Please contact the administrator.' });
    }

    const match = await bcrypt.compare(password.trim(), user.password_hash);
    if (!match) {
      await logActivity({
        entityType: 'USER',
        entityId: user.id,
        action: 'LOGIN_FAILURE',
        module: 'AUTH',
        description: `Failed login attempt: Invalid password for ${user.username}`,
        userId: user.id,
        username: user.username,
        role: user.role,
        ipAddress: clientIp,
        status: 'FAILURE',
        metadata: { userId: user.id, username: user.username }
      });
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    // Update last_login_at timestamp
    await query(
      `UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [user.id]
    );

    await logActivity({
      entityType: 'USER',
      entityId: user.id,
      action: 'LOGIN_SUCCESS',
      module: 'AUTH',
      description: `User ${user.username} (${user.full_name}) logged in successfully`,
      userId: user.id,
      username: user.username,
      role: user.role,
      ipAddress: clientIp,
      status: 'SUCCESS'
    });

    const tokenPayload = {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      email: user.email,
      role: user.role,
      mustChangePassword: user.must_change_password
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '12h' });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        mustChangePassword: user.must_change_password,
        lastLoginAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('[Auth API] Login error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out successfully.' });
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, full_name, username, email, role, status, must_change_password FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rowCount === 0 || result.rows[0].status === 'Disabled') {
      return res.status(401).json({ error: 'User session no longer valid.' });
    }

    const u = result.rows[0];
    res.json({
      id: u.id,
      fullName: u.full_name,
      username: u.username,
      email: u.email,
      role: u.role,
      status: u.status,
      mustChangePassword: u.must_change_password
    });
  } catch (err) {
    console.error('[Auth API] Me error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, async (req, res) => {
  const { newPassword } = req.body;

  if (!newPassword || newPassword.trim().length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters long.' });
  }

  try {
    const hash = await bcrypt.hash(newPassword.trim(), 10);
    const result = await query(
      `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2
       RETURNING id, full_name, username, email, role, status, must_change_password`,
      [hash, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const u = result.rows[0];

    await logActivity({
      entityType: 'USER',
      entityId: req.user.id,
      action: 'PASSWORD_CHANGED',
      module: 'AUTH',
      description: `User ${req.user.username} successfully updated their password`,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
      ipAddress: extractClientIp(req),
      status: 'SUCCESS'
    });

    res.json({
      success: true,
      message: 'Password updated successfully.',
      user: {
        id: u.id,
        fullName: u.full_name,
        username: u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        mustChangePassword: u.must_change_password
      }
    });
  } catch (err) {
    console.error('[Auth API] Change password error:', err);
    res.status(500).json({ error: 'Database connection unavailable. Please contact the administrator.' });
  }
});

module.exports = router;
