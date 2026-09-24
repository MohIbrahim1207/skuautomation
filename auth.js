/**
 * =========================================================================
 * FLOW FORCE SKU & PR AUTOMATION PORTAL - AUTHENTICATION & ACCESS CONTROL
 * =========================================================================
 * 
 * ARCHITECTURE NOTICE:
 * This is a Proof-of-Concept (POC) authentication and authorization module
 * operating against browser LocalStorage.
 * 
 * IMPORTANT SECURITY DISCLAIMER:
 * LocalStorage authentication is for Proof-of-Concept demonstration only and
 * is NOT production security. The module is architected with clean service
 * boundaries (AuthService, UserService, PermissionService) so it can be 
 * seamlessly replaced with a PostgreSQL database & Node.js backend in 
 * subsequent development phases.
 * =========================================================================
 */

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 1. STORAGE KEYS & ROLES DEFINITION
  // -------------------------------------------------------------------------
  const AUTH_STORAGE_KEYS = {
    USERS: 'sku_auto_users_v1',
    SESSION: 'sku_auto_session_v1'
  };

  // Extensible role structure: easily accommodate ENGINEERING, PURCHASING, WAREHOUSE later
  const ROLES = {
    ADMIN: 'ADMIN',
    EMPLOYEE: 'EMPLOYEE'
    // Future roles:
    // ENGINEERING: 'ENGINEERING',
    // PURCHASING: 'PURCHASING',
    // WAREHOUSE: 'WAREHOUSE'
  };

  const USER_STATUS = {
    ACTIVE: 'Active',
    DISABLED: 'Disabled'
  };

  // Simple string hashing helper for POC storage (keeps credentials obscured)
  function pocHash(str) {
    let hash = 0;
    const clean = String(str);
    for (let i = 0; i < clean.length; i++) {
      const char = clean.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return 'h_' + Math.abs(hash).toString(16) + '_' + clean.length;
  }

  // Initial POC Seed Accounts
  // Both require first-time login password change (mustChangePassword: true)
  const INITIAL_SEED_USERS = [
    {
      id: 'USR-001',
      fullName: 'System Administrator',
      username: 'admin',
      email: 'admin@flowforce.local',
      role: ROLES.ADMIN,
      status: USER_STATUS.ACTIVE,
      passwordHash: pocHash('admin123'),
      mustChangePassword: true,
      createdAt: '2026-09-01T08:00:00.000Z'
    },
    {
      id: 'USR-002',
      fullName: 'Employee',
      username: 'employee',
      email: 'employee@flowforce.local',
      role: ROLES.EMPLOYEE,
      status: USER_STATUS.ACTIVE,
      passwordHash: pocHash('employee123'),
      mustChangePassword: true,
      createdAt: '2026-09-01T08:00:00.000Z'
    }
  ];

  // -------------------------------------------------------------------------
  // 2. USER SERVICE - USER ACCOUNT MANAGEMENT
  // -------------------------------------------------------------------------
  const UserService = {
    init() {
      const existing = localStorage.getItem(AUTH_STORAGE_KEYS.USERS);
      if (!existing || !existing.trim()) {
        localStorage.setItem(AUTH_STORAGE_KEYS.USERS, JSON.stringify(INITIAL_SEED_USERS));
        return INITIAL_SEED_USERS;
      }
      try {
        const users = JSON.parse(existing);
        if (!Array.isArray(users)) {
          localStorage.setItem(AUTH_STORAGE_KEYS.USERS, JSON.stringify(INITIAL_SEED_USERS));
          return INITIAL_SEED_USERS;
        }
        // Normalize any seeded employee name if previously saved as 'Standard Employee'
        let modified = false;
        users.forEach(u => {
          if (u.username === 'employee' && u.fullName === 'Standard Employee') {
            u.fullName = 'Employee';
            modified = true;
          }
        });
        if (modified) {
          localStorage.setItem(AUTH_STORAGE_KEYS.USERS, JSON.stringify(users));
        }
        return users;
      } catch (e) {
        console.error('[UserService] Error parsing stored users; restoring seed defaults', e);
        localStorage.setItem(AUTH_STORAGE_KEYS.USERS, JSON.stringify(INITIAL_SEED_USERS));
        return INITIAL_SEED_USERS;
      }
    },

    getUsers() {
      return this.init();
    },

    getUserById(id) {
      if (!id) return null;
      const users = this.getUsers();
      return users.find(u => u.id === id) || null;
    },

    getUserByUsername(username) {
      if (!username) return null;
      const clean = username.trim().toLowerCase();
      const users = this.getUsers();
      return users.find(u => u.username.toLowerCase() === clean || (u.email && u.email.toLowerCase() === clean)) || null;
    },

    saveUsers(users) {
      localStorage.setItem(AUTH_STORAGE_KEYS.USERS, JSON.stringify(users));
    },

    createUser({ fullName, username, email, role, password, status }) {
      const users = this.getUsers();
      const cleanUsername = (username || '').trim().toLowerCase();
      const cleanEmail = (email || '').trim().toLowerCase();
      const cleanFullName = (fullName || '').trim();

      if (!cleanFullName) throw new Error('Full Name is required.');
      if (!cleanUsername) throw new Error('Username is required.');
      if (!password || !password.trim()) throw new Error('Password is required.');

      // Validate email format if provided
      if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        throw new Error('Please enter a valid corporate email address.');
      }

      // Check unique username
      const duplicateUsername = users.find(u => u.username.toLowerCase() === cleanUsername);
      if (duplicateUsername) {
        throw new Error(`Username '${cleanUsername}' is already taken. Please choose another.`);
      }

      // Check unique email if provided
      if (cleanEmail) {
        const duplicateEmail = users.find(u => u.email && u.email.toLowerCase() === cleanEmail);
        if (duplicateEmail) {
          throw new Error(`Email '${cleanEmail}' is already registered.`);
        }
      }

      // Role must strictly be EMPLOYEE for employee creation
      const assignedRole = (role === ROLES.ADMIN) ? ROLES.ADMIN : ROLES.EMPLOYEE;

      // Generate sequential ID based on highest existing ID
      let maxNum = 0;
      users.forEach(u => {
        const match = u.id && u.id.match(/^USR-(\d+)$/i);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > maxNum) maxNum = n;
        }
      });
      const id = `USR-${String(maxNum + 1).padStart(3, '0')}`;

      const newUser = {
        id,
        fullName: cleanFullName,
        username: cleanUsername,
        email: cleanEmail || `${cleanUsername}@flowforce.local`,
        role: assignedRole,
        status: (status === USER_STATUS.DISABLED) ? USER_STATUS.DISABLED : USER_STATUS.ACTIVE,
        passwordHash: pocHash(password.trim()),
        mustChangePassword: true,
        createdAt: new Date().toISOString()
      };

      users.push(newUser);
      this.saveUsers(users);
      return newUser;
    },

    updateUser(id, { fullName, username, email, role, status }) {
      const users = this.getUsers();
      const user = users.find(u => u.id === id);
      if (!user) throw new Error('User not found.');

      const cleanUsername = (username || '').trim().toLowerCase();
      const cleanEmail = (email || '').trim().toLowerCase();
      const cleanFullName = (fullName || '').trim();

      // Check duplicate username with another user
      if (cleanUsername && cleanUsername !== user.username.toLowerCase()) {
        const duplicate = users.find(u => u.id !== id && u.username.toLowerCase() === cleanUsername);
        if (duplicate) throw new Error(`Username '${cleanUsername}' is already taken.`);
        user.username = cleanUsername;
      }

      // Check duplicate email with another user
      if (cleanEmail && cleanEmail !== (user.email || '').toLowerCase()) {
        const duplicate = users.find(u => u.id !== id && u.email && u.email.toLowerCase() === cleanEmail);
        if (duplicate) throw new Error(`Email '${cleanEmail}' is already taken.`);
        user.email = cleanEmail;
      }

      if (cleanFullName) user.fullName = cleanFullName;

      // Role change check
      if (role && role !== user.role) {
        if (user.role === ROLES.ADMIN && role !== ROLES.ADMIN) {
          const activeAdmins = users.filter(u => u.role === ROLES.ADMIN && u.status === USER_STATUS.ACTIVE);
          if (activeAdmins.length <= 1) {
            throw new Error('Cannot change role of the only active Administrator account.');
          }
        }
        if (ROLES[role]) user.role = role;
      }

      // Status change check
      if (status && (status === USER_STATUS.ACTIVE || status === USER_STATUS.DISABLED)) {
        if (user.role === ROLES.ADMIN && status === USER_STATUS.DISABLED) {
          const activeAdmins = users.filter(u => u.role === ROLES.ADMIN && u.status === USER_STATUS.ACTIVE);
          if (activeAdmins.length <= 1) {
            throw new Error('Cannot disable the only active Administrator account.');
          }
        }
        user.status = status;
      }

      this.saveUsers(users);

      // If active session belongs to this user, update active session
      const currentSession = AuthService.getCurrentUser();
      if (currentSession && currentSession.id === id) {
        if (user.status === USER_STATUS.DISABLED) {
          AuthService.logout();
        } else {
          AuthService.saveSession(user);
        }
      }

      return user;
    },

    setUserStatus(id, newStatus) {
      if (newStatus !== USER_STATUS.ACTIVE && newStatus !== USER_STATUS.DISABLED) {
        throw new Error('Invalid user status.');
      }
      const users = this.getUsers();
      const user = users.find(u => u.id === id);
      if (!user) throw new Error('User not found.');

      // Prevent disabling the primary admin if it's the only active admin
      if (user.role === ROLES.ADMIN && newStatus === USER_STATUS.DISABLED) {
        const activeAdmins = users.filter(u => u.role === ROLES.ADMIN && u.status === USER_STATUS.ACTIVE);
        if (activeAdmins.length <= 1) {
          throw new Error('Cannot disable the only active Administrator account. The system must always have at least one active Admin.');
        }
      }

      user.status = newStatus;
      this.saveUsers(users);

      // If disabling currently logged in user, terminate their session
      const currentSession = AuthService.getCurrentUser();
      if (currentSession && currentSession.id === id && newStatus === USER_STATUS.DISABLED) {
        AuthService.logout();
      }

      return user;
    },

    resetPassword(id, newPassword) {
      const users = this.getUsers();
      const user = users.find(u => u.id === id);
      if (!user) throw new Error('User not found.');

      const targetPass = newPassword || 'FlowForce2026!';
      user.passwordHash = pocHash(targetPass);
      user.mustChangePassword = true;

      this.saveUsers(users);
      return { user, tempPassword: targetPass };
    },

    setUserPassword(id, newPassword) {
      if (!newPassword || newPassword.trim().length < 4) {
        throw new Error('Password must be at least 4 characters long.');
      }
      const users = this.getUsers();
      const user = users.find(u => u.id === id);
      if (!user) throw new Error('User not found.');

      user.passwordHash = pocHash(newPassword.trim());
      user.mustChangePassword = false;

      this.saveUsers(users);

      // Refresh session if same user
      const currentSession = AuthService.getCurrentUser();
      if (currentSession && currentSession.id === id) {
        AuthService.saveSession(user);
      }

      return user;
    }
  };

  // -------------------------------------------------------------------------
  // 3. AUTH SERVICE - LOGIN, LOGOUT & SESSION LIFECYCLE
  // -------------------------------------------------------------------------
  const AuthService = {
    init() {
      UserService.init();
    },

    getToken() {
      const raw = localStorage.getItem(AUTH_STORAGE_KEYS.SESSION);
      if (!raw) return '';
      try {
        const session = JSON.parse(raw);
        return session.token || '';
      } catch (e) {
        return '';
      }
    },

    async checkDbHealth() {
      try {
        const resp = await fetch('/api/health');
        if (!resp.ok) return false;
        const data = await resp.json();
        return data.database === 'connected';
      } catch (e) {
        return false;
      }
    },

    async login(identifier, password) {
      if (!identifier || !password) {
        return { success: false, error: 'Please enter both username/email and password.' };
      }

      // 1. Authenticate against PostgreSQL backend API
      try {
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: identifier.trim(), password: password })
        });

        if (resp.ok) {
          const data = await resp.json();
          if (data.success && data.token) {
            this.saveSession(data.user, data.token);
            return {
              success: true,
              token: data.token,
              mustChangePassword: Boolean(data.user.mustChangePassword),
              user: data.user
            };
          }
        } else {
          const errData = await resp.json().catch(() => ({}));
          return {
            success: false,
            error: errData.error || 'Invalid username/email or password.'
          };
        }
      } catch (err) {
        console.warn('[AuthService] Backend login call failed, falling back to local user store:', err);
      }

      // 2. Fallback for offline/POC local user store
      const user = UserService.getUserByUsername(identifier);
      if (!user) {
        return { success: false, error: 'Invalid username/email or password.' };
      }

      if (user.status === USER_STATUS.DISABLED) {
        return {
          success: false,
          error: 'This account has been disabled. Please contact your system administrator.'
        };
      }

      const inputHash = pocHash(password.trim());
      if (user.passwordHash !== inputHash) {
        return { success: false, error: 'Invalid username/email or password.' };
      }

      // Check if password change is required on first login
      if (user.mustChangePassword) {
        return {
          success: true,
          mustChangePassword: true,
          user: this._sanitizeUser(user)
        };
      }

      // Successful login
      this.saveSession(user);
      return {
        success: true,
        mustChangePassword: false,
        user: this._sanitizeUser(user)
      };
    },

    async completeFirstLoginPasswordChange(userId, newPassword) {
      if (!newPassword || newPassword.trim().length < 4) {
        throw new Error('New password must be at least 4 characters long.');
      }
      const token = this.getToken();
      let updatedUser = this.getCurrentUser() || { id: userId };

      if (token) {
        try {
          const resp = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ newPassword: newPassword.trim() })
          });
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to update password on server.');
          }
          const data = await resp.json().catch(() => ({}));
          if (data.user) {
            updatedUser = data.user;
          }
        } catch (e) {
          console.warn('[AuthService] Backend password change call:', e);
          if (e.message && !e.message.includes('fetch')) {
            throw e;
          }
        }
      }

      updatedUser.mustChangePassword = false;

      // Best effort sync to local mock storage
      try {
        if (typeof UserService !== 'undefined' && UserService.getUserById && UserService.getUserById(userId)) {
          UserService.setUserPassword(userId, newPassword);
        }
      } catch (e) {}

      this.saveSession(updatedUser, token);
      return { success: true, user: this._sanitizeUser(updatedUser) };
    },

    saveSession(user, token) {
      const existingToken = this.getToken();
      const sessionData = {
        user: this._sanitizeUser(user),
        token: token || existingToken || ('poc_token_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)),
        loginAt: new Date().toISOString()
      };
      localStorage.setItem(AUTH_STORAGE_KEYS.SESSION, JSON.stringify(sessionData));
    },

    getCurrentUser() {
      const raw = localStorage.getItem(AUTH_STORAGE_KEYS.SESSION);
      if (!raw) return null;
      try {
        const session = JSON.parse(raw);
        if (!session || !session.user || !session.user.id) return null;

        // Verify account is still active and valid in user store if available
        if (typeof UserService !== 'undefined' && UserService.getUserById) {
          const liveUser = UserService.getUserById(session.user.id);
          if (liveUser && liveUser.status === USER_STATUS.DISABLED) {
            this.logout();
            return null;
          }
        }

        return session.user;
      } catch (e) {
        this.logout();
        return null;
      }
    },

    isAuthenticated() {
      return !!this.getCurrentUser() && !!this.getToken();
    },

    logout() {
      localStorage.removeItem(AUTH_STORAGE_KEYS.SESSION);
    },

    _sanitizeUser(user) {
      if (!user) return null;
      const { passwordHash, ...safe } = user;
      return safe;
    }
  };

  // -------------------------------------------------------------------------
  // 4. PERMISSION SERVICE - ROLE-BASED CAPABILITY MATRIX
  // -------------------------------------------------------------------------
  const PERMISSIONS = {
    // Admin Only Capabilities
    CAN_CREATE_SKU: 'CAN_CREATE_SKU',
    CAN_EDIT_MASTER_ITEM: 'CAN_EDIT_MASTER_ITEM',
    CAN_EDIT_ITEM_DESCRIPTION: 'CAN_EDIT_ITEM_DESCRIPTION',
    CAN_EDIT_PRICE: 'CAN_EDIT_PRICE',
    CAN_EDIT_STATUS: 'CAN_EDIT_STATUS',
    CAN_EDIT_REMARKS: 'CAN_EDIT_REMARKS',
    CAN_DELETE_MASTER_ITEM: 'CAN_DELETE_MASTER_ITEM',
    CAN_MANAGE_USERS: 'CAN_MANAGE_USERS',
    CAN_VIEW_ALL_PRS: 'CAN_VIEW_ALL_PRS',
    CAN_ACCESS_SETTINGS: 'CAN_ACCESS_SETTINGS',
    CAN_APPROVE_PR: 'CAN_APPROVE_PR',
    CAN_REJECT_PR: 'CAN_REJECT_PR',

    // Import Workflow Capabilities
    CAN_IMPORT_EXCEL: 'CAN_IMPORT_EXCEL',
    CAN_APPROVE_IMPORT: 'CAN_APPROVE_IMPORT',
    CAN_VIEW_MY_IMPORTS: 'CAN_VIEW_MY_IMPORTS',

    // Shared Employee & Admin Capabilities
    CAN_VIEW_DASHBOARD: 'CAN_VIEW_DASHBOARD',
    CAN_VIEW_MASTER_CATALOG: 'CAN_VIEW_MASTER_CATALOG',
    CAN_VIEW_RAW_MATERIALS: 'CAN_VIEW_RAW_MATERIALS',
    CAN_SEARCH_RAW_MATERIALS: 'CAN_SEARCH_RAW_MATERIALS',
    CAN_SEARCH_MASTER_ITEMS: 'CAN_SEARCH_MASTER_ITEMS',
    CAN_VIEW_SPECS: 'CAN_VIEW_SPECS',
    CAN_CREATE_PR: 'CAN_CREATE_PR',
    CAN_VIEW_OWN_PRS: 'CAN_VIEW_OWN_PRS',
    CAN_PRINT_OWN_PRS: 'CAN_PRINT_OWN_PRS'
  };

  // Role Permissions Matrix
  const ROLE_CAPABILITIES = {
    [ROLES.ADMIN]: [
      PERMISSIONS.CAN_CREATE_SKU,
      PERMISSIONS.CAN_EDIT_MASTER_ITEM,
      PERMISSIONS.CAN_EDIT_ITEM_DESCRIPTION,
      PERMISSIONS.CAN_EDIT_PRICE,
      PERMISSIONS.CAN_EDIT_STATUS,
      PERMISSIONS.CAN_EDIT_REMARKS,
      PERMISSIONS.CAN_DELETE_MASTER_ITEM,
      PERMISSIONS.CAN_MANAGE_USERS,
      PERMISSIONS.CAN_VIEW_ALL_PRS,
      PERMISSIONS.CAN_ACCESS_SETTINGS,
      PERMISSIONS.CAN_APPROVE_PR,
      PERMISSIONS.CAN_REJECT_PR,
      PERMISSIONS.CAN_VIEW_DASHBOARD,
      PERMISSIONS.CAN_VIEW_MASTER_CATALOG,
      PERMISSIONS.CAN_VIEW_RAW_MATERIALS,
      PERMISSIONS.CAN_SEARCH_RAW_MATERIALS,
      PERMISSIONS.CAN_SEARCH_MASTER_ITEMS,
      PERMISSIONS.CAN_VIEW_SPECS,
      PERMISSIONS.CAN_CREATE_PR,
      PERMISSIONS.CAN_VIEW_OWN_PRS,
      PERMISSIONS.CAN_PRINT_OWN_PRS,
      PERMISSIONS.CAN_IMPORT_EXCEL,
      PERMISSIONS.CAN_APPROVE_IMPORT,
      PERMISSIONS.CAN_VIEW_MY_IMPORTS
    ],
    [ROLES.EMPLOYEE]: [
      PERMISSIONS.CAN_VIEW_DASHBOARD,
      PERMISSIONS.CAN_VIEW_MASTER_CATALOG,
      PERMISSIONS.CAN_VIEW_RAW_MATERIALS,
      PERMISSIONS.CAN_SEARCH_RAW_MATERIALS,
      PERMISSIONS.CAN_SEARCH_MASTER_ITEMS,
      PERMISSIONS.CAN_VIEW_SPECS,
      PERMISSIONS.CAN_CREATE_PR,
      PERMISSIONS.CAN_VIEW_OWN_PRS,
      PERMISSIONS.CAN_PRINT_OWN_PRS,
      PERMISSIONS.CAN_EDIT_STATUS,
      PERMISSIONS.CAN_EDIT_REMARKS,
      PERMISSIONS.CAN_IMPORT_EXCEL,
      PERMISSIONS.CAN_VIEW_MY_IMPORTS
    ]
  };

  const PermissionService = {
    can(permission, userOverride = null) {
      const user = userOverride || AuthService.getCurrentUser();
      if (!user) return false;
      const role = user.role;
      const capabilities = ROLE_CAPABILITIES[role] || [];
      return capabilities.includes(permission);
    },

    isCurrentUserAdmin() {
      const user = AuthService.getCurrentUser();
      return !!(user && user.role === ROLES.ADMIN);
    },

    isCurrentUserEmployee() {
      const user = AuthService.getCurrentUser();
      return !!(user && user.role === ROLES.EMPLOYEE);
    },

    enforce(permission, errorMessage = 'Access Denied — Administrator permission required.') {
      if (!this.can(permission)) {
        this.notifyAccessDenied(errorMessage);
        throw new Error(errorMessage);
      }
      return true;
    },

    notifyAccessDenied(message = 'Access Denied — Administrator permission required.') {
      if (window.UI && typeof window.UI.showAccessDeniedModal === 'function') {
        window.UI.showAccessDeniedModal(message);
      } else if (window.UI && typeof window.UI.showToast === 'function') {
        window.UI.showToast('Access Denied', message, 'error');
      } else {
        alert(message);
      }
    }
  };

  // -------------------------------------------------------------------------
  // 5. EXPOSE SERVICES TO GLOBAL SCOPE
  // -------------------------------------------------------------------------
  window.AUTH_STORAGE_KEYS = AUTH_STORAGE_KEYS;
  window.ROLES = ROLES;
  window.USER_STATUS = USER_STATUS;
  window.PERMISSIONS = PERMISSIONS;
  window.UserService = UserService;
  window.AuthService = AuthService;
  window.PermissionService = PermissionService;

})();
