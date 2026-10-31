/* ==========================================================================
   FLOW FORCE ENTERPRISE DESIGN SYSTEM - SHELL CONTROLLER
   Phase 0 & 1: Theme, Sidebar Collapse, Breadcrumbs, Command Palette
   ========================================================================== */

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 1. THEME MANAGER (Light & Dark Themes)
  // -------------------------------------------------------------------------
  const THEME_STORAGE_KEY = 'flowforce_theme';

  const ThemeManager = {
    init() {
      const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
      let initialTheme = savedTheme;

      if (!initialTheme) {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        initialTheme = prefersDark ? 'dark' : 'light';
      }

      this.apply(initialTheme, false);

      // Listen for system preference changes if user hasn't explicitly set preference
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
          if (!localStorage.getItem(THEME_STORAGE_KEY)) {
            this.apply(e.matches ? 'dark' : 'light', false);
          }
        });
      }

      // Bind theme toggle buttons
      const toggleBtn = document.getElementById('themeToggleBtn');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => this.toggle());
      }

      // Keyboard shortcut: Ctrl+J or Cmd+J to toggle theme
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
          e.preventDefault();
          this.toggle();
        }
      });
    },

    apply(theme, save = true) {
      document.documentElement.setAttribute('data-theme', theme);
      if (save) {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      }
      const toggleBtn = document.getElementById('themeToggleBtn');
      if (toggleBtn) {
        toggleBtn.setAttribute('title', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode (Ctrl+J)`);
      }
    },

    toggle() {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      this.apply(next, true);
      if (window.UI && typeof window.UI.showToast === 'function') {
        window.UI.showToast(`Switched to ${next === 'dark' ? 'Dark' : 'Light'} theme`, 'info');
      }
    }
  };

  // -------------------------------------------------------------------------
  // 2. SIDEBAR MANAGER (Collapse & Responsive Drawer)
  // -------------------------------------------------------------------------
  const SIDEBAR_STORAGE_KEY = 'flowforce_sidebar_collapsed';

  const SidebarManager = {
    init() {
      const sidebar = document.getElementById('appSidebar');
      const toggleBtn = document.getElementById('btnToggleSidebar');
      const mobileBtn = document.getElementById('mobileDrawerBtn');
      const drawerOverlay = document.getElementById('sidebarDrawerOverlay');

      if (!sidebar) return;

      // Restore collapsed preference
      const isCollapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
      if (isCollapsed) {
        sidebar.classList.add('sidebar-collapsed');
      }

      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => this.toggleCollapse());
      }

      if (mobileBtn) {
        mobileBtn.addEventListener('click', () => this.toggleMobileDrawer());
      }

      if (drawerOverlay) {
        drawerOverlay.addEventListener('click', () => this.closeMobileDrawer());
      }

      // Keyboard shortcut: Ctrl+B to toggle sidebar
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
          // If not typing in input or textarea
          const tag = (document.activeElement && document.activeElement.tagName) || '';
          if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
            e.preventDefault();
            this.toggleCollapse();
          }
        }
      });
    },

    toggleCollapse() {
      const sidebar = document.getElementById('appSidebar');
      if (!sidebar) return;
      const collapsed = sidebar.classList.toggle('sidebar-collapsed');
      localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'true' : 'false');
    },

    toggleMobileDrawer() {
      const sidebar = document.getElementById('appSidebar');
      const overlay = document.getElementById('sidebarDrawerOverlay');
      if (!sidebar) return;
      const open = sidebar.classList.toggle('drawer-open');
      if (overlay) overlay.classList.toggle('active', open);
    },

    closeMobileDrawer() {
      const sidebar = document.getElementById('appSidebar');
      const overlay = document.getElementById('sidebarDrawerOverlay');
      if (sidebar) sidebar.classList.remove('drawer-open');
      if (overlay) overlay.classList.remove('active');
    }
  };

  // -------------------------------------------------------------------------
  // 3. BREADCRUMB MANAGER
  // -------------------------------------------------------------------------
  const BreadcrumbManager = {
    viewTitles: {
      'dashboard': 'Dashboard',
      'catalog': 'Item Catalogue',
      'prs': 'Purchase Requests',
      'projects': 'Project Library',
      'import-review': 'Import Review',
      'my-imports': 'My Imports',
      'users': 'User Management',
      'audit-logs': 'Activity & Audit Logs',
      'settings': 'Settings'
    },

    set(title, category = null) {
      const crumbEl = document.getElementById('topbarBreadcrumb');
      if (!crumbEl) return;
      if (category) {
        crumbEl.textContent = `${title} / ${category}`;
      } else {
        crumbEl.textContent = title;
      }
    },

    updateFromView(viewName, subTitle = null) {
      const title = this.viewTitles[viewName] || (viewName.charAt(0).toUpperCase() + viewName.slice(1));
      this.set(title, subTitle);
    }
  };

  // -------------------------------------------------------------------------
  // 4. COMMAND PALETTE (Ctrl+K / ⌘K)
  // -------------------------------------------------------------------------
  const CommandPalette = {
    isOpen: false,
    selectedIndex: 0,
    items: [],

    init() {
      const backdrop = document.getElementById('cmdPaletteBackdrop');
      const input = document.getElementById('cmdPaletteInput');

      if (!backdrop || !input) return;

      // Close on backdrop click
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) this.close();
      });

      // Filter on input
      input.addEventListener('input', (e) => {
        this.filter(e.target.value);
      });

      // Keyboard navigation
      window.addEventListener('keydown', (e) => {
        // Global Ctrl+K / Cmd+K trigger
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          this.toggle();
          return;
        }

        // Palette-specific navigation
        if (this.isOpen) {
          if (e.key === 'Escape') {
            e.preventDefault();
            this.close();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.selectNext();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.selectPrev();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            this.executeSelected();
          }
        }
      });
    },

    open() {
      const backdrop = document.getElementById('cmdPaletteBackdrop');
      const input = document.getElementById('cmdPaletteInput');
      if (!backdrop) return;
      this.isOpen = true;
      backdrop.classList.add('active');
      if (input) {
        input.value = '';
        input.focus();
      }
      this.filter('');
    },

    close() {
      const backdrop = document.getElementById('cmdPaletteBackdrop');
      if (!backdrop) return;
      this.isOpen = false;
      backdrop.classList.remove('active');
    },

    toggle() {
      if (this.isOpen) this.close(); else this.open();
    },

    getStaticActions() {
      const actions = [
        {
          id: 'nav-dashboard',
          section: 'Navigation',
          title: 'Dashboard',
          icon: 'layout-dashboard',
          action: () => { window.UI && window.UI.switchView('dashboard'); }
        },
        {
          id: 'nav-catalog',
          section: 'Navigation',
          title: 'Item Catalogue',
          icon: 'package',
          action: () => { window.UI && window.UI.switchView('catalog'); }
        },
        {
          id: 'nav-prs',
          section: 'Navigation',
          title: 'Purchase Requests',
          icon: 'clipboard-list',
          action: () => { window.UI && window.UI.switchView('prs'); }
        },
        {
          id: 'nav-projects',
          section: 'Navigation',
          title: 'Project Library',
          icon: 'folder-kanban',
          action: () => { window.UI && window.UI.switchView('projects'); }
        },
        {
          id: 'action-create-pr',
          section: 'Quick Actions',
          title: 'Create New Purchase Request',
          icon: 'file-plus-2',
          action: () => { window.UI && window.UI.openCreatePrModal(); }
        },
        {
          id: 'action-open-cart',
          section: 'Quick Actions',
          title: 'Open PR Cart',
          icon: 'shopping-cart',
          action: () => { const b = document.getElementById('btnHeaderCart'); if (b) b.click(); }
        },
        {
          id: 'action-import-excel',
          section: 'Quick Actions',
          title: 'Import Items from Excel',
          icon: 'file-spreadsheet',
          action: () => { window.UI && window.UI.openExcelImportModal(); }
        },
        {
          id: 'action-ducting',
          section: 'Quick Actions',
          title: 'Standard Ducting Configuration Workflow',
          icon: 'compass',
          action: () => {
            if (window.DuctingWorkflowController) {
              window.DuctingWorkflowController.open(window.UI ? window.UI.currentProjectId : null);
            }
          }
        },
        {
          id: 'action-fasteners',
          section: 'Quick Actions',
          title: 'Browse Fasteners Specification',
          icon: 'wrench',
          action: () => { window.UI && window.UI.openCategory('Fasteners'); }
        },
        {
          id: 'action-toggle-theme',
          section: 'Preferences',
          title: 'Toggle Light / Dark Theme',
          icon: 'sun-moon',
          action: () => { ThemeManager.toggle(); }
        }
      ];

      // Add Admin only actions
      const curUser = window.AuthService ? window.AuthService.getCurrentUser() : null;
      if (curUser && curUser.role === 'ADMIN') {
        actions.push(
          {
            id: 'action-new-sku',
            section: 'Administration',
            title: 'Add New Master SKU Item',
            icon: 'plus-circle',
            action: () => { window.UI && window.UI.openNewSkuModal(); }
          },
          {
            id: 'action-users',
            section: 'Administration',
            title: 'User Management & Permissions',
            icon: 'users',
            action: () => { window.UI && window.UI.switchView('users'); }
          },
          {
            id: 'action-audit',
            section: 'Administration',
            title: 'Activity & Audit Compliance Logs',
            icon: 'history',
            action: () => { window.UI && window.UI.switchView('audit-logs'); }
          },
          {
            id: 'action-settings',
            section: 'Administration',
            title: 'Enterprise System Settings',
            icon: 'settings',
            action: () => { window.UI && window.UI.switchView('settings'); }
          }
        );
      }

      return actions;
    },

    async filter(query) {
      const q = (query || '').trim().toLowerCase();
      const resultsContainer = document.getElementById('cmdResultsList');
      if (!resultsContainer) return;

      const staticActions = this.getStaticActions();
      let matchedItems = [];

      if (!q) {
        matchedItems = staticActions;
      } else {
        // Filter static actions
        matchedItems = staticActions.filter(a => a.title.toLowerCase().includes(q) || a.section.toLowerCase().includes(q));

        // Filter live master items from DataService
        let catalogItems = (window.UI && window.UI.catalogData) || [];
        if (catalogItems.length === 0 && window.DataService && typeof window.DataService.getMasterItems === 'function') {
          if (!this._cachedMasterItems) {
            try {
              this._cachedMasterItems = await window.DataService.getMasterItems();
            } catch (err) {}
          }
          catalogItems = this._cachedMasterItems || [];
        }

        const matchedCatalog = [];
        for (let i = 0; i < catalogItems.length; i++) {
          const it = catalogItems[i];
          const skuMatch = (it.sku || '').toLowerCase().includes(q);
          const nameMatch = (it.productName || it.itemDescription || '').toLowerCase().includes(q);
          const catMatch = (it.category || '').toLowerCase().includes(q);
          const specMatch = (it.specification || '').toLowerCase().includes(q);

          if (skuMatch || nameMatch || catMatch || specMatch) {
            matchedCatalog.push({
              id: `sku-${it.sku}`,
              section: 'Master Catalog Items',
              sku: it.sku,
              title: it.productName || it.itemDescription || it.sku,
              badge: it.category || 'Catalog Item',
              icon: 'package',
              action: () => {
                if (window.UI && window.UI.openSpecsModal) {
                  window.UI.openSpecsModal(it.sku);
                }
              }
            });
            if (matchedCatalog.length >= 8) break;
          }
        }
        matchedItems = matchedItems.concat(matchedCatalog);

        // Filter PRs if available
        let prList = (window.UI && window.UI.prs) || [];
        if (prList.length === 0 && window.DataService && typeof window.DataService.getPurchaseRequests === 'function') {
          if (!this._cachedPrs) {
            try {
              this._cachedPrs = await window.DataService.getPurchaseRequests();
            } catch (err) {}
          }
          prList = this._cachedPrs || [];
        }

        const matchedPrs = [];
        for (let j = 0; j < prList.length; j++) {
          const pr = prList[j];
          const prNum = pr.pr_number || pr.prNumber || '';
          const projName = pr.project_name || pr.projectName || '';
          const prNumMatch = prNum.toLowerCase().includes(q);
          const projMatch = projName.toLowerCase().includes(q);
          if (prNumMatch || projMatch) {
            matchedPrs.push({
              id: `pr-${pr.id}`,
              section: 'Purchase Requests',
              sku: prNum,
              title: `PR ${prNum} (${projName || 'General'})`,
              badge: pr.status || 'PR',
              icon: 'file-text',
              action: () => {
                if (window.UI && window.UI.openPrVoucherModal) {
                  window.UI.openPrVoucherModal(pr.id);
                }
              }
            });
            if (matchedPrs.length >= 4) break;
          }
        }
        matchedItems = matchedItems.concat(matchedPrs);
      }

      this.items = matchedItems;
      this.selectedIndex = 0;
      this.render();
    },

    render() {
      const container = document.getElementById('cmdResultsList');
      if (!container) return;

      if (this.items.length === 0) {
        container.innerHTML = `
          <div style="padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); font-size: var(--text-sm);">
            No actions, SKUs or purchase requests found matching your query.
          </div>
        `;
        return;
      }

      // Group items by section
      const sections = {};
      this.items.forEach((item, idx) => {
        const sec = item.section || 'General';
        if (!sections[sec]) sections[sec] = [];
        sections[sec].push({ item, idx });
      });

      let html = '';
      for (const [secName, group] of Object.entries(sections)) {
        html += `<div class="cmd-section-title">${escapeHtml(secName)}</div>`;
        group.forEach(({ item, idx }) => {
          const isSelected = idx === this.selectedIndex;
          html += `
            <div class="cmd-item ${isSelected ? 'selected' : ''}" data-cmd-idx="${idx}">
              <i data-lucide="${item.icon || 'arrow-right'}"></i>
              ${item.sku ? `<span class="cmd-item-sku">${escapeHtml(item.sku)}</span>` : ''}
              <span class="cmd-item-title">${escapeHtml(item.title)}</span>
              ${item.badge ? `<span class="cmd-item-badge">${escapeHtml(item.badge)}</span>` : ''}
            </div>
          `;
        });
      }

      container.innerHTML = html;

      // Bind click handlers
      container.querySelectorAll('.cmd-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.getAttribute('data-cmd-idx'), 10);
          this.executeIndex(idx);
        });
      });

      // Refresh lucide icons in palette
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons({ root: container });
      }
    },

    selectNext() {
      if (this.items.length === 0) return;
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
      this.updateSelection();
    },

    selectPrev() {
      if (this.items.length === 0) return;
      this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
      this.updateSelection();
    },

    updateSelection() {
      const container = document.getElementById('cmdResultsList');
      if (!container) return;
      const items = container.querySelectorAll('.cmd-item');
      items.forEach((el, idx) => {
        if (idx === this.selectedIndex) {
          el.classList.add('selected');
          el.scrollIntoView({ block: 'nearest' });
        } else {
          el.classList.remove('selected');
        }
      });
    },

    executeSelected() {
      this.executeIndex(this.selectedIndex);
    },

    executeIndex(idx) {
      if (idx >= 0 && idx < this.items.length) {
        const item = this.items[idx];
        this.close();
        if (typeof item.action === 'function') {
          item.action();
        }
      }
    }
  };

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // -------------------------------------------------------------------------
  // 5. INITIALIZE SHELL CONTROLLERS
  // -------------------------------------------------------------------------
  window.ThemeManager = ThemeManager;
  window.SidebarManager = SidebarManager;
  window.BreadcrumbManager = BreadcrumbManager;
  window.CommandPalette = CommandPalette;

  function initShell() {
    ThemeManager.init();
    SidebarManager.init();
    CommandPalette.init();

    // Platform-specific keyboard shortcut hint (Mac: ⌘K, Windows/Other: Ctrl K)
    const isMac = /(Mac|iPhone|iPod|iPad)/i.test(
      (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
    );
    const shortcutLabel = isMac ? '⌘K' : 'Ctrl K';
    const searchKbd = document.getElementById('searchKbdShortcut');
    if (searchKbd) {
      searchKbd.textContent = shortcutLabel;
    }
    const topbarSearchBar = document.querySelector('.topbar-search-bar');
    if (topbarSearchBar) {
      topbarSearchBar.setAttribute('title', `Open Command Palette (${shortcutLabel})`);
    }

    // Initialize Lucide Icons
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }

    if (window.UI) {
      // Intercept showMainApp to refresh icons & adjust role items
      const origShowMainApp = window.UI.showMainApp;
      if (origShowMainApp) {
        window.UI.showMainApp = function (user) {
          const result = origShowMainApp.apply(this, arguments);
          const adminLabel = document.getElementById('sidebarAdminLabel');
          if (adminLabel) {
            adminLabel.style.display = (user && user.role === 'ADMIN') ? '' : 'none';
          }
          if (BreadcrumbManager) {
            BreadcrumbManager.updateFromView(window.UI.currentTab || 'dashboard');
          }
          if (window.lucide && typeof window.lucide.createIcons === 'function') {
            setTimeout(() => window.lucide.createIcons(), 50);
          }
          return result;
        };
      }

      // Intercept switchView to update Breadcrumb, active states and refresh Lucide icons
      const origSwitchView = window.UI.switchView;
      window.UI.switchView = function (viewName) {
        const result = origSwitchView.apply(this, arguments);
        if (BreadcrumbManager) {
          BreadcrumbManager.updateFromView(viewName);
        }
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
          setTimeout(() => window.lucide.createIcons(), 50);
        }
        // Close mobile drawer on navigation
        if (SidebarManager) {
          SidebarManager.closeMobileDrawer();
        }
        return result;
      };

      const origOpenCategory = window.UI.openCategory;
      if (origOpenCategory) {
        window.UI.openCategory = function (categoryName) {
          const result = origOpenCategory.apply(this, arguments);
          if (BreadcrumbManager) {
            BreadcrumbManager.set('Item Catalogue', categoryName);
          }
          if (window.lucide && typeof window.lucide.createIcons === 'function') {
            setTimeout(() => window.lucide.createIcons(), 50);
          }
          return result;
        };
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShell);
  } else {
    initShell();
  }

})();
