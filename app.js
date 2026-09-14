/**
 * Enterprise SKU & Purchase Request Automation Engine
 * Single Source of Truth: Master Item Catalog
 * Proof-of-Concept for RAW MATERIALS (50 Verified Items: FF4186 - FF4235)
 */

(function () {
  'use strict';

  // =========================================================================
  // GLOBAL PRICING REQUIREMENT SWITCH
  // Set to true to enforce Current Unit Price (IDR) as strictly compulsory.
  // Set to false to make Current Unit Price (IDR) optional for now.
  // =========================================================================
  const REQUIRE_UNIT_PRICE = false;
  window.REQUIRE_UNIT_PRICE = REQUIRE_UNIT_PRICE;

  // =========================================================================
  // 1. DATA SERVICE - ABSTRACTED STORAGE LAYER
  // Ready for local storage or seamless Google Sheets + Apps Script integration
  // =========================================================================
  const STORAGE_KEYS = {
    MASTER_ITEMS: 'sku_auto_master_items_v1',
    PURCHASE_REQUESTS: 'sku_auto_purchase_requests_v1',
    SKU_CONFIG: 'sku_auto_config_v1',
    INITIALIZED: 'sku_auto_initialized_v1'
  };

  const DEFAULT_CONFIG = {
    skuPrefix: 'FF',
    skuNextNumber: 4236,
    skuAutoGenerate: true,
    storageDriver: 'localStorage', // 'localStorage' | 'googleAppsScript'
    googleAppsScriptUrl: ''
  };

  const DataService = {
    config: null,

    async init() {
      const savedConfig = localStorage.getItem(STORAGE_KEYS.SKU_CONFIG);
      this.config = savedConfig ? JSON.parse(savedConfig) : { ...DEFAULT_CONFIG };

      // Check if master items are initialized in localStorage as safe offline cache
      const existingItems = localStorage.getItem(STORAGE_KEYS.MASTER_ITEMS);
      if (!existingItems) {
        await this.loadInitialMasterData();
      }

      // Try fetching fresh master items from backend
      try {
        await this.getMasterItems();
      } catch (e) {}
    },

    async loadInitialMasterData() {
      try {
        const response = await fetch('raw_materials_master.json');
        if (response.ok) {
          const rawItems = await response.json();
          const items = (rawItems || []).map(it => ({
            ...it,
            status: it.status || 'Available',
            remarks: (it.remarks !== undefined && it.remarks !== null) ? it.remarks : ''
          }));
          localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
          localStorage.setItem(STORAGE_KEYS.INITIALIZED, 'true');
          return items;
        }
      } catch (err) {
        console.error('[DataService] Failed to load raw_materials_master.json', err);
      }
      return [];
    },

    async resetToDefault50() {
      localStorage.removeItem(STORAGE_KEYS.MASTER_ITEMS);
      localStorage.removeItem(STORAGE_KEYS.PURCHASE_REQUESTS);
      await this.loadInitialMasterData();
      this.config.skuNextNumber = 4236;
      this.saveConfig(this.config);
    },

    saveConfig(cfg) {
      this.config = { ...this.config, ...cfg };
      localStorage.setItem(STORAGE_KEYS.SKU_CONFIG, JSON.stringify(this.config));
    },

    getConfig() {
      return { ...this.config };
    },

    // Master Items API
    async getMasterItems() {
      const token = window.AuthService && typeof window.AuthService.getToken === 'function'
        ? window.AuthService.getToken()
        : '';

      if (!token) {
        if (window.AuthService && typeof window.AuthService.logout === 'function') {
          window.AuthService.logout();
        }
        if (window.UI && typeof window.UI.showLoginView === 'function') {
          window.UI.showLoginView();
        }
        const err = new Error('Authentication required. Please log in.');
        err.authRequired = true;
        throw err;
      }

      try {
        const resp = await fetch('/api/master-items', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (resp.status === 401 || resp.status === 403) {
          if (window.AuthService && typeof window.AuthService.logout === 'function') {
            window.AuthService.logout();
          }
          if (window.UI && typeof window.UI.showLoginView === 'function') {
            window.UI.showLoginView();
          }
          const err = new Error('Session expired. Please log in again.');
          err.authRequired = true;
          throw err;
        }

        if (!resp.ok) {
          if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(true);
          throw new Error(`Database connection unavailable (HTTP ${resp.status}). Please contact the administrator.`);
        }

        const data = await resp.json();
        const rawItems = Array.isArray(data) ? data : (data.items || []);
        const items = rawItems.map(it => ({
          ...it,
          status: it.status || 'Available',
          remarks: (it.remarks !== undefined && it.remarks !== null) ? it.remarks : ''
        }));
        console.log('[10. Catalog UI DataService]', { totalFetched: items.length });
        localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
        let maxSeq = 4235;
        items.forEach(it => {
          if (it.sku) {
            const m = String(it.sku).match(/^FF(\d+)$/i);
            if (m) {
              const n = parseInt(m[1], 10);
              if (n > maxSeq) maxSeq = n;
            }
          }
        });
        if (this.config) {
          this.config.skuNextNumber = maxSeq + 1;
          this.saveConfig(this.config);
        }
        if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(false);
        return items;
      } catch (e) {
        if (e && e.authRequired) throw e;
        console.warn('[DataService] Master items fetch from backend failed:', e);
        if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(true);
        throw e;
      }
    },

    async getMasterItemBySku(sku) {
      const items = await this.getMasterItems();
      return items.find(i => i.sku.toUpperCase() === sku.toUpperCase()) || null;
    },

    getItemDescription(item) {
      if (!item) return '';
      if (item.itemDescription && item.itemDescription.trim()) return item.itemDescription.trim();
      if (item.description && item.description.trim()) return item.description.trim();
      const lines = [
        item.productName || '',
        item.material ? `Material / Grade: ${item.material}` : '',
        item.size ? `Dimensions: ${item.size}` : '',
        item.specification ? `Specification: ${item.specification}` : (item.sourceSheet ? `Standard: ${item.sourceSheet}` : 'Standard: PT Persada Nusantara Steel Standard'),
        item.weightKg ? `Theoretical Weight: ${item.weightKg} kg / ${item.unit || 'unit'}` : '',
        item.brand ? `Manufacturer / Mill: ${item.brand}` : ''
      ].filter(Boolean);
      return lines.join('\n');
    },

    async updateMasterItemDescription(sku, newDescription) {
      if (!sku) return null;
      if (window.PermissionService && !window.PermissionService.can('CAN_EDIT_ITEM_DESCRIPTION')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required.');
        throw new Error('Access Denied — Administrator permission required.');
      }

      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (token) {
        try {
          const resp = await fetch(`/api/master-items/${sku}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ itemDescription: newDescription })
          });
          if (resp.ok) {
            const updated = await resp.json();
            const items = await this.getMasterItems();
            const found = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
            if (found) {
              found.itemDescription = newDescription;
              localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
            }
            return updated;
          }
        } catch (e) {
          console.warn('[DataService] Backend update description failed:', e);
        }
      }

      const items = await this.getMasterItems();
      const item = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
      if (item) {
        item.itemDescription = newDescription;
        localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
        return item;
      }
      return null;
    },

    async updateMasterItemPrice(sku, unitPrice) {
      if (!sku) return null;
      if (window.PermissionService && !window.PermissionService.can('CAN_EDIT_PRICE')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required.');
        throw new Error('Access Denied — Administrator permission required.');
      }

      let priceNum = null;
      if (unitPrice === '' || unitPrice === null || unitPrice === undefined) {
        if (REQUIRE_UNIT_PRICE) {
          throw new Error('Current Unit Price (IDR) is required.');
        }
        priceNum = null;
      } else {
        const p = Number(unitPrice);
        if (isNaN(p) || !isFinite(p) || p < 0) {
          throw new Error('Current Unit Price (IDR) must be a valid positive number.');
        }
        priceNum = p;
      }

      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (token) {
        try {
          const resp = await fetch(`/api/master-items/${sku}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ unitPrice: priceNum })
          });
          if (resp.ok) {
            const updated = await resp.json();
            const items = await this.getMasterItems();
            const found = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
            if (found) {
              found.unitPrice = priceNum;
              localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
            }
            return updated;
          } else {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to update price');
          }
        } catch (e) {
          console.warn('[DataService] Backend update price failed:', e);
          throw e;
        }
      }

      const items = await this.getMasterItems();
      const item = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
      if (item) {
        item.unitPrice = priceNum;
        localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
        return item;
      }
      return null;
    },

    async updateMasterItemStatus(sku, status) {
      if (!sku) return null;
      if (window.PermissionService && !window.PermissionService.can('CAN_EDIT_STATUS') && !window.PermissionService.can('CAN_EDIT_MASTER_ITEM')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required.');
        throw new Error('Access Denied — Administrator permission required.');
      }

      const validStatuses = ['Available', 'Out of Stock'];
      const cleanStatus = validStatuses.find(s => s.toLowerCase() === String(status).trim().toLowerCase()) || 'Available';

      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (token) {
        try {
          const resp = await fetch(`/api/master-items/${encodeURIComponent(sku)}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ status: cleanStatus })
          });
          if (resp.ok) {
            const updated = await resp.json();
            const items = await this.getMasterItems();
            const found = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
            if (found) {
              found.status = cleanStatus;
              localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
            }
            return updated;
          }
        } catch (e) {
          console.warn('[DataService] Backend update status failed:', e);
        }
      }

      const items = await this.getMasterItems();
      const item = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
      if (item) {
        item.status = cleanStatus;
        localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
        return item;
      }
      return null;
    },

    async updateMasterItemSupplyType(sku, supplyType) {
      if (!sku) return null;
      if (window.PermissionService && !window.PermissionService.can('CAN_EDIT_ITEM_DESCRIPTION') && !window.PermissionService.can('CAN_EDIT_MASTER_ITEM')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required.');
        throw new Error('Access Denied — Administrator permission required.');
      }

      const validSupplyTypes = ['Full Size', 'Cut Size'];
      const cleanSupplyType = validSupplyTypes.find(s => s.toLowerCase() === String(supplyType).trim().toLowerCase()) || 'Full Size';

      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (token) {
        try {
          const resp = await fetch(`/api/master-items/${encodeURIComponent(sku)}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ supplyType: cleanSupplyType })
          });
          if (resp.ok) {
            const updated = await resp.json();
            const items = await this.getMasterItems();
            const found = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
            if (found) {
              found.supplyType = cleanSupplyType;
              localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
            }
            return updated;
          }
        } catch (e) {
          console.warn('[DataService] Backend update supply type failed:', e);
        }
      }

      const items = await this.getMasterItems();
      const item = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
      if (item) {
        item.supplyType = cleanSupplyType;
        localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
        return item;
      }
      return null;
    },

    async updateMasterItemRemarks(sku, remarks) {
      if (!sku) return null;
      if (window.PermissionService && !window.PermissionService.can('CAN_EDIT_REMARKS') && !window.PermissionService.can('CAN_EDIT_MASTER_ITEM')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required.');
        throw new Error('Access Denied — Administrator permission required.');
      }

      const cleanRemarks = remarks !== undefined && remarks !== null ? String(remarks).trim() : '';

      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (token) {
        try {
          const resp = await fetch(`/api/master-items/${encodeURIComponent(sku)}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ remarks: cleanRemarks })
          });
          if (resp.ok) {
            const updated = await resp.json();
            const items = await this.getMasterItems();
            const found = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
            if (found) {
              found.remarks = cleanRemarks;
              localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
            }
            return updated;
          }
        } catch (e) {
          console.warn('[DataService] Backend update remarks failed:', e);
        }
      }

      const items = await this.getMasterItems();
      const item = items.find(i => i.sku.toUpperCase() === sku.toUpperCase());
      if (item) {
        item.remarks = cleanRemarks;
        localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
        return item;
      }
      return null;
    },

    async deleteMasterItem(sku) {
      if (!sku) return false;
      if (window.PermissionService && !window.PermissionService.can('CAN_DELETE_MASTER_ITEM')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required.');
        throw new Error('Access Denied — Administrator permission required.');
      }
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (token) {
        try {
          const resp = await fetch(`/api/master-items/${encodeURIComponent(sku)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to delete master item');
          }
        } catch (e) {
          console.warn('[DataService] Backend delete failed:', e);
          throw e;
        }
      }
      const items = await this.getMasterItems();
      const filtered = items.filter(i => i.sku.toUpperCase() !== sku.toUpperCase());
      localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(filtered));
      return true;
    },

    formatUnitPrice(unitPrice, unit) {
      if (unitPrice !== undefined && unitPrice !== null && unitPrice !== '' && !isNaN(Number(unitPrice)) && Number(unitPrice) >= 0) {
        return `IDR ${Number(unitPrice).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} / ${unit || 'Unit'}`;
      }
      return '—';
    },

    async checkDuplicate(sku, productName, size) {
      const items = await this.getMasterItems();
      const skuMatch = items.find(i => i.sku.toUpperCase().trim() === sku.toUpperCase().trim());
      const nameMatch = items.find(i => 
        i.productName.toLowerCase().trim() === productName.toLowerCase().trim() ||
        (i.size && size && i.size.toLowerCase().trim() === size.toLowerCase().trim() && i.subCategory === (arguments[3] || ''))
      );

      return {
        isDuplicateSku: !!skuMatch,
        duplicateSkuItem: skuMatch || null,
        isPotentialDuplicate: !!nameMatch && !skuMatch,
        potentialDuplicateItem: nameMatch || null
      };
    },

    async addMasterItem(newItem) {
      if (window.PermissionService && !window.PermissionService.can('CAN_CREATE_SKU')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required.');
        throw new Error('Access Denied — Administrator permission required.');
      }

      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (token) {
        try {
          const resp = await fetch('/api/master-items', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(newItem)
          });
          const data = await resp.json();
          if (!resp.ok) {
            throw new Error(data.error || 'Failed to add master item');
          }
          await this.getMasterItems();
          return data;
        } catch (e) {
          if (e.message && e.message.includes('already exists')) throw e;
          console.warn('[DataService] Backend add item error:', e);
        }
      }

      const items = await this.getMasterItems();
      const existing = items.find(i => i.sku.toUpperCase() === newItem.sku.toUpperCase());
      if (existing) {
        throw new Error(`Duplicate SKU Error: ${newItem.sku} already exists in Master Items.`);
      }

      newItem.status = newItem.status || 'Available';
      newItem.remarks = (newItem.remarks !== undefined && newItem.remarks !== null) ? newItem.remarks : '';
      newItem.createdAt = new Date().toISOString();
      items.unshift(newItem);
      localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));

      const match = newItem.sku.match(/^([A-Za-z]+)(\d+)$/);
      if (match) {
        const num = parseInt(match[2], 10);
        if (num >= this.config.skuNextNumber) {
          this.config.skuNextNumber = num + 1;
          this.saveConfig(this.config);
        }
      }

      return newItem;
    },

    getNextSuggestedSKU() {
      return `${this.config.skuPrefix}${this.config.skuNextNumber}`;
    },

    // Projects API
    async getProjects() {
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (!token) return [];
      try {
        const resp = await fetch('/api/projects', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (resp.ok) {
          if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(false);
          return await resp.json();
        }
      } catch (e) {
        console.warn('[DataService] Projects fetch error:', e);
        if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(true);
      }
      return [];
    },

    async createProject(data) {
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (!token) throw new Error('Authentication required.');
      try {
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(data)
        });
        const resData = await resp.json();
        if (!resp.ok) {
          throw new Error(resData.error || 'Failed to create project');
        }
        return resData;
      } catch (e) {
        throw e;
      }
    },

    async getProjectDetails(id) {
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (!token) throw new Error('Authentication required.');
      const resp = await fetch(`/api/projects/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to fetch project details');
      return data;
    },

    // Purchase Requests API
    async getPurchaseRequests() {
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (token) {
        try {
          const resp = await fetch('/api/purchase-requests', {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (resp.ok) {
            const data = await resp.json();
            if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(false);
            return data;
          }
        } catch (e) {
          console.warn('[DataService] PRs backend fetch error:', e);
          if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(true);
        }
      }

      const raw = localStorage.getItem(STORAGE_KEYS.PURCHASE_REQUESTS);
      return raw ? JSON.parse(raw) : [];
    },

    async getPurchaseRequestDetails(id) {
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (!token) throw new Error('Authentication required.');
      const resp = await fetch(`/api/purchase-requests/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to fetch PR details');
      return data;
    },

    async createPurchaseRequest(prPayload) {
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (!token) {
        throw new Error('Authentication required.');
      }

      // Requirement 2: Do NOT silently fall back to LocalStorage when PostgreSQL/API is unavailable.
      // If PostgreSQL/API is unavailable: SHOW: "Database connection unavailable. Please contact the administrator."
      // Do NOT submit or silently save a new PR locally.
      try {
        const resp = await fetch('/api/purchase-requests', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(prPayload)
        });

        const data = await resp.json();
        if (!resp.ok) {
          if (resp.status === 500 || resp.status === 503) {
            if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(true);
            throw new Error('Database connection unavailable. Please contact the administrator.');
          }
          throw new Error(data.error || 'Failed to create Purchase Request.');
        }

        if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(false);
        return data;

      } catch (err) {
        if (window.UI && window.UI.showDbUnavailableBanner) window.UI.showDbUnavailableBanner(true);
        throw new Error('Database connection unavailable. Please contact the administrator.');
      }
    },

    async approvePurchaseRequest(id) {
      if (window.PermissionService && !window.PermissionService.can('CAN_APPROVE_PR')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required to approve PRs.');
        throw new Error('Access Denied — Administrator permission required to approve PRs.');
      }
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (!token) throw new Error('Authentication required.');
      const resp = await fetch(`/api/purchase-requests/${id}/approve`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to approve PR');
      return data;
    },

    async rejectPurchaseRequest(id, rejectionReason) {
      if (window.PermissionService && !window.PermissionService.can('CAN_REJECT_PR')) {
        window.PermissionService.notifyAccessDenied('Access Denied — Administrator permission required to reject PRs.');
        throw new Error('Access Denied — Administrator permission required to reject PRs.');
      }
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (!token) throw new Error('Authentication required.');
      const resp = await fetch(`/api/purchase-requests/${id}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ rejectionReason })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to reject PR');
      return data;
    }
  };

  // =========================================================================
  // 1.5. PR CART CONTROLLER - MULTI-MATERIAL REQUISITION MANAGEMENT
  // =========================================================================
  const PRCart = {
    items: [],

    init() {
      this.load();
      this.bindEvents();
    },

    load() {
      try {
        const raw = sessionStorage.getItem('flowforce_pr_cart');
        this.items = raw ? JSON.parse(raw) : [];
      } catch (e) {
        this.items = [];
      }
      this.updateBadge();
    },

    save() {
      sessionStorage.setItem('flowforce_pr_cart', JSON.stringify(this.items));
    },

    updateBadge() {
      const badge = document.getElementById('headerCartBadge');
      if (badge) {
        badge.textContent = this.items.length;
      }
    },

    addItem(masterItem, options = {}) {
      if (window.PermissionService && !window.PermissionService.can('CAN_CREATE_PR')) {
        if (window.UI && window.UI.showAccessDeniedModal) {
          window.UI.showAccessDeniedModal('Access Denied — PR creation permission required.');
        } else {
          alert('Access Denied — PR creation permission required.');
        }
        return;
      }
      const supplyType = (options.supplyType === 'Cut Size') ? 'Cut Size' : 'Full Size';
      const origDim = options.originalDimensions || masterItem.size || masterItem.sizeDimensions || '—';
      const cutLength = (supplyType === 'Cut Size') ? String(options.cutLength || '').trim() : '';
      const cutWidth = (supplyType === 'Cut Size') ? String(options.cutWidth || '').trim() : '';
      const isCut = (supplyType === 'Cut Size');
      const reqCutSize = isCut ? (cutWidth ? `${cutLength} × ${cutWidth} mm` : `${cutLength} mm`) : '';

      const existing = this.items.find(i =>
        i.sku.toUpperCase() === masterItem.sku.toUpperCase() &&
        (i.supplyType || 'Full Size') === supplyType &&
        String(i.cutLength || '') === cutLength &&
        String(i.cutWidth || '') === cutWidth
      );

      if (existing) {
        existing.quantity = (parseFloat(existing.quantity) || 1) + 1;
      } else {
        const desc = masterItem.itemDescription || DataService.getItemDescription(masterItem);
        this.items.push({
          masterItemId: masterItem.id || null,
          sku: masterItem.sku,
          productName: masterItem.productName,
          itemDescription: desc,
          materialGrade: masterItem.material || masterItem.materialGrade || '',
          sizeDimensions: origDim,
          originalDimensions: origDim,
          specification: masterItem.specification || masterItem.sourceSheet || 'PT Persada Nusantara Steel Standard',
          unit: masterItem.unit || 'Sheet',
          quantity: 1,
          weightKg: masterItem.weightKg || null,
          unitPrice: (masterItem.unitPrice !== undefined && masterItem.unitPrice !== null && masterItem.unitPrice !== '') ? parseFloat(masterItem.unitPrice) : null,
          status: (masterItem.status === 'Out of Stock') ? 'Out of Stock' : 'Available',
          supplyType: supplyType,
          cutLength: cutLength,
          cutWidth: cutWidth,
          purchaseType: isCut ? 'PROJECT-SPECIFIC CUT SIZE' : 'STANDARD STOCK ITEM',
          requiredCutSize: reqCutSize
        });
      }
      this.save();
      this.updateBadge();
      UI.showToast('Added to Cart', `${masterItem.sku} (${masterItem.productName || masterItem.sku}) [${supplyType}] added to PR Cart.`);
    },

    updateQuantity(idx, newQty) {
      if (this.items[idx]) {
        const q = parseFloat(newQty);
        if (!isNaN(q) && q > 0) {
          this.items[idx].quantity = q;
          this.save();
          this.renderCartTable();
          this.updateSummary();
        }
      }
    },

    removeItem(idx) {
      if (this.items[idx]) {
        const removed = this.items[idx];
        this.items.splice(idx, 1);
        this.save();
        this.updateBadge();
        this.renderCartTable();
        this.updateSummary();
        UI.showToast('Item Removed', `Removed ${removed.sku} from cart.`);
      }
    },

    clear() {
      this.items = [];
      this.save();
      this.updateBadge();
      this.renderCartTable();
      this.updateSummary();
    },

    getTotalItems() {
      return this.items.reduce((sum, it) => sum + (parseFloat(it.quantity) || 1), 0);
    },

    getGrandTotalCost() {
      let allHavePrice = true;
      const total = this.items.reduce((sum, it) => {
        const p = (it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== '') ? parseFloat(it.unitPrice) : null;
        if (p !== null && !isNaN(p) && p >= 0) {
          return sum + (p * (parseFloat(it.quantity) || 1));
        } else {
          allHavePrice = false;
          return sum;
        }
      }, 0);
      return (allHavePrice && this.items.length > 0) ? total : null;
    },

    async open() {
      const modal = document.getElementById('modalPrCart');
      if (!modal) return;

      // Populate projects dropdown
      await this.populateProjectDropdown();

      // Set default Required Date (1 week from today)
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const dateInput = document.getElementById('cartRequiredDate');
      if (dateInput && !dateInput.value) {
        dateInput.value = nextWeek.toISOString().split('T')[0];
        dateInput.min = new Date().toISOString().split('T')[0];
      }

      this.renderCartTable();
      this.updateSummary();
      modal.classList.add('active');
    },

    async populateProjectDropdown() {
      const select = document.getElementById('cartProjectSelect');
      if (!select) return;

      const previousVal = select.value;
      select.innerHTML = '<option value="">-- Select Project / PID --</option>';

      try {
        const projects = await DataService.getProjects();
        projects.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.projectCode} — ${p.projectName} (${p.jobLocation})`;
          opt.setAttribute('data-name', p.projectName);
          opt.setAttribute('data-location', p.jobLocation);
          select.appendChild(opt);
        });

        if (previousVal) {
          select.value = previousVal;
          this.handleProjectChange();
        }
      } catch (e) {
        console.warn('Failed to populate projects in cart:', e);
      }
    },

    handleProjectChange() {
      const select = document.getElementById('cartProjectSelect');
      const nameInput = document.getElementById('cartProjectName');
      const locInput = document.getElementById('cartJobLocation');
      if (!select || !nameInput || !locInput) return;

      const selectedOpt = select.options[select.selectedIndex];
      if (selectedOpt && selectedOpt.value) {
        nameInput.value = selectedOpt.getAttribute('data-name') || '';
        locInput.value = selectedOpt.getAttribute('data-location') || '';
      } else {
        nameInput.value = '';
        locInput.value = '';
      }
    },

    renderCartTable() {
      const emptyState = document.getElementById('cartEmptyState');
      const activeContent = document.getElementById('cartActiveContent');
      const tbody = document.getElementById('cartTableTbody');
      const countDisplay = document.getElementById('cartItemCountDisplay');

      if (countDisplay) countDisplay.textContent = this.items.length;

      if (this.items.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        if (activeContent) activeContent.style.display = 'none';
        return;
      }

      if (emptyState) emptyState.style.display = 'none';
      if (activeContent) activeContent.style.display = 'block';

      if (!tbody) return;

      tbody.innerHTML = this.items.map((item, idx) => {
        const p = (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '') ? parseFloat(item.unitPrice) : null;
        const hasValidPrice = p !== null && !isNaN(p) && p >= 0;
        const total = hasValidPrice ? (p * item.quantity) : null;
        const formattedPrice = hasValidPrice
          ? `IDR ${Number(p).toLocaleString('id-ID')} / ${escapeHtml(item.unit || 'Unit')}`
          : (REQUIRE_UNIT_PRICE
              ? '<span style="color:#e11d48; font-weight:700; font-size:0.8rem;">⚠️ Price Required</span>'
              : '—');
        const formattedTotal = (hasValidPrice && total !== null)
          ? `IDR ${Number(total).toLocaleString('id-ID')}`
          : (REQUIRE_UNIT_PRICE
              ? '<span style="color:#e11d48; font-weight:600; font-size:0.8rem;">Missing Price</span>'
              : '—');

        const isCut = (item.supplyType === 'Cut Size');
        const itemStatus = (item.status === 'Out of Stock') ? 'Out of Stock' : 'Available';
        const statusClass = itemStatus.toLowerCase().replace(/[\s_]+/g, '-');
        const origDimDisplay = item.originalDimensions || item.sizeDimensions || item.size || '—';

        return `
          <tr data-cart-idx="${idx}" data-sku="${escapeHtml(item.sku)}">
            <td style="color:var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
            <td><span class="sku-badge">${escapeHtml(item.sku)}</span></td>
            <td>
              <div style="font-weight:600; color:var(--text-main);">${escapeHtml(item.productName || '—')}</div>
              <div style="font-size:0.75rem; color:var(--text-muted); white-space:pre-wrap; max-width:240px;">${escapeHtml(item.itemDescription || '')}</div>
            </td>
            <td>${escapeHtml(item.materialGrade || '-')}</td>
            <td style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-main);">${escapeHtml(origDimDisplay)}</td>
            <td><span class="unit-badge">${escapeHtml(item.unit || 'Sheet')}</span></td>
            <td style="text-align:center;">
              <span class="status-badge ${statusClass}">● ${escapeHtml(itemStatus)}</span>
            </td>
            <td>
              <div class="cart-supply-info">
                <span class="supply-badge ${isCut ? 'cut-size' : 'full-size'}">${isCut ? 'CUT SIZE' : 'FULL SIZE'}</span>
                ${isCut ? `
                  <div class="cart-cut-spec-details" style="font-size:0.74rem; color:var(--text-muted); margin-top:4px; line-height:1.4;">
                    <div>Orig: <span style="font-family:var(--font-mono); color:var(--text-main); font-weight:600;">${escapeHtml(origDimDisplay)}</span></div>
                    <div>Req: <span style="font-family:var(--font-mono); color:#d97706; font-weight:700;">${escapeHtml(item.cutLength)}${item.cutWidth ? ' × ' + escapeHtml(item.cutWidth) : ''} mm</span></div>
                  </div>
                ` : ''}
              </div>
            </td>
            <td style="font-weight:600; font-family:var(--font-mono);">${formattedPrice}</td>
            <td style="text-align:center;">
              <div class="cart-qty-ctrl">
                <button type="button" class="btn-qty-adj btn-cart-minus" data-idx="${idx}">−</button>
                <input type="number" min="1" step="1" class="input-qty-val cart-qty-input" data-idx="${idx}" value="${item.quantity}">
                <button type="button" class="btn-qty-adj btn-cart-plus" data-idx="${idx}">+</button>
              </div>
            </td>
            <td style="text-align:right; font-weight:700; color:#059669; font-family:var(--font-mono);">${formattedTotal}</td>
            <td style="text-align:center;">
              <button type="button" class="btn-user-action btn-disable btn-cart-remove" data-idx="${idx}" title="Remove material">&times;</button>
            </td>
          </tr>
        `;
      }).join('');

      // Bind quantity and remove buttons by index
      tbody.querySelectorAll('.btn-cart-minus').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          if (this.items[idx] && this.items[idx].quantity > 1) {
            this.updateQuantity(idx, this.items[idx].quantity - 1);
          }
        });
      });

      tbody.querySelectorAll('.btn-cart-plus').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          if (this.items[idx]) {
            this.updateQuantity(idx, this.items[idx].quantity + 1);
          }
        });
      });

      tbody.querySelectorAll('.cart-qty-input').forEach(input => {
        input.addEventListener('change', () => {
          const idx = parseInt(input.getAttribute('data-idx'), 10);
          const val = parseFloat(input.value) || 1;
          this.updateQuantity(idx, val);
        });
      });

      tbody.querySelectorAll('.btn-cart-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          this.removeItem(idx);
        });
      });
    },

    updateSummary() {
      const totalCountEl = document.getElementById('cartTotalItemsCount');
      const grandCostEl = document.getElementById('cartGrandTotalCost');
      if (totalCountEl) totalCountEl.textContent = this.getTotalItems();
      if (grandCostEl) {
        const total = this.getGrandTotalCost();
        grandCostEl.textContent = (total !== null && total > 0) ? `IDR ${Number(total).toLocaleString('id-ID')}` : '—';
      }
    },

    bindEvents() {
      // Header Cart Button
      const btnCart = document.getElementById('btnHeaderCart');
      if (btnCart && !btnCart._bound) {
        btnCart._bound = true;
        btnCart.addEventListener('click', () => {
          this.open();
        });
      }

      // Clear Cart Button
      const btnClear = document.getElementById('btnClearCart');
      if (btnClear && !btnClear._bound) {
        btnClear._bound = true;
        btnClear.addEventListener('click', () => {
          if (this.items.length === 0) return;
          if (confirm('Clear all materials from the PR Cart?')) {
            this.clear();
          }
        });
      }

      // Project Select Change
      const projSelect = document.getElementById('cartProjectSelect');
      if (projSelect && !projSelect._bound) {
        projSelect._bound = true;
        projSelect.addEventListener('change', () => {
          this.handleProjectChange();
        });
      }

      // Add New Project Link
      const btnAddNewProj = document.getElementById('btnCartAddNewProject');
      if (btnAddNewProj && !btnAddNewProj._bound) {
        btnAddNewProj._bound = true;
        btnAddNewProj.addEventListener('click', () => {
          ProjectLibrary.openNewProjectModal();
        });
      }

      // Purchase Type Radio Toggle
      const radioStandard = document.getElementById('cartTypeStandard');
      const radioCutSize = document.getElementById('cartTypeCutSize');
      const cutSizeGroup = document.getElementById('cartCutSizeGroup');
      const cutSizeInput = document.getElementById('cartRequiredCutSize');

      const toggleCutSize = () => {
        if (radioCutSize && radioCutSize.checked) {
          if (cutSizeGroup) cutSizeGroup.style.display = 'block';
          if (cutSizeInput) cutSizeInput.required = true;
        } else {
          if (cutSizeGroup) cutSizeGroup.style.display = 'none';
          if (cutSizeInput) cutSizeInput.required = false;
        }
      };

      if (radioStandard) radioStandard.addEventListener('change', toggleCutSize);
      if (radioCutSize) radioCutSize.addEventListener('change', toggleCutSize);

      // Checkout Form Submit
      const checkoutForm = document.getElementById('formCheckoutPr');
      if (checkoutForm && !checkoutForm._bound) {
        checkoutForm._bound = true;
        checkoutForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          await this.handleSubmitCheckout();
        });
      }
    },

    async handleSubmitCheckout() {
      if (window.PermissionService && !window.PermissionService.can('CAN_CREATE_PR')) {
        if (window.UI && window.UI.showAccessDeniedModal) {
          window.UI.showAccessDeniedModal('Access Denied — PR creation permission required.');
        } else {
          alert('Access Denied — PR creation permission required.');
        }
        return;
      }

      if (this.items.length === 0) {
        alert('Your PR Cart is empty. Please add materials from the catalog first.');
        return;
      }

      // PRICE REQUIREMENT: Controlled by REQUIRE_UNIT_PRICE switch
      for (const it of this.items) {
        if (it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== '') {
          const p = Number(it.unitPrice);
          if (isNaN(p) || !isFinite(p) || p < 0) {
            alert(`Invalid price for: ${it.sku} - ${it.productName || it.sku}`);
            return;
          }
        } else if (REQUIRE_UNIT_PRICE) {
          alert(`Cannot create PR. Current Unit Price is missing for: ${it.sku} - ${it.productName || it.sku}`);
          return;
        }
      }

      const projSelect = document.getElementById('cartProjectSelect');
      const projectId = projSelect ? projSelect.value : '';
      if (!projectId) {
        alert('Please select a Project / PID.');
        projSelect?.focus();
        return;
      }

      const dept = document.getElementById('cartDepartment')?.value || 'Engineering & Design';
      const reqDate = document.getElementById('cartRequiredDate')?.value || '';
      const urgency = document.getElementById('cartUrgency')?.value || 'Standard (1-2 Weeks)';
      const isCutSize = document.getElementById('cartTypeCutSize')?.checked;
      const cutSize = document.getElementById('cartRequiredCutSize')?.value?.trim() || '';
      const reason = document.getElementById('cartReason')?.value?.trim() || '';
      const remarks = document.getElementById('cartRemarks')?.value?.trim() || '';

      if (!reqDate) {
        alert('Please select Required Date.');
        return;
      }
      if (isCutSize && !cutSize) {
        alert('Please enter Required Cut Size (e.g. 1200 mm x 2500 mm).');
        document.getElementById('cartRequiredCutSize')?.focus();
        return;
      }
      if (!reason) {
        alert('Please enter Reason for Purchase.');
        document.getElementById('cartReason')?.focus();
        return;
      }

      const hasAnyCutSize = this.items.some(i => i.supplyType === 'Cut Size' || i.purchaseType === 'PROJECT-SPECIFIC CUT SIZE');
      const prPayload = {
        projectId,
        department: dept,
        requiredDate: reqDate,
        urgency,
        purchaseType: hasAnyCutSize ? 'PROJECT-SPECIFIC CUT SIZE' : (isCutSize ? 'PROJECT-SPECIFIC CUT SIZE' : 'STANDARD STOCK ITEM'),
        requiredCutSize: isCutSize ? cutSize : (hasAnyCutSize ? this.items.filter(i => i.supplyType === 'Cut Size').map(i => `${i.sku}: ${i.cutLength}${i.cutWidth ? ' × ' + i.cutWidth : ''} mm`).join('; ') : null),
        reasonForPurchase: reason,
        remarks,
        cartItems: this.items
      };

      try {
        const result = await DataService.createPurchaseRequest(prPayload);
        this.clear();
        UI.closeModal('modalPrCart');
        UI.showToast('Purchase Request Created', result.message || `Purchase Request ${result.prNumber} created successfully.`);

        // Refresh app state
        await UI.updateDashboardStats();
        await UI.renderPRRegisterTable();

        // Open View PR Details modal for the newly created PR
        if (result.prId) {
          UI.openViewPrDetailsModal(result.prId);
        }

      } catch (err) {
        alert(err.message || 'Error creating Purchase Request');
      }
    }
  };

  // =========================================================================
  // 1.6. PROJECT / JOB DOCUMENT LIBRARY CONTROLLER
  // =========================================================================
  const ProjectLibrary = {
    currentProjectId: null,

    init() {
      this.bindEvents();
    },

    bindEvents() {
      // Search Project Input
      const searchInput = document.getElementById('projectSearchInput');
      if (searchInput && !searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('input', () => {
          this.renderProjects();
        });
      }

      // New Project Button in Library
      const btnNew = document.getElementById('btnOpenNewProject');
      if (btnNew && !btnNew._bound) {
        btnNew._bound = true;
        btnNew.addEventListener('click', () => {
          this.openNewProjectModal();
        });
      }

      // Back to Projects Button
      const btnBack = document.getElementById('btnBackToProjects');
      if (btnBack && !btnBack._bound) {
        btnBack._bound = true;
        btnBack.addEventListener('click', () => {
          this.closeProject();
        });
      }

      // Breadcrumb Navigation
      const bcHome = document.getElementById('bcProjectsHome');
      const bcRoot = document.getElementById('bcProjectsRoot');
      if (bcHome) bcHome.addEventListener('click', () => this.closeProject());
      if (bcRoot) bcRoot.addEventListener('click', () => this.closeProject());

      // New Project Form Submit
      const formNewProj = document.getElementById('formNewProject');
      if (formNewProj && !formNewProj._bound) {
        formNewProj._bound = true;
        formNewProj.addEventListener('submit', async (e) => {
          e.preventDefault();
          await this.handleSaveNewProject();
        });
      }
    },

    async renderProjects() {
      const listContainer = document.getElementById('projectListContainer');
      const detailContainer = document.getElementById('projectDetailContainer');
      const tbody = document.getElementById('projectsTableTbody');
      const countEl = document.getElementById('projectListCount');

      if (listContainer) listContainer.style.display = 'block';
      if (detailContainer) detailContainer.style.display = 'none';

      // Reset Breadcrumbs
      const sep1 = document.getElementById('bcDetailSep1');
      const sep2 = document.getElementById('bcDetailSep2');
      const projItem = document.getElementById('bcDetailProject');
      const locItem = document.getElementById('bcDetailLocation');
      if (sep1) sep1.style.display = 'none';
      if (sep2) sep2.style.display = 'none';
      if (projItem) projItem.style.display = 'none';
      if (locItem) locItem.style.display = 'none';

      try {
        const projects = await DataService.getProjects();
        const searchInput = document.getElementById('projectSearchInput');
        const q = searchInput ? searchInput.value.trim().toLowerCase() : '';

        const filtered = q ? projects.filter(p => 
          (p.projectCode && p.projectCode.toLowerCase().includes(q)) ||
          (p.projectName && p.projectName.toLowerCase().includes(q)) ||
          (p.jobLocation && p.jobLocation.toLowerCase().includes(q))
        ) : projects;

        if (countEl) countEl.innerHTML = `Showing <strong>${filtered.length}</strong> of <strong>${projects.length}</strong> Projects / Job Locations`;

        if (!tbody) return;

        if (filtered.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="7" style="text-align:center; padding: 3rem 1rem; color: var(--text-muted);">
                <div style="font-size: 2.2rem; margin-bottom: 0.5rem;">📁</div>
                <strong>${q ? 'No matching Projects found.' : 'No Projects registered yet.'}</strong>
                <p style="font-size: 0.85rem; margin-top: 0.25rem;">${q ? 'Try searching by PID code, project name, or job location.' : 'Create a Project / PID with its Job Location to start filing Purchase Requests.'}</p>
                ${!q ? '<button class="btn btn-primary btn-sm" style="margin-top: 1rem;" onclick="ProjectLibrary.openNewProjectModal()">+ New Project / PID</button>' : ''}
              </td>
            </tr>
          `;
          return;
        }

        tbody.innerHTML = filtered.map((p, idx) => `
          <tr data-project-id="${p.id}">
            <td style="color:var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
            <td><span class="project-code-tag" style="font-size:0.85rem; padding:2px 8px;">${escapeHtml(p.projectCode)}</span></td>
            <td><strong style="color:var(--text-main);">${escapeHtml(p.projectName)}</strong></td>
            <td>📍 ${escapeHtml(p.jobLocation)}</td>
            <td><span style="font-weight:700; color:var(--primary-600);">${p.prCount}</span> Purchase Requests</td>
            <td><span class="status-pill-active">${escapeHtml(p.status || 'Active')}</span></td>
            <td style="text-align:right;">
              <button type="button" class="btn btn-primary btn-sm btn-open-project" data-id="${p.id}">
                <span>Open</span>
              </button>
            </td>
          </tr>
        `).join('');

        tbody.querySelectorAll('.btn-open-project').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            this.openProject(id);
          });
        });

      } catch (err) {
        if (countEl) countEl.textContent = 'Error loading projects.';
      }
    },

    async openProject(id) {
      this.currentProjectId = id;
      const listContainer = document.getElementById('projectListContainer');
      const detailContainer = document.getElementById('projectDetailContainer');
      const tbody = document.getElementById('projectPrTableTbody');
      const countEl = document.getElementById('projPrCount');

      try {
        const data = await DataService.getProjectDetails(id);

        if (listContainer) listContainer.style.display = 'none';
        if (detailContainer) detailContainer.style.display = 'block';

        // Update Breadcrumbs
        const sep1 = document.getElementById('bcDetailSep1');
        const sep2 = document.getElementById('bcDetailSep2');
        const projItem = document.getElementById('bcDetailProject');
        const locItem = document.getElementById('bcDetailLocation');

        if (sep1) sep1.style.display = 'inline';
        if (sep2) sep2.style.display = 'inline';
        if (projItem) {
          projItem.style.display = 'inline';
          projItem.textContent = data.projectCode;
        }
        if (locItem) {
          locItem.style.display = 'inline';
          locItem.textContent = data.jobLocation;
        }

        // Header info
        document.getElementById('projDetailCode').textContent = data.projectCode;
        document.getElementById('projDetailName').textContent = data.projectName;
        document.getElementById('projDetailLocation').textContent = data.jobLocation;
        document.getElementById('projDetailStatus').textContent = data.status || 'Active';

        const prs = data.purchaseRequests || [];
        const docs = data.documents || [];

        if (countEl) countEl.innerHTML = `<strong>${prs.length}</strong> Purchase Requests filed in <strong>${escapeHtml(data.jobLocation)}</strong>`;

        if (!tbody) return;

        if (prs.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="7" style="text-align:center; padding: 2.5rem 1rem; color: var(--text-muted);">
                No Purchase Requests generated under ${escapeHtml(data.projectCode)} yet.
              </td>
            </tr>
          `;
          return;
        }

        tbody.innerHTML = prs.map((pr, idx) => {
          const excelDoc = docs.find(d => d.purchaseRequestId === pr.id && d.documentType === 'PR_EXCEL');
          const pdfDoc = docs.find(d => d.purchaseRequestId === pr.id && d.documentType === 'PR_PDF');
          const reqDate = formatDateDisplay(pr.createdAt);

          const statusBadge = pr.status === 'APPROVED'
            ? '<span class="status-badge status-approved">APPROVED</span>'
            : (pr.status === 'REJECTED'
                ? '<span class="status-badge status-rejected">REJECTED</span>'
                : '<span class="status-badge status-pending">PENDING APPROVAL</span>');

          return `
            <tr>
              <td style="color:var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
              <td><span class="pr-badge">${escapeHtml(pr.prNumber)}</span></td>
              <td>${escapeHtml(pr.requesterName || '-')}</td>
              <td style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-muted);">${escapeHtml(pr.requesterUsername || '-')}</td>
              <td>${reqDate}</td>
              <td>${statusBadge}</td>
              <td style="text-align:right;">
                <div style="display:flex; justify-content:flex-end; gap:6px;">
                  <button type="button" class="btn btn-secondary btn-sm btn-lib-view" data-pr-id="${pr.id}">View</button>
                  ${excelDoc ? `<button type="button" class="btn-icon-link btn-lib-dl-excel" data-doc-id="${excelDoc.id}" data-filename="${excelDoc.fileName}">Excel</button>` : ''}
                  ${pdfDoc ? `<button type="button" class="btn-icon-link btn-lib-dl-pdf" data-doc-id="${pdfDoc.id}" data-filename="${pdfDoc.fileName}">PDF</button>` : ''}
                </div>
              </td>
            </tr>
          `;
        }).join('');

        tbody.querySelectorAll('.btn-lib-view').forEach(btn => {
          btn.addEventListener('click', () => {
            const prId = btn.getAttribute('data-pr-id');
            UI.openViewPrDetailsModal(prId);
          });
        });

        tbody.querySelectorAll('.btn-lib-dl-excel, .btn-lib-dl-pdf').forEach(btn => {
          btn.addEventListener('click', () => {
            const docId = btn.getAttribute('data-doc-id');
            const filename = btn.getAttribute('data-filename');
            UI.downloadDocument(docId, filename);
          });
        });

      } catch (err) {
        alert('Error loading project details: ' + err.message);
      }
    },

    closeProject() {
      this.currentProjectId = null;
      this.renderProjects();
    },

    openNewProjectModal() {
      const modal = document.getElementById('modalNewProject');
      const err = document.getElementById('newProjectErrorAlert');
      const form = document.getElementById('formNewProject');
      if (err) err.style.display = 'none';
      if (form) form.reset();
      if (modal) modal.classList.add('active');
    },

    async handleSaveNewProject() {
      const code = document.getElementById('npProjectCode')?.value?.trim();
      const name = document.getElementById('npProjectName')?.value?.trim();
      const loc = document.getElementById('npJobLocation')?.value?.trim();
      const desc = document.getElementById('npDescription')?.value?.trim();
      const errAlert = document.getElementById('newProjectErrorAlert');
      const errMsg = document.getElementById('newProjectErrorMsg');

      if (!code || !name || !loc) {
        if (errAlert && errMsg) {
          errMsg.textContent = 'Project Code, Project Name, and Job Location are all required.';
          errAlert.style.display = 'flex';
        }
        return;
      }

      try {
        const saved = await DataService.createProject({
          projectCode: code,
          projectName: name,
          jobLocation: loc,
          description: desc
        });

        UI.closeModal('modalNewProject');
        UI.showToast('Project Created', `Project ${saved.projectCode} (${saved.jobLocation}) added to library.`);

        // Refresh library view if currently on projects view
        if (UI.currentTab === 'projects') {
          this.renderProjects();
        }

        // Refresh cart project dropdown if open
        await PRCart.populateProjectDropdown();
        const cartProjSelect = document.getElementById('cartProjectSelect');
        if (cartProjSelect) {
          cartProjSelect.value = saved.id;
          PRCart.handleProjectChange();
        }

      } catch (e) {
        if (errAlert && errMsg) {
          errMsg.textContent = e.message;
          errAlert.style.display = 'flex';
        }
      }
    }
  };

  // =========================================================================
  // 1.7. EXCEL IMPORT MODULE CONTROLLER
  // =========================================================================
  const ExcelImportController = {
    file: null,
    workbook: null,
    sheets: [],
    supportedSheets: [],
    selectedSheet: null,
    parsedItems: [],
    sheetBreakdown: {},
    existingMasterItems: [],
    validationErrorsCount: 0,

    init() {
      this.bindEvents();
    },

    async openModal() {
      if (!window.PermissionService || !window.PermissionService.can('CAN_CREATE_SKU')) {
        UI.showAccessDeniedModal('Access Denied — Administrator or Engineering permission required.');
        return;
      }

      // Reset state
      this.file = null;
      this.workbook = null;
      this.sheets = [];
      this.supportedSheets = [];
      this.selectedSheet = null;
      this.parsedItems = [];
      this.sheetBreakdown = {};
      this.validationErrorsCount = 0;

      // Reset DOM fields
      const fileInput = document.getElementById('importFileInput');
      if (fileInput) fileInput.value = '';
      const fileInfoCard = document.getElementById('importFileInfoCard');
      if (fileInfoCard) fileInfoCard.style.display = 'none';
      const dropzone = document.getElementById('importDropzone');
      if (dropzone) dropzone.style.display = 'block';
      const sheetSection = document.getElementById('importSheetSelectSection');
      if (sheetSection) sheetSection.style.display = 'none';
      const btnStep2 = document.getElementById('btnImportGoStep2');
      if (btnStep2) btnStep2.disabled = true;
      const previewTbody = document.getElementById('importPreviewTbody');
      if (previewTbody) previewTbody.innerHTML = '';
      const breakdownEl = document.getElementById('previewSheetBreakdownDisplay');
      if (breakdownEl) breakdownEl.innerHTML = '';

      // Fetch fresh master items
      try {
        this.existingMasterItems = await DataService.getMasterItems();
      } catch (e) {
        this.existingMasterItems = [];
      }

      this.showStep(1);
      const modal = document.getElementById('modalExcelImport');
      if (modal) modal.classList.add('active');
    },

    showStep(stepNum) {
      // 1: Select Excel, 2: Preview Records, 3: Confirm Import, 4: Success
      const steps = [1, 2, 3];
      steps.forEach(n => {
        const node = document.getElementById(`nodeImportStep${n}`);
        const line = document.getElementById(`lineImportStep${n}`);
        const view = document.getElementById(`importViewStep${n}`);

        if (view) {
          view.style.display = (stepNum === n) ? 'block' : 'none';
        }

        if (node) {
          node.classList.remove('active', 'completed');
          if (n === stepNum) node.classList.add('active');
          else if (n < stepNum) node.classList.add('completed');
        }

        if (line) {
          line.classList.toggle('completed', n < stepNum);
        }
      });

      const successView = document.getElementById('importViewSuccess');
      if (successView) successView.style.display = (stepNum === 4) ? 'block' : 'none';

      const subtitle = document.getElementById('importStepSubtitle');
      if (subtitle) {
        const labels = {
          1: 'Step 1 of 3 — Select Excel',
          2: 'Step 2 of 3 — Preview Records',
          3: 'Step 3 of 3 — Confirm Import',
          4: 'Import Complete'
        };
        subtitle.textContent = labels[stepNum] || '';
      }
    },

    bindEvents() {
      // Step 1: Dropzone & File browsing
      const dropzone = document.getElementById('importDropzone');
      const fileInput = document.getElementById('importFileInput');
      const browseLink = document.getElementById('importBrowseLink');
      const btnChangeFile = document.getElementById('btnImportChangeFile');

      if (dropzone && fileInput) {
        dropzone.addEventListener('click', () => fileInput.click());
        browseLink?.addEventListener('click', (e) => {
          e.stopPropagation();
          fileInput.click();
        });

        dropzone.addEventListener('dragover', (e) => {
          e.preventDefault();
          dropzone.classList.add('drag-over');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
        dropzone.addEventListener('drop', (e) => {
          e.preventDefault();
          dropzone.classList.remove('drag-over');
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            this.handleFile(e.dataTransfer.files[0]);
          }
        });

        fileInput.addEventListener('change', (e) => {
          if (e.target.files && e.target.files.length > 0) {
            this.handleFile(e.target.files[0]);
          }
        });

        btnChangeFile?.addEventListener('click', () => {
          fileInput.click();
        });
      }

      // Step navigation buttons
      document.getElementById('btnImportGoStep2')?.addEventListener('click', () => {
        this.parseWorkbook();
        this.renderPreviewTable();
        this.showStep(2);
      });

      document.getElementById('btnImportBackToStep1')?.addEventListener('click', () => {
        this.showStep(1);
      });

      document.getElementById('btnImportGoStep3')?.addEventListener('click', () => {
        this.proceedToConfirmation();
      });

      document.getElementById('btnImportBackToStep2')?.addEventListener('click', () => {
        this.showStep(2);
      });

      document.getElementById('btnImportConfirmSubmit')?.addEventListener('click', () => {
        this.submitImport();
      });

      document.getElementById('btnViewImportedCatalog')?.addEventListener('click', () => {
        UI.closeModal('modalExcelImport');
        let importedCat = 'Raw Materials';
        if (this.sheetBreakdown && this.sheetBreakdown['Piping & Fittings']) {
          importedCat = 'Piping & Fittings';
        } else if (this.sheetBreakdown && this.sheetBreakdown['Fasteners']) {
          importedCat = 'Fasteners';
        } else if (this.parsedItems && this.parsedItems.length > 0 && this.parsedItems[0].category) {
          importedCat = this.parsedItems[0].category;
        } else {
          importedCat = UI.currentCategory || 'Raw Materials';
        }
        UI.openCategory(importedCat);
      });
    },

    handleFile(file) {
      if (!file) return;
      const lower = file.name.toLowerCase();
      if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
        alert('Invalid file format. Please upload an Excel workbook (.xlsx or .xls).');
        return;
      }

      this.file = file;

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          if (typeof XLSX === 'undefined') {
            alert('SheetJS library is loading, please try again in a moment.');
            return;
          }
          this.workbook = XLSX.read(data, { type: 'array', cellDates: true });

          const allSheetNames = this.workbook.SheetNames || [];
          const standardKeywords = ['new sku input', 'fastener', 'piping'];

          // Filter out "Instructions", empty "Sheet1", and identify supported sheets
          let supported = allSheetNames.filter(name => {
            const l = name.trim().toLowerCase();
            if (l.includes('instructions')) return false;
            if (l === 'sheet1' || l === 'sheet 1') return false; // Ignore default empty Sheet1
            return standardKeywords.some(kw => l.includes(kw));
          });

          // Fallback: If no standard keywords matched, include all non-instruction sheets (excluding Sheet1)
          if (supported.length === 0) {
            supported = allSheetNames.filter(name => {
              const l = name.trim().toLowerCase();
              return !l.includes('instructions') && l !== 'sheet1' && l !== 'sheet 1';
            });
          }

          // Filter out completely empty sheets
          supported = supported.filter(name => {
            const ws = this.workbook.Sheets[name];
            if (!ws || !ws['!ref']) return false;
            const range = XLSX.utils.decode_range(ws['!ref']);
            return range.e.r >= 1;
          });

          if (supported.length === 0) {
            alert('No valid material sheets found in this workbook. "Instructions" and empty sheets are ignored.');
            return;
          }

          this.supportedSheets = supported;
          this.sheets = supported;

          console.log('[1. Excel File Loaded]', {
            fileName: file.name,
            sizeBytes: file.size,
            allSheets: allSheetNames,
            supportedSheets: this.supportedSheets
          });

          // Update File Info Card
          const dropzone = document.getElementById('importDropzone');
          const fileInfoCard = document.getElementById('importFileInfoCard');
          const fileNameText = document.getElementById('importFileNameText');
          const fileMetaText = document.getElementById('importFileMetaText');
          const btnStep2 = document.getElementById('btnImportGoStep2');

          if (dropzone) dropzone.style.display = 'none';
          if (fileInfoCard) fileInfoCard.style.display = 'flex';
          if (fileNameText) fileNameText.textContent = file.name;
          if (fileMetaText) {
            const kb = (file.size / 1024).toFixed(1);
            fileMetaText.textContent = `${kb} KB • ${this.supportedSheets.length} supported sheet(s) detected: ${this.supportedSheets.join(', ')}`;
          }

          this.renderSheetSelector();
          if (btnStep2) btnStep2.disabled = false;

        } catch (err) {
          console.error('[ExcelImport] Read error:', err);
          alert('Error reading Excel workbook: ' + err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    },

    renderSheetSelector() {
      const container = document.getElementById('importSheetsGrid');
      const section = document.getElementById('importSheetSelectSection');
      if (!container) return;

      container.innerHTML = '';

      (this.supportedSheets || []).forEach((sheetName) => {
        const ws = this.workbook.Sheets[sheetName];
        let rowCount = 0;
        if (ws && ws['!ref']) {
          const range = XLSX.utils.decode_range(ws['!ref']);
          rowCount = Math.max(0, range.e.r);
        }

        const card = document.createElement('div');
        card.className = 'import-sheet-card selected';
        card.innerHTML = `
          <div class="import-sheet-card-header">
            <span class="import-sheet-name">📄 ${escapeHtml(sheetName)}</span>
            <span class="import-sheet-badge" style="background:#ecfdf5; color:#059669; border:1px solid #a7f3d0;">✓ Supported &amp; Included</span>
          </div>
          <div class="import-sheet-desc">
            Estimated ${rowCount} row(s) • Will be extracted in combined batch
          </div>
        `;

        container.appendChild(card);
      });

      if (section) {
        section.style.display = 'block';
        const h4 = section.querySelector('h4');
        if (h4) h4.textContent = 'Supported Worksheets Included in Batch Import';
        const p = section.querySelector('p');
        if (p) p.innerHTML = 'All supported data sheets below will be automatically extracted into a single combined import <em>("Instructions" and empty sheets are ignored)</em>:';
      }
    },

    parseWorkbook() {
      if (!this.workbook || !this.supportedSheets || this.supportedSheets.length === 0) {
        this.parsedItems = [];
        this.sheetBreakdown = {};
        return;
      }

      const allParsed = [];
      const sheetBreakdown = {};

      for (const sheetName of this.supportedSheets) {
        const ws = this.workbook.Sheets[sheetName];
        if (!ws) continue;

        // Use blankrows: true to process the COMPLETE row range without silent row shifting
        const rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true, raw: false });

        console.log('[2. XLSX Parser - Sheet]', {
          sheet: sheetName,
          totalRawRowsFromSheetJS: rawData.length,
          range: ws['!ref']
        });

        if (!rawData || rawData.length === 0) continue;

        const headerRow = rawData[0].map(h => String(h || '').trim());

        const colMap = {};
        headerRow.forEach((col, idx) => {
          if (col) {
            const cleanKey = col.toLowerCase().replace(/[^a-z0-9]/g, '');
            colMap[cleanKey] = idx;
          }
        });

        const getVal = (row, keyAliases) => {
          for (const alias of keyAliases) {
            const cleanKey = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (colMap[cleanKey] !== undefined) {
              const val = row[colMap[cleanKey]];
              if (val !== undefined && val !== null && String(val).trim() !== '') {
                return String(val).trim();
              }
            }
          }
          return '';
        };

        const getMultilineVal = (row, keyAliases) => {
          for (const alias of keyAliases) {
            const cleanKey = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (colMap[cleanKey] !== undefined) {
              const val = row[colMap[cleanKey]];
              if (val !== undefined && val !== null && String(val).trim() !== '') {
                return String(val).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
              }
            }
          }
          return '';
        };

        let sheetItemCount = 0;

        for (let r = 1; r < rawData.length; r++) {
          const row = rawData[r];
          if (!row || !Array.isArray(row)) continue;

          // Detect genuinely populated rows — check for any non-empty cell across the entire row
          const nonEmptyCells = row.map((cell, idx) => ({ cell: cell !== null && cell !== undefined ? String(cell).trim() : '', idx }))
                                   .filter(c => c.cell !== '');

          if (nonEmptyCells.length === 0) {
            // Empty Excel row — ignore
            continue;
          }

          // Check if row is template guidance/instructions footer row
          const firstVal = nonEmptyCells[0].cell.toLowerCase();
          if (firstVal.includes('guidance only') || firstVal.includes('delete it before import') || firstVal.includes('example row is for guidance')) {
            console.log(`[Excel Import] Row ${r + 1} in "${sheetName}" is template guidance row — skipped.`);
            continue;
          }

          const excelRowNum = r + 1;

          // Preserve values exactly as supplied in Excel without fabricating missing values
          // Optional fields: Product Name, Item Description, Current Unit Price are allowed to be blank
          const productName = getVal(row, ['Product Name', 'Product', 'Item Name']);
          const itemDescription = getMultilineVal(row, ['Item Description', 'Description', 'Spec Details']);
          
          let category = getVal(row, ['Category']);
          if (!category) {
            if (sheetName.toLowerCase().includes('piping')) category = 'Piping & Fittings';
            else if (sheetName.toLowerCase().includes('fastener')) category = 'Fasteners';
            else category = 'Raw Materials';
          } else if (category.toLowerCase() === 'piping') {
            category = 'Piping & Fittings';
          } else if (category.toLowerCase() === 'fastener' || category.toLowerCase() === 'fasteners') {
            category = 'Fasteners';
          }

          const subCategory = getVal(row, ['Subcategory', 'Sub Category']);
          const material = getVal(row, ['Material / Grade', 'Material', 'Grade']);
          const size = getVal(row, ['Nominal Size / DN / NPS', 'Size / Dimensions', 'Size / Diameter', 'Size', 'Dimensions', 'Diameter', 'Nominal Size', 'DN', 'NPS']);
          const specification = getVal(row, ['Standard / Specification', 'Specification / Standard', 'Specification', 'Standard', 'Spec']);
          const unit = getVal(row, ['Unit / UOM', 'Unit', 'UOM']);

          const rawWeight = getVal(row, ['Weight (kg)', 'Weight (kg/pc)', 'Weight', 'Theoretical Weight']);
          const weightKg = (!isNaN(parseFloat(rawWeight)) && parseFloat(rawWeight) > 0) ? parseFloat(rawWeight) : null;

          const brand = getVal(row, ['Brand / Manufacturer', 'Manufacturer', 'Brand', 'Maker']);
          const supplierName = getVal(row, ['Supplier Name', 'Supplier', 'Vendor']);
          const rawPrice = getVal(row, ['Current Unit Price (IDR)', 'Current Unit Price', 'Unit Price (IDR)', 'Unit Price', 'Price']);

          const fastenerType = getVal(row, ['Fastener Type']);
          const length = getVal(row, ['Length']);
          const threadPitch = getVal(row, ['Thread Type / Pitch', 'Thread']);
          const finish = getVal(row, ['Finish / Coating', 'Finish', 'Coating']);
          const pipeFittingType = getVal(row, ['Pipe / Fitting Type', 'Pipe Type', 'Fitting Type']);
          const od = getVal(row, ['OD (mm)', 'OD', 'Outer Diameter']);
          const wallThickness = getVal(row, ['Wall Thickness (mm)', 'Wall Thickness', 'WT']);
          const schedule = getVal(row, ['Schedule / Class / Rating', 'Schedule', 'Class', 'Rating']);
          const endConnection = getVal(row, ['End Connection']);
          const materialType = getVal(row, ['Material Type']);
          const projectPid = getVal(row, ['Project / PID (if cut size)', 'Project / PID (if project-specific)', 'Project / PID (if cut/project-specific)', 'Project / PID', 'Project', 'PID']);
          const remarks = getVal(row, ['Remarks', 'Notes']);

          allParsed.push({
            excelRowNum,
            sourceSheet: sheetName,
            productName,
            itemDescription,
            category,
            subCategory,
            material,
            size,
            specification,
            unit,
            weightKg,
            brand,
            supplierName,
            unitPrice: rawPrice,
            materialType,
            projectPid,
            remarks,
            pipeFittingType,
            od,
            wallThickness,
            schedule,
            endConnection,
            fastenerType,
            length,
            threadPitch,
            finish,
            _isDuplicate: false
          });

          sheetItemCount++;
        }

        sheetBreakdown[sheetName] = sheetItemCount;
      }

      this.parsedItems = allParsed;
      this.sheetBreakdown = sheetBreakdown;

      console.log('[3. Parsed Rows Across All Sheets]', {
        totalGenuinePopulatedRows: this.parsedItems.length,
        sheetBreakdown: this.sheetBreakdown
      });
    },

    renderPreviewTable() {
      const tbody = document.getElementById('importPreviewTbody');
      const rowCountEl = document.getElementById('previewRowCountDisplay');
      const breakdownEl = document.getElementById('previewSheetBreakdownDisplay');
      const btnStep3 = document.getElementById('btnImportGoStep3');

      if (rowCountEl) rowCountEl.textContent = this.parsedItems.length;

      if (breakdownEl && this.sheetBreakdown) {
        breakdownEl.innerHTML = Object.entries(this.sheetBreakdown).map(([sheet, count]) => {
          return `<span style="background: rgba(16, 185, 129, 0.12); color: #059669; border: 1px solid rgba(16, 185, 129, 0.3); font-size: 0.78rem; font-weight: 600; padding: 2px 8px; border-radius: 9999px;">📄 ${escapeHtml(sheet)}: <strong>${count}</strong></span>`;
        }).join('');
      }

      console.log('[4. Combined Preview Rendered]', {
        totalPreviewRows: this.parsedItems.length,
        sheetBreakdown: this.sheetBreakdown
      });

      if (btnStep3) {
        btnStep3.disabled = (this.parsedItems.length === 0);
      }

      if (!tbody) return;

      if (this.parsedItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 2.5rem; color:var(--text-muted);">No populated records detected in the supported worksheets.</td></tr>`;
        return;
      }

      tbody.innerHTML = this.parsedItems.map((it, idx) => {
        const prodNameDisplay = (it.productName && it.productName.trim()) ? escapeHtml(it.productName.trim()) : '—';
        const descDisplay = (it.itemDescription && it.itemDescription.trim()) ? escapeHtml(it.itemDescription.trim()) : '—';
        const catDisplay = (it.category && it.category.trim()) ? escapeHtml(it.category.trim()) : '—';
        const unitDisplay = (it.unit && it.unit.trim()) ? escapeHtml(it.unit.trim()) : '—';

        let priceDisplay = '—';
        if (it.unitPrice !== undefined && it.unitPrice !== null && String(it.unitPrice).trim() !== '') {
          const numPrice = Number(String(it.unitPrice).replace(/[^0-9.-]/g, ''));
          if (!isNaN(numPrice) && isFinite(numPrice)) {
            priceDisplay = `IDR ${numPrice.toLocaleString('id-ID')}`;
          } else {
            priceDisplay = escapeHtml(String(it.unitPrice).trim());
          }
        }

        return `
          <tr>
            <td style="color:var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
            <td><span class="badge" style="background:var(--bg-surface-secondary); border:1px solid var(--border-color); padding:2px 7px; border-radius:4px; font-size:0.75rem; font-weight:600;">${escapeHtml(it.sourceSheet || '—')}</span></td>
            <td style="color:var(--text-muted); font-family:var(--font-mono);">R${it.excelRowNum}</td>
            <td><span class="category-pill" style="font-size:0.75rem;">${catDisplay}</span></td>
            <td style="font-weight:600; color:var(--text-main);">${prodNameDisplay}</td>
            <td style="color:var(--text-muted); white-space:pre-wrap; max-width:320px;">${descDisplay}</td>
            <td><span style="font-weight:600; font-family:var(--font-mono);">${unitDisplay}</span></td>
            <td style="font-family:var(--font-mono); font-weight:600; color:var(--text-main);">${priceDisplay}</td>
          </tr>
        `;
      }).join('');
    },

    proceedToConfirmation() {
      if (this.parsedItems.length === 0) {
        alert('No items to import.');
        return;
      }

      const existingSkus = (this.existingMasterItems || []).map(i => i.sku);
      let maxSeq = 4235;
      existingSkus.forEach(s => {
        if (s) {
          const match = String(s).match(/^FF(\d+)$/i);
          if (match) {
            const n = parseInt(match[1], 10);
            if (n > maxSeq) maxSeq = n;
          }
        }
      });

      const startNum = maxSeq + 1;
      const endNum = maxSeq + this.parsedItems.length;

      console.log('[5. Confirmation Step]', {
        confirmedItemsCount: this.parsedItems.length,
        skuRange: `FF${startNum} – FF${endNum}`,
        sheets: this.supportedSheets,
        sheetBreakdown: this.sheetBreakdown
      });

      const confirmRowCount = document.getElementById('confirmRowCount');
      const confirmFileName = document.getElementById('confirmFileName');
      const confirmSheetName = document.getElementById('confirmSheetName');
      const confirmSkuRange = document.getElementById('confirmSkuRange');
      const confirmImportUser = document.getElementById('confirmImportUser');

      const currentUser = window.AuthService ? window.AuthService.getCurrentUser() : null;

      if (confirmRowCount) confirmRowCount.textContent = this.parsedItems.length;
      if (confirmFileName) confirmFileName.textContent = this.file ? this.file.name : 'Excel File';
      if (confirmSheetName) {
        const breakdownStr = Object.entries(this.sheetBreakdown || {})
          .map(([s, c]) => `${s} (${c})`)
          .join(', ');
        confirmSheetName.textContent = breakdownStr || (this.supportedSheets ? this.supportedSheets.join(', ') : 'All Worksheets');
      }
      if (confirmSkuRange) confirmSkuRange.textContent = `FF${startNum} – FF${endNum}`;
      if (confirmImportUser) confirmImportUser.textContent = currentUser ? `${currentUser.fullName} (${currentUser.username} • ${currentUser.role})` : 'System User';

      this.showStep(3);
    },

    async submitImport() {
      const btnSubmit = document.getElementById('btnImportConfirmSubmit');
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<span>⏳ Importing Batch Into PostgreSQL...</span>';
      }

      try {
        const token = window.AuthService ? window.AuthService.getToken() : '';
        const payload = {
          fileName: this.file ? this.file.name : 'Upload.xlsx',
          sheetName: this.supportedSheets ? this.supportedSheets.join(', ') : 'Multi-Sheet Import',
          items: this.parsedItems
        };

        console.log('[6. API Request Sent]', {
          endpoint: '/api/master-items/batch-import',
          payloadItemsCount: payload.items.length,
          fileName: payload.fileName,
          sheetName: payload.sheetName
        });

        const response = await fetch('/api/master-items/batch-import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Batch import failed');
        }

        const successCount = document.getElementById('successImportCount');
        const successSkuRange = document.getElementById('successSkuRange');
        const successMeta = document.getElementById('successMetaDetails');

        if (successCount) successCount.textContent = data.count;
        if (successSkuRange) successSkuRange.textContent = `${data.startSku} – ${data.endSku}`;
        if (successMeta) {
          successMeta.innerHTML = `
            Workbook: <strong>${escapeHtml(data.audit.fileName)}</strong> [${escapeHtml(data.audit.sheetName)}]<br>
            Imported by: <strong>${escapeHtml(data.audit.importedBy)}</strong> • Timestamp: <strong>${formatDateDisplay(data.audit.timestamp)}</strong><br>
            PostgreSQL Transaction Status: <span style="color:#10b981; font-weight:700;">COMMITTED</span>
          `;
        }

        await DataService.getMasterItems();
        UI.updateDashboardStats();
        UI.renderMasterCatalogTable();

        const matchEnd = data.endSku.match(/^FF(\d+)$/i);
        if (matchEnd && DataService.config) {
          const nextVal = parseInt(matchEnd[1], 10) + 1;
          DataService.config.skuNextNumber = nextVal;
          DataService.saveConfig(DataService.config);
        }

        UI.showToast('Import Complete', `Successfully imported ${data.count} materials (${data.startSku} – ${data.endSku}).`);
        this.showStep(4);

      } catch (err) {
        alert('Database Import Error: ' + err.message);
      } finally {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.innerHTML = '<span>Confirm &amp; Import Into Database 🚀</span>';
        }
      }
    }
  };

  // =========================================================================
  // 2. UI CONTROLLER & EVENT ORCHESTRATION
  // =========================================================================
  const UI = {
    currentTab: 'dashboard',
    activeSubcategoryFilter: 'ALL',
    searchQuery: '',
    selectedMasterItemForPR: null,
    selectedPRForVoucher: null,
    pendingFirstLoginUser: null,

    async init() {
      if (window.AuthService) {
        window.AuthService.init();
      }
      await DataService.init();
      if (typeof PRCart !== 'undefined' && PRCart.init) {
        PRCart.init();
      }
      if (typeof ProjectLibrary !== 'undefined' && ProjectLibrary.init) {
        ProjectLibrary.init();
      }
      if (typeof ExcelImportController !== 'undefined' && ExcelImportController.init) {
        ExcelImportController.init();
      }
      if (this.initAdminApprovalWorkflow) {
        this.initAdminApprovalWorkflow();
      }
      if (window.AuthService && window.AuthService.checkDbHealth) {
        window.AuthService.checkDbHealth().then(ok => this.showDbUnavailableBanner(!ok)).catch(() => this.showDbUnavailableBanner(true));
      }
      this.bindAuthEvents();
      this.bindEvents();
      this.initUserManagement();

      const currentUser = window.AuthService ? window.AuthService.getCurrentUser() : null;
      const currentToken = window.AuthService && typeof window.AuthService.getToken === 'function' ? window.AuthService.getToken() : '';
      if (!currentUser || !currentToken) {
        if (window.AuthService && typeof window.AuthService.logout === 'function') {
          window.AuthService.logout();
        }
        this.showLoginView();
      } else {
        this.showMainApp(currentUser);
        this.updateDashboardStats();
        this.renderMasterCatalogTable();
        this.renderPRRegisterTable();
        this.loadSettingsUI();
        this.initNewSkuWorkflow();
        if (currentUser.role === 'ADMIN') {
          this.renderUsersTable();
        }
      }
    },

    currentCategory: 'Raw Materials',

    openCategory(categoryName) {
      let targetCat = categoryName || 'Raw Materials';
      if (targetCat.toLowerCase().includes('piping')) {
        targetCat = 'Piping & Fittings';
      } else if (targetCat.toLowerCase().includes('fastener')) {
        targetCat = 'Fasteners';
      } else if (targetCat.toLowerCase().includes('electric')) {
        targetCat = 'Electrical';
      } else if (targetCat.toLowerCase().includes('raw')) {
        targetCat = 'Raw Materials';
      }

      if (targetCat === 'Raw Materials') {
        if (window.PermissionService && !window.PermissionService.can('CAN_VIEW_RAW_MATERIALS') && !window.PermissionService.can('CAN_VIEW_MASTER_CATALOG')) {
          this.showAccessDeniedModal('Access Denied — Raw Materials catalog permission required.');
          return;
        }
      } else {
        if (window.PermissionService && !window.PermissionService.can('CAN_VIEW_MASTER_CATALOG')) {
          this.showAccessDeniedModal('Access Denied — Master Catalog permission required.');
          return;
        }
      }

      this.currentCategory = targetCat;
      this.searchQuery = '';
      this.activeSubcategoryFilter = 'ALL';

      const searchInput = document.getElementById('catalogSearchInput');
      if (searchInput) searchInput.value = '';

      const titleEl = document.getElementById('catalogPageTitle');
      const subtitleEl = document.getElementById('catalogPageSubtitle');
      const specEl = document.getElementById('catalogSourceSpec');
      const navLabel = document.getElementById('navCatalogLabel');

      if (targetCat === 'Fasteners') {
        if (titleEl) titleEl.textContent = 'Fasteners Master Catalog';
        if (subtitleEl) subtitleEl.textContent = 'Single source of truth for Fastener procurement specifications';
        if (specEl) specEl.textContent = 'Fasteners Procurement Standard • DIN / ISO Specifications';
        if (searchInput) searchInput.placeholder = 'Search Fasteners by SKU, Product Name, Material, Size, Standard...';
        if (navLabel) navLabel.textContent = '🔩 Fasteners';
      } else if (targetCat === 'Piping & Fittings') {
        if (titleEl) titleEl.textContent = 'Piping & Fittings Master Catalog';
        if (subtitleEl) subtitleEl.textContent = 'Single source of truth for Piping & Fittings procurement specifications';
        if (specEl) specEl.textContent = 'Process Piping & Fittings Standard • ASTM / ASME Specifications';
        if (searchInput) searchInput.placeholder = 'Search Piping by SKU, Product Name, Size, Schedule, Standard...';
        if (navLabel) navLabel.textContent = '🚰 Piping & Fittings';
      } else if (targetCat === 'Electrical') {
        if (titleEl) titleEl.textContent = 'Electrical Master Catalog';
        if (subtitleEl) subtitleEl.textContent = 'Single source of truth for Electrical procurement specifications';
        if (specEl) specEl.textContent = 'Electrical & Instrumentation Specifications';
        if (searchInput) searchInput.placeholder = 'Search Electrical by SKU, Product Name, Material, Size, Specification...';
        if (navLabel) navLabel.textContent = '⚡ Electrical';
      } else {
        this.currentCategory = 'Raw Materials';
        if (titleEl) titleEl.textContent = 'Raw Materials Master Catalog';
        if (subtitleEl) subtitleEl.textContent = 'Single source of truth for raw material procurement specifications';
        if (specEl) specEl.textContent = 'Single Source of Truth • PT Persada Nusantara Steel Specifications';
        if (searchInput) searchInput.placeholder = 'Search by SKU (e.g. FF4186), Product Name, Material, Size, or Spec...';
        if (navLabel) navLabel.textContent = '📦 Raw Materials';
      }

      this.switchView('catalog');
      this.renderMasterCatalogTable();
    },

    openExcelImportModal() {
      if (typeof ExcelImportController !== 'undefined') {
        ExcelImportController.openModal();
      }
    },

    showDbUnavailableBanner(show) {
      const banner = document.getElementById('dbUnavailableBanner');
      if (banner) {
        banner.style.display = show ? 'flex' : 'none';
      }
    },

    showLoginView() {
      const loginView = document.getElementById('view-login');
      const mainHeader = document.getElementById('mainAppHeader');
      const mainApp = document.querySelector('.app-main');
      const mainFooter = document.getElementById('mainAppFooter');
      const loginErr = document.getElementById('loginErrorAlert');

      if (loginView) loginView.style.display = 'flex';
      if (mainHeader) mainHeader.style.display = 'none';
      if (mainApp) mainApp.style.display = 'none';
      if (mainFooter) mainFooter.style.display = 'none';
      if (loginErr) loginErr.style.display = 'none';

      const loginForm = document.getElementById('formLogin');
      if (loginForm) loginForm.reset();

      this.closeAllModals();
    },

    showMainApp(user) {
      const loginView = document.getElementById('view-login');
      const mainHeader = document.getElementById('mainAppHeader');
      const mainApp = document.querySelector('.app-main');
      const mainFooter = document.getElementById('mainAppFooter');

      if (loginView) loginView.style.display = 'none';
      if (mainHeader) mainHeader.style.display = 'flex';
      if (mainApp) mainApp.style.display = 'block';
      if (mainFooter) mainFooter.style.display = 'block';

      // Update header profile display
      const userNameEl = document.getElementById('headerUserName');
      const userRoleEl = document.getElementById('headerUserRole');
      const userAvatarEl = document.getElementById('headerUserAvatar');

      if (userNameEl) userNameEl.textContent = user.fullName || user.username;
      if (userRoleEl) {
        userRoleEl.textContent = user.role;
        userRoleEl.className = `role-pill ${user.role === 'ADMIN' ? 'role-admin' : 'role-employee'}`;
      }
      if (userAvatarEl) {
        const initials = (user.fullName || user.username).charAt(0).toUpperCase();
        userAvatarEl.textContent = initials;
      }

      // Adjust navigation visibility according to role
      const navBtnUsers = document.getElementById('navBtnUsers');
      const navBtnSettings = document.getElementById('navBtnSettings');
      const btnOpenNewSku = document.getElementById('btnOpenNewSku');
      const btnHeaderNewSku = document.getElementById('btnHeaderNewSku');
      const btnOpenExcelImport = document.getElementById('btnOpenExcelImport');
      const canCreate = window.PermissionService ? window.PermissionService.can('CAN_CREATE_SKU') : (user.role === 'ADMIN');

      if (btnOpenExcelImport) {
        btnOpenExcelImport.style.display = canCreate ? '' : 'none';
      }
      if (btnHeaderNewSku) {
        btnHeaderNewSku.style.display = canCreate ? '' : 'none';
      }

      if (user.role === 'ADMIN') {
        if (navBtnUsers) navBtnUsers.style.display = '';
        if (navBtnSettings) navBtnSettings.style.display = '';
        if (btnOpenNewSku) btnOpenNewSku.style.display = '';
        this.renderUsersTable();
      } else {
        if (navBtnUsers) navBtnUsers.style.display = 'none';
        if (navBtnSettings) navBtnSettings.style.display = 'none';
        if (btnOpenNewSku) btnOpenNewSku.style.display = canCreate ? '' : 'none';
      }

      this.switchView('dashboard');
    },

    showAccessDeniedModal(message = 'Access Denied — Administrator permission required.') {
      const modal = document.getElementById('modalAccessDenied');
      const msgEl = document.getElementById('accessDeniedMessageText');
      if (msgEl) msgEl.textContent = message;
      if (modal) {
        modal.classList.add('active');
      } else {
        alert(message);
      }
    },

    bindAuthEvents() {
      // Login Form Submit
      const formLogin = document.getElementById('formLogin');
      if (formLogin && !formLogin._bound) {
        formLogin._bound = true;
        formLogin.addEventListener('submit', async (e) => {
          e.preventDefault();
          const usernameInput = document.getElementById('loginUsername');
          const passwordInput = document.getElementById('loginPassword');
          const errAlert = document.getElementById('loginErrorAlert');
          const errMsg = document.getElementById('loginErrorMsg');

          const username = usernameInput ? usernameInput.value.trim() : '';
          const password = passwordInput ? passwordInput.value : '';

          const result = await window.AuthService.login(username, password);

          if (!result.success) {
            if (errAlert && errMsg) {
              errMsg.textContent = result.error || 'Invalid credentials.';
              errAlert.style.display = 'flex';
            }
            return;
          }

          if (result.mustChangePassword) {
            // First-time login password change prompt
            this.pendingFirstLoginUser = result.user;
            const modalCP = document.getElementById('modalChangePassword');
            const cpAccountDisplay = document.getElementById('cpAccountDisplay');
            const cpErrorAlert = document.getElementById('changePasswordErrorAlert');
            const cpNewPass = document.getElementById('cpNewPassword');
            const cpConfirmPass = document.getElementById('cpConfirmPassword');

            if (cpAccountDisplay) cpAccountDisplay.value = `${result.user.fullName} (${result.user.username} • ${result.user.role})`;
            if (cpErrorAlert) cpErrorAlert.style.display = 'none';
            if (cpNewPass) cpNewPass.value = '';
            if (cpConfirmPass) cpConfirmPass.value = '';
            if (modalCP) modalCP.classList.add('active');
            return;
          }

          // Successful direct login
          if (errAlert) errAlert.style.display = 'none';
          this.showMainApp(result.user);
          this.updateDashboardStats();
          this.renderMasterCatalogTable();
          this.renderPRRegisterTable();
        });
      }

      // Logout Button
      const btnLogout = document.getElementById('btnLogout');
      if (btnLogout && !btnLogout._bound) {
        btnLogout._bound = true;
        btnLogout.addEventListener('click', () => {
          window.AuthService.logout();
          this.showLoginView();
          this.showToast('Logged Out', 'You have been safely signed out of Flow Force.');
        });
      }

      // First-Time Password Change Submit
      const formCP = document.getElementById('formChangePassword');
      if (formCP && !formCP._bound) {
        formCP._bound = true;
        formCP.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!this.pendingFirstLoginUser) return;

          const newPass = document.getElementById('cpNewPassword').value;
          const confirmPass = document.getElementById('cpConfirmPassword').value;
          const errAlert = document.getElementById('changePasswordErrorAlert');
          const errMsg = document.getElementById('changePasswordErrorMsg');

          if (newPass.length < 4) {
            if (errAlert && errMsg) {
              errMsg.textContent = 'Password must be at least 4 characters long.';
              errAlert.style.display = 'flex';
            }
            return;
          }

          if (newPass !== confirmPass) {
            if (errAlert && errMsg) {
              errMsg.textContent = 'Passwords do not match. Please re-enter.';
              errAlert.style.display = 'flex';
            }
            return;
          }

          try {
            const res = await window.AuthService.completeFirstLoginPasswordChange(this.pendingFirstLoginUser.id, newPass);
            this.closeAllModals();
            this.showMainApp(res.user);
            this.showToast('Password Set', 'Your personal password has been saved. Welcome to Flow Force!');
            this.updateDashboardStats();
            this.renderMasterCatalogTable();
            this.renderPRRegisterTable();
            this.pendingFirstLoginUser = null;
          } catch (err) {
            if (errAlert && errMsg) {
              errMsg.textContent = err.message;
              errAlert.style.display = 'flex';
            }
          }
        });
      }
    },

    bindEvents() {
      // Navigation Tabs
      document.querySelectorAll('[data-view-target]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const target = btn.getAttribute('data-view-target');
          this.switchView(target);
        });
      });

      // Category Card Clicks (Active Categories)
      const rawMatCard = document.getElementById('cardRawMaterials');
      if (rawMatCard) rawMatCard.addEventListener('click', () => this.openCategory('Raw Materials'));

      const fastenersCard = document.getElementById('cardFasteners');
      if (fastenersCard) fastenersCard.addEventListener('click', () => this.openCategory('Fasteners'));

      const pipingCard = document.getElementById('cardPiping');
      if (pipingCard) pipingCard.addEventListener('click', () => this.openCategory('Piping & Fittings'));

      const electricalCard = document.getElementById('cardElectrical');
      if (electricalCard) electricalCard.addEventListener('click', () => this.openCategory('Electrical'));

      // Back to Categories button
      const btnBackCats = document.getElementById('btnBackToCategories');
      if (btnBackCats) btnBackCats.addEventListener('click', () => this.switchView('dashboard'));

      // Master Table Search Input
      const searchInput = document.getElementById('catalogSearchInput');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          this.searchQuery = e.target.value.trim().toLowerCase();
          this.renderMasterCatalogTable();
        });
      }

      // New SKU Modal Open
      const btnOpenNewSku = document.getElementById('btnOpenNewSku');
      if (btnOpenNewSku) {
        btnOpenNewSku.addEventListener('click', () => {
          if (!window.PermissionService || !window.PermissionService.can('CAN_CREATE_SKU')) {
            this.showAccessDeniedModal('Access Denied — Administrator permission required.');
            return;
          }
          this.openNewSkuModal();
        });
      }

      const btnHeaderNewSku = document.getElementById('btnHeaderNewSku');
      if (btnHeaderNewSku) {
        btnHeaderNewSku.addEventListener('click', () => {
          if (!window.PermissionService || !window.PermissionService.can('CAN_CREATE_SKU')) {
            this.showAccessDeniedModal('Access Denied — Administrator permission required.');
            return;
          }
          this.openNewSkuModal();
        });
      }

      // Modal Closers
      document.querySelectorAll('[data-modal-close]').forEach(btn => {
        btn.addEventListener('click', () => {
          this.closeAllModals();
        });
      });

      // Close modal on backdrop click
      document.querySelectorAll('.modal-backdrop').forEach(modal => {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this.closeAllModals();
          }
        });
      });

      // PR Form Submit
      const formCreatePr = document.getElementById('formCreatePr');
      if (formCreatePr) {
        formCreatePr.addEventListener('submit', (e) => {
          e.preventDefault();
          this.handleCreatePurchaseRequest();
        });
      }

      // Quick PID selection buttons
      document.querySelectorAll('.btn-pid-preset').forEach(btn => {
        btn.addEventListener('click', () => {
          const pid = btn.getAttribute('data-pid');
          const input = document.getElementById('prProjectId');
          if (input) input.value = pid;
        });
      });

      // Settings Form Submit
      const formSettings = document.getElementById('formSettings');
      if (formSettings) {
        formSettings.addEventListener('submit', (e) => {
          e.preventDefault();
          this.handleSaveSettings();
        });
      }

      // Reset Catalog button
      const btnResetCatalog = document.getElementById('btnResetCatalog');
      if (btnResetCatalog) {
        btnResetCatalog.addEventListener('click', async () => {
          if (!window.PermissionService || !window.PermissionService.can('CAN_ACCESS_SETTINGS')) {
            this.showAccessDeniedModal('Access Denied — Administrator permission required.');
            return;
          }
          if (confirm('Are you sure you want to reset the Master Catalog to the verified 50 items (FF4186 - FF4235)? Any newly created trial SKUs and PRs will be refreshed.')) {
            await DataService.resetToDefault50();
            this.showToast('Catalog Reset', 'Master Catalog successfully restored to 50 verified reference items.');
            this.updateDashboardStats();
            this.renderMasterCatalogTable();
            this.renderPRRegisterTable();
            this.loadSettingsUI();
          }
        });
      }

      // Print Voucher Button
      const btnPrintVoucher = document.getElementById('btnPrintVoucher');
      if (btnPrintVoucher) {
        btnPrintVoucher.addEventListener('click', () => {
          window.print();
        });
      }
    },

    switchView(viewName) {
      if (viewName === 'users') {
        if (!window.PermissionService || !window.PermissionService.can('CAN_MANAGE_USERS')) {
          this.showAccessDeniedModal('Access Denied — Administrator permission required.');
          return;
        }
      }

      if (viewName === 'settings') {
        if (!window.PermissionService || !window.PermissionService.can('CAN_ACCESS_SETTINGS')) {
          this.showAccessDeniedModal('Access Denied — Administrator permission required.');
          return;
        }
      }

      if (viewName === 'catalog') {
        if (window.PermissionService && !window.PermissionService.can('CAN_VIEW_MASTER_CATALOG')) {
          this.showAccessDeniedModal('Access Denied — Master Catalog permission required.');
          return;
        }
      }

      if (viewName === 'dashboard') {
        if (window.PermissionService && !window.PermissionService.can('CAN_VIEW_DASHBOARD')) {
          this.showAccessDeniedModal('Access Denied — Dashboard permission required.');
          return;
        }
      }

      if (viewName === 'prs') {
        if (window.PermissionService && !window.PermissionService.can('CAN_VIEW_OWN_PRS') && !window.PermissionService.can('CAN_VIEW_ALL_PRS')) {
          this.showAccessDeniedModal('Access Denied — Purchase Request permission required.');
          return;
        }
      }

      this.currentTab = viewName;

      // Update Nav Buttons
      document.querySelectorAll('[data-view-target]').forEach(btn => {
        if (btn.getAttribute('data-view-target') === viewName) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      // Update View Sections
      document.querySelectorAll('.view-section').forEach(sec => {
        if (sec.id === `view-${viewName}`) {
          sec.classList.add('active');
        } else {
          sec.classList.remove('active');
        }
      });

      // Refresh Data on View Switch
      if (viewName === 'dashboard') {
        this.updateDashboardStats();
      } else if (viewName === 'catalog') {
        this.renderMasterCatalogTable();
      } else if (viewName === 'prs') {
        this.renderPRRegisterTable();
      } else if (viewName === 'projects') {
        if (typeof ProjectLibrary !== 'undefined' && ProjectLibrary.renderProjects) {
          ProjectLibrary.renderProjects();
        }
      } else if (viewName === 'users') {
        this.renderUsersTable();
      }
      
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    async updateDashboardStats() {
      let masterItems = [];
      let allPrs = [];
      try {
        masterItems = await DataService.getMasterItems();
        allPrs = await DataService.getPurchaseRequests();
      } catch (err) {
        console.warn('[UI] updateDashboardStats fetch warning:', err);
      }
      const currentUser = window.AuthService ? window.AuthService.getCurrentUser() : null;
      const isAdmin = currentUser && currentUser.role === 'ADMIN';

      let userPrs = allPrs;
      if (!isAdmin && currentUser) {
        userPrs = allPrs.filter(p => 
          p.userId === currentUser.id ||
          p.createdById === currentUser.id ||
          p.requesterUsername === currentUser.username ||
          (p.requestedBy && p.requestedBy.toLowerCase() === currentUser.fullName.toLowerCase())
        );
      }

      const pendingCount = userPrs.filter(p => {
        const s = (p.status || '').toUpperCase();
        return s === 'PENDING_APPROVAL' || s === 'PENDING APPROVAL' || s === 'SUBMITTED' || s === 'DRAFT';
      }).length;
      const approvedCount = userPrs.filter(p => (p.status || '').toUpperCase() === 'APPROVED').length;
      const rejectedCount = userPrs.filter(p => (p.status || '').toUpperCase() === 'REJECTED').length;

      // Update labels based on role (Admin: Total PRs, Pending, Approved, Rejected; Employee: My PRs, My Pending, My Approved, My Rejected)
      const lblTotal = document.getElementById('kpiLabelTotalPrs');
      const lblPending = document.getElementById('kpiLabelPendingPrs');
      const lblApproved = document.getElementById('kpiLabelApprovedPrs');
      const lblRejected = document.getElementById('kpiLabelRejectedPrs');

      if (lblTotal) lblTotal.textContent = isAdmin ? 'Total PRs' : 'My PRs';
      if (lblPending) lblPending.textContent = isAdmin ? 'Pending Approval' : 'My Pending PRs';
      if (lblApproved) lblApproved.textContent = isAdmin ? 'Approved' : 'My Approved PRs';
      if (lblRejected) lblRejected.textContent = isAdmin ? 'Rejected' : 'My Rejected PRs';

      const elTotalSkus = document.getElementById('kpiTotalSkus');
      const elTotalPrs = document.getElementById('kpiTotalPrs');
      const elPendingPrs = document.getElementById('kpiPendingPrs');
      const elApprovedPrs = document.getElementById('kpiApprovedPrs');
      const elRejectedPrs = document.getElementById('kpiRejectedPrs');
      const elNavPrCount = document.getElementById('navPrBadge');
      const elNavSkuCount = document.getElementById('navCatalogBadge');

      if (elTotalSkus) elTotalSkus.textContent = masterItems.length;
      if (elTotalPrs) elTotalPrs.textContent = userPrs.length;
      if (elPendingPrs) elPendingPrs.textContent = pendingCount;
      if (elApprovedPrs) elApprovedPrs.textContent = approvedCount;
      if (elRejectedPrs) elRejectedPrs.textContent = rejectedCount;
      if (elNavPrCount) elNavPrCount.textContent = userPrs.length;
      if (elNavSkuCount) elNavSkuCount.textContent = masterItems.length;

      // Actual Category Counts from PostgreSQL Database
      const rawMaterialsCount = masterItems.filter(i => (i.category || '').trim().toLowerCase() === 'raw materials').length;
      const fastenersCount = masterItems.filter(i => (i.category || '').trim().toLowerCase() === 'fasteners').length;
      const pipingCount = masterItems.filter(i => {
        const cat = (i.category || '').trim().toLowerCase();
        return cat === 'piping & fittings' || cat === 'piping';
      }).length;
      const electricalCount = masterItems.filter(i => (i.category || '').trim().toLowerCase() === 'electrical').length;

      const elCatRaw = document.getElementById('catCountRawMaterials');
      const elCatFasteners = document.getElementById('catCountFasteners');
      const elCatPiping = document.getElementById('catCountPiping');
      const elCatElectrical = document.getElementById('catCountElectrical');

      if (elCatRaw) elCatRaw.textContent = `${rawMaterialsCount} Items`;
      if (elCatFasteners) elCatFasteners.textContent = `${fastenersCount} Items`;
      if (elCatPiping) elCatPiping.textContent = `${pipingCount} Items`;
      if (elCatElectrical) elCatElectrical.textContent = `${electricalCount} Items`;
    },

    // =========================================================================
    // USER & ROLE MANAGEMENT (ADMIN ONLY)
    // =========================================================================
    initUserManagement() {
      // "+ Add Employee" button
      const btnOpenAddUser = document.getElementById('btnOpenAddUser');
      if (btnOpenAddUser && !btnOpenAddUser._bound) {
        btnOpenAddUser._bound = true;
        btnOpenAddUser.addEventListener('click', () => {
          if (!window.PermissionService || !window.PermissionService.can('CAN_MANAGE_USERS')) {
            this.showAccessDeniedModal('Access Denied — Administrator permission required.');
            return;
          }
          this.openUserModal(null);
        });
      }

      // User Form Submit
      const formUser = document.getElementById('formUserManagement');
      if (formUser && !formUser._bound) {
        formUser._bound = true;
        formUser.addEventListener('submit', (e) => {
          e.preventDefault();
          this.handleSaveUser();
        });
      }

      // Password Reset Confirm
      const btnConfirmReset = document.getElementById('btnConfirmResetPassword');
      if (btnConfirmReset && !btnConfirmReset._bound) {
        btnConfirmReset._bound = true;
        btnConfirmReset.addEventListener('click', () => {
          this.handleConfirmResetPassword();
        });
      }
    },

    openUserModal(user = null) {
      const modal = document.getElementById('modalUserForm');
      const titleEl = document.getElementById('modalUserFormTitle');
      const subEl = document.getElementById('modalUserFormSubtitle');
      const errAlert = document.getElementById('userFormErrorAlert');
      const passGroup = document.getElementById('ufPasswordGroup');
      const passInput = document.getElementById('ufInitialPassword');
      const statusSelect = document.getElementById('ufStatus');
      const roleInput = document.getElementById('ufRole');
      const roleDisplay = document.getElementById('ufRoleDisplay');
      const btnSave = document.getElementById('btnSaveUserSubmit');

      if (!modal) return;
      if (errAlert) errAlert.style.display = 'none';

      document.getElementById('ufUserId').value = user ? user.id : '';
      document.getElementById('ufFullName').value = user ? user.fullName : '';
      document.getElementById('ufUsername').value = user ? user.username : '';
      document.getElementById('ufEmail').value = user ? (user.email || '') : '';
      
      if (statusSelect) statusSelect.value = user ? user.status : 'Active';

      if (user) {
        if (titleEl) titleEl.textContent = `Edit User: ${user.fullName}`;
        if (subEl) subEl.textContent = `Update account credentials for ${user.username}`;
        if (passGroup) passGroup.style.display = 'none';
        if (passInput) passInput.required = false;
        if (roleInput) roleInput.value = user.role;
        if (roleDisplay) roleDisplay.value = user.role;
        if (btnSave) btnSave.textContent = 'Update User';
      } else {
        if (titleEl) titleEl.textContent = '+ Add Employee';
        if (subEl) subEl.textContent = 'Configure account details for standard procurement employee';
        if (passGroup) passGroup.style.display = 'block';
        if (passInput) {
          passInput.value = '';
          passInput.required = true;
        }
        if (roleInput) roleInput.value = 'EMPLOYEE';
        if (roleDisplay) roleDisplay.value = 'EMPLOYEE';
        if (btnSave) btnSave.textContent = 'Save Employee';
      }

      modal.classList.add('active');
    },

    handleSaveUser() {
      const id = document.getElementById('ufUserId').value;
      const fullName = document.getElementById('ufFullName').value.trim();
      const username = document.getElementById('ufUsername').value.trim();
      const email = document.getElementById('ufEmail').value.trim();
      const role = document.getElementById('ufRole').value || 'EMPLOYEE';
      const status = document.getElementById('ufStatus') ? document.getElementById('ufStatus').value : 'Active';
      const initialPassword = document.getElementById('ufInitialPassword').value.trim();

      const errAlert = document.getElementById('userFormErrorAlert');
      const errMsg = document.getElementById('userFormErrorMsg');

      try {
        if (!fullName) throw new Error('Full Name is required.');
        if (!username) throw new Error('Username is required.');

        if (id) {
          // Edit existing user
          window.UserService.updateUser(id, { fullName, username, email, role, status });
          this.showToast('User Updated', `Account details for ${fullName} updated successfully.`);
        } else {
          // Add new employee
          if (!initialPassword) throw new Error('Password is required.');
          window.UserService.createUser({
            fullName,
            username,
            email,
            role: 'EMPLOYEE', // strictly EMPLOYEE
            status,
            password: initialPassword
          });
          this.showToast('Employee Added', `Employee account for ${fullName} created successfully.`);
        }
        this.closeAllModals();
        this.renderUsersTable();
      } catch (err) {
        if (errAlert && errMsg) {
          errMsg.textContent = err.message;
          errAlert.style.display = 'flex';
        } else {
          alert(err.message);
        }
      }
    },

    openResetPasswordModal(user) {
      const modal = document.getElementById('modalResetPassword');
      const subEl = document.getElementById('resetPasswordSubtitle');
      const idInput = document.getElementById('rpUserId');
      const tempPassInput = document.getElementById('rpNewTempPass');

      if (!modal) return;
      if (idInput) idInput.value = user.id;
      if (subEl) subEl.textContent = `Issue temporary password for ${user.fullName} (${user.username})`;
      if (tempPassInput) tempPassInput.value = 'FlowForce2026!';

      modal.classList.add('active');
    },

    handleConfirmResetPassword() {
      const id = document.getElementById('rpUserId').value;
      const newTempPass = document.getElementById('rpNewTempPass').value.trim();

      if (!newTempPass) {
        alert('Please enter a temporary password.');
        return;
      }

      try {
        const { user } = window.UserService.resetPassword(id, newTempPass);
        this.closeAllModals();
        this.showToast('Password Reset', `Temporary password set for ${user.fullName}. User must change it on next login.`);
        this.renderUsersTable();
      } catch (err) {
        alert('Error resetting password: ' + err.message);
      }
    },

    async handleToggleUserStatus(userId) {
      const user = window.UserService.getUserById(userId);
      if (!user) return;

      const newStatus = user.status === 'Active' ? 'Disabled' : 'Active';
      const actionLabel = newStatus === 'Active' ? 'Enable' : 'Disable';

      // Check preventing disabling the currently logged-in last Admin account or zero active admins
      if (user.role === 'ADMIN' && newStatus === 'Disabled') {
        const users = window.UserService.getUsers();
        const activeAdmins = users.filter(u => u.role === 'ADMIN' && u.status === 'Active');
        if (activeAdmins.length <= 1) {
          alert('Cannot disable the only active Administrator account. The system must always have at least one active Admin.');
          return;
        }
        const currentUser = window.AuthService ? window.AuthService.getCurrentUser() : null;
        if (currentUser && currentUser.id === user.id) {
          alert('You cannot disable your own active Administrator account.');
          return;
        }
      }

      if (!confirm(`Are you sure you want to ${actionLabel.toLowerCase()} user account "${user.fullName}" (${user.username})?`)) {
        return;
      }

      try {
        window.UserService.setUserStatus(userId, newStatus);
        this.showToast(`User ${actionLabel}d`, `Account "${user.fullName}" is now ${newStatus}.`);
        this.renderUsersTable();
      } catch (err) {
        alert(err.message);
      }
    },

    renderUsersTable() {
      // Robust selector finding tbody
      const tbody = document.getElementById('usersTableTbody') || 
                    document.querySelector('#users table tbody') || 
                    document.querySelector('#usersTable tbody') ||
                    document.querySelector('#view-users table tbody');

      const users = window.UserService ? window.UserService.getUsers() : [];

      // Update KPI counters
      const elTotal = document.getElementById('kpiTotalUsers');
      const elActive = document.getElementById('kpiActiveUsers');
      const elAdmin = document.getElementById('kpiAdminCount');
      const elEmp = document.getElementById('kpiEmployeeCount');
      const countEl = document.getElementById('usersTableCount');

      const activeCount = users.filter(u => u.status === 'Active').length;
      const adminCount = users.filter(u => u.role === 'ADMIN').length;
      const empCount = users.filter(u => u.role === 'EMPLOYEE').length;

      if (elTotal) elTotal.textContent = users.length;
      if (elActive) elActive.textContent = activeCount;
      if (elAdmin) elAdmin.textContent = adminCount;
      if (elEmp) elEmp.textContent = empCount;
      if (countEl) countEl.textContent = `Total ${users.length} Accounts Registered`;

      if (!tbody) {
        console.error('[UI] User table tbody element not found!');
        return;
      }

      // Empty State handling
      if (!users || users.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="8" style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); font-size: 0.95rem;">
              No user accounts found.
            </td>
          </tr>
        `;
        return;
      }

      const currentUser = window.AuthService ? window.AuthService.getCurrentUser() : null;

      tbody.innerHTML = users.map((user, idx) => {
        const roleClass = user.role === 'ADMIN' ? 'role-admin' : 'role-employee';
        const statusClass = user.status === 'Active' ? 'status-pill-active' : 'status-pill-disabled';
        const formattedDate = formatDateDisplay(user.createdAt);
        const isSelf = currentUser && currentUser.id === user.id;

        // Check if this is the last active admin
        const isLastActiveAdmin = user.role === 'ADMIN' && user.status === 'Active' && activeCount <= 1;

        return `
          <tr data-user-id="${escapeHtml(user.id)}">
            <td style="color:var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
            <td>
              <span class="sku-badge" style="background:#f1f5f9; color:var(--text-main); font-size:0.75rem;">${escapeHtml(user.id)}</span>
            </td>
            <td>
              <div style="font-weight:600; color:var(--text-main);">${escapeHtml(user.fullName)} ${isSelf ? '<span style="font-size:0.7rem; color:var(--primary-600);">(You)</span>' : ''}</div>
              ${user.mustChangePassword ? '<span style="font-size:0.7rem; color:var(--accent-amber); font-weight:600;">⚠️ Password change pending</span>' : ''}
            </td>
            <td>
              <div style="font-weight:500;">${escapeHtml(user.username)}</div>
              <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(user.email || '-')}</div>
            </td>
            <td>
              <span class="role-pill ${roleClass}">${escapeHtml(user.role)}</span>
            </td>
            <td>
              <span class="${statusClass}">● ${escapeHtml(user.status)}</span>
            </td>
            <td style="color:var(--text-muted); font-size:0.8rem;">
              ${formattedDate}
            </td>
            <td>
              <div class="user-actions-group">
                <button type="button" class="btn-user-action btn-action-user-edit" data-user-id="${escapeHtml(user.id)}" title="Edit User Details">
                  ✏️ Edit
                </button>
                <button type="button" class="btn-user-action btn-action-user-reset" data-user-id="${escapeHtml(user.id)}" title="Reset Temporary Password">
                  🔑 Reset Password
                </button>
                <button type="button" class="btn-user-action ${user.status === 'Active' ? 'btn-disable' : 'btn-enable'} btn-action-user-status" data-user-id="${escapeHtml(user.id)}" title="${user.status === 'Active' ? (isLastActiveAdmin ? 'Cannot disable last active Admin' : 'Disable Account') : 'Enable Account'}" ${isLastActiveAdmin ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}>
                  ${user.status === 'Active' ? '🚫 Disable' : '✓ Enable'}
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // Bind actions on generated buttons
      tbody.querySelectorAll('.btn-action-user-edit').forEach(btn => {
        btn.addEventListener('click', () => {
          const uid = btn.getAttribute('data-user-id');
          const found = window.UserService.getUserById(uid);
          if (found) this.openUserModal(found);
        });
      });

      tbody.querySelectorAll('.btn-action-user-reset').forEach(btn => {
        btn.addEventListener('click', () => {
          const uid = btn.getAttribute('data-user-id');
          const found = window.UserService.getUserById(uid);
          if (found) this.openResetPasswordModal(found);
        });
      });

      tbody.querySelectorAll('.btn-action-user-status').forEach(btn => {
        btn.addEventListener('click', () => {
          const uid = btn.getAttribute('data-user-id');
          this.handleToggleUserStatus(uid);
        });
      });
    },

    // Alias for renderUserManagement as specified in user prompt data flow
    renderUserManagement() {
      return this.renderUsersTable();
    },

    // =========================================================================
    // 3. MASTER CATALOG RENDERING (50 ROWS TABLE)
    // =========================================================================
    getItemDescription(item) {
      return DataService.getItemDescription(item);
    },

    async renderMasterCatalogTable() {
      const tbody = document.getElementById('masterCatalogTbody');
      const countEl = document.getElementById('catalogRowCount');
      const filterChipsContainer = document.getElementById('filterChipsContainer');

      if (!tbody) return;

      // 1. Loading State: Display immediately
      if (countEl) countEl.innerHTML = 'Loading Master Items...';
      tbody.innerHTML = `
        <tr>
          <td colspan="11" style="text-align:center; padding: 2.5rem 1rem; color: var(--text-muted);">
            <div style="font-size: 1.5rem; margin-bottom: 0.5rem;">⏳</div>
            <div style="font-weight: 500;">Loading Master Items from database...</div>
          </td>
        </tr>
      `;

      let masterItems;
      try {
        masterItems = await DataService.getMasterItems();
      } catch (err) {
        if (err && err.authRequired) {
          return; // Redirecting to login view
        }
        console.error('[UI] Failed to load Master Items:', err);
        if (countEl) {
          countEl.innerHTML = '<span style="color: var(--danger);">Failed to load Master Items</span>';
        }
        tbody.innerHTML = `
          <tr>
            <td colspan="11" style="text-align:center; padding: 2.5rem 1rem; color: var(--text-main);">
              <div style="font-size: 2rem; margin-bottom: 0.5rem;">⚠️</div>
              <div style="font-weight: 600; font-size: 1rem; color: var(--danger); margin-bottom: 0.25rem;">
                Unable to load Master Items. Please check the database connection.
              </div>
              <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">
                ${escapeHtml(err.message || 'Database connection unavailable.')}
              </p>
              <button class="btn btn-secondary btn-sm" id="btnRetryCatalog" onclick="UI.renderMasterCatalogTable()">
                <span>↻ Retry</span>
              </button>
            </td>
          </tr>
        `;
        return;
      }

      // 2. Category-Specific Scope: Filter by Active Category
      const currentCat = this.currentCategory || 'Raw Materials';
      const categoryItems = masterItems.filter(item => {
        const itemCat = (item.category || 'Raw Materials').trim();
        if (currentCat === 'Piping & Fittings') {
          return itemCat.toLowerCase() === 'piping & fittings' || itemCat.toLowerCase() === 'piping';
        }
        return itemCat.toLowerCase() === currentCat.toLowerCase();
      });

      console.log('[10. Catalog UI Table Render]', {
        category: currentCat,
        renderedCategoryRows: categoryItems.length,
        totalCatalogItems: masterItems.length
      });

      // 3. Category Empty State (e.g. Electrical when 0 imported)
      if (!categoryItems || categoryItems.length === 0) {
        if (countEl) countEl.innerHTML = `Showing <strong>0</strong> of <strong>0</strong> Master Items`;
        if (filterChipsContainer) filterChipsContainer.innerHTML = '';
        const canCreateSku = window.PermissionService ? window.PermissionService.can('CAN_CREATE_SKU') : false;
        tbody.innerHTML = `
          <tr>
            <td colspan="11" style="text-align:center; padding: 3.5rem 1.5rem; color: var(--text-muted);">
              <div style="font-size: 2.5rem; margin-bottom: 0.75rem;">📦</div>
              <strong style="font-size: 1.15rem; color: var(--text-main); display: block; margin-bottom: 0.5rem;">
                No ${escapeHtml(currentCat)} Master Items have been imported yet.
              </strong>
              <p style="font-size:0.9rem; margin-bottom: 1.25rem; color: var(--text-muted);">
                Single source of truth for ${escapeHtml(currentCat)} procurement specifications. Import an Excel template or create a new SKU to begin.
              </p>
              ${canCreateSku ? `
                <div style="display: flex; gap: 0.75rem; justify-content: center;">
                  <button class="btn btn-secondary btn-sm" onclick="UI.openExcelImportModal()">
                    <span>📁 + Import Excel</span>
                  </button>
                  <button class="btn btn-primary btn-sm" onclick="UI.openNewSkuModal()">
                    <span>+ Create New SKU</span>
                  </button>
                </div>
              ` : ''}
            </td>
          </tr>
        `;
        return;
      }

      // Calculate Subcategory Breakdown for filter chips within this category
      const subcategories = {};
      categoryItems.forEach(item => {
        const sub = item.subCategory || 'Other';
        subcategories[sub] = (subcategories[sub] || 0) + 1;
      });

      // Render Subcategory Filter Chips
      if (filterChipsContainer) {
        let chipsHtml = `
          <button class="filter-chip ${this.activeSubcategoryFilter === 'ALL' ? 'active' : ''}" data-subcat="ALL">
            All ${escapeHtml(currentCat)} <span class="chip-count">${categoryItems.length}</span>
          </button>
        `;
        Object.keys(subcategories).sort().forEach(sub => {
          const isActive = this.activeSubcategoryFilter === sub;
          chipsHtml += `
            <button class="filter-chip ${isActive ? 'active' : ''}" data-subcat="${escapeHtml(sub)}">
              ${escapeHtml(sub)} <span class="chip-count">${subcategories[sub]}</span>
            </button>
          `;
        });
        filterChipsContainer.innerHTML = chipsHtml;

        // Bind filter chip events
        filterChipsContainer.querySelectorAll('.filter-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            this.activeSubcategoryFilter = chip.getAttribute('data-subcat');
            this.renderMasterCatalogTable();
          });
        });
      }

      // Filter items within category by search and subcategory
      const q = this.searchQuery;
      const filtered = categoryItems.filter(item => {
        // Subcategory match
        if (this.activeSubcategoryFilter !== 'ALL' && item.subCategory !== this.activeSubcategoryFilter) {
          return false;
        }
        // Search text match
        if (!q) return true;
        const searchCorpus = [
          item.sku,
          item.productName,
          item.itemDescription || '',
          item.subCategory,
          item.material,
          item.size,
          item.unit,
          item.weightKg ? String(item.weightKg) : '',
          item.status || '',
          item.remarks || '',
          item.brand,
          item.sourceSheet || '',
          JSON.stringify(item.specificAttributes || {})
        ].join(' ').toLowerCase();

        return searchCorpus.includes(q);
      });

      if (countEl) {
        countEl.innerHTML = `Showing <strong>${filtered.length}</strong> of <strong>${categoryItems.length}</strong> Master Items`;
      }
      const navBadge = document.getElementById('navCatalogBadge');
      if (navBadge) navBadge.textContent = masterItems.length;

      const canEditDescription = window.PermissionService ? window.PermissionService.can('CAN_EDIT_ITEM_DESCRIPTION') : false;
      const canEditPrice = window.PermissionService ? window.PermissionService.can('CAN_EDIT_PRICE') : false;
      const canEditStatus = window.PermissionService ? window.PermissionService.can('CAN_EDIT_STATUS') : false;
      const canEditRemarks = window.PermissionService ? window.PermissionService.can('CAN_EDIT_REMARKS') : false;
      const canCreateSku = window.PermissionService ? window.PermissionService.can('CAN_CREATE_SKU') : false;

      if (filtered.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="13" style="text-align:center; padding: 3rem 1rem; color: var(--text-muted);">
              <div style="font-size: 2rem; margin-bottom: 0.5rem;">🔍</div>
              <strong>No ${escapeHtml(currentCat)} records found matching "${escapeHtml(this.searchQuery)}"</strong>
              <p style="font-size:0.85rem; margin-top:0.25rem;">Try adjusting your search or contact Engineering for new material verification.</p>
              ${canCreateSku ? '<button class="btn btn-primary btn-sm" style="margin-top:1rem;" onclick="UI.openNewSkuModal()">+ Create New SKU</button>' : ''}
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = filtered.map((item, idx) => {
        const itemDesc = this.getItemDescription(item);
        const itemStatus = (item.status === 'Out of Stock') ? 'Out of Stock' : 'Available';
        const statusClass = itemStatus.toLowerCase().replace(/[\s_]+/g, '-');
        const itemRemarks = (item.remarks !== undefined && item.remarks !== null) ? item.remarks : '';
        const isPlateSheet = /plate|sheet|plat/i.test(`${item.productName || ''} ${item.itemDescription || ''} ${item.unit || ''} ${item.subCategory || ''} ${item.category || ''}`);

        return `
          <tr data-sku="${escapeHtml(item.sku)}">
            <td style="color: var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
            <td>
              <span class="sku-badge">${escapeHtml(item.sku)}</span>
            </td>
            <td>
              <div style="font-weight: 600; color: var(--text-main); display: flex; align-items: center; flex-wrap: wrap;">
                <span>${escapeHtml(item.productName || '—')}</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(item.sourceSheet ? 'Source: ' + item.sourceSheet : '')}</div>
            </td>
            <td>
              <div class="catalog-desc-cell-wrapper">
                ${canEditDescription ? `
                  <textarea 
                    class="catalog-desc-textarea" 
                    data-sku="${escapeHtml(item.sku)}" 
                    placeholder="Enter detailed specification..." 
                    rows="3"
                    title="Directly edit Master Item Description for ${escapeHtml(item.sku)}"
                  >${escapeHtml(itemDesc)}</textarea>
                  <div class="catalog-desc-status" id="descStatus_${escapeHtml(item.sku)}"></div>
                ` : `
                  <div class="catalog-desc-readonly" title="${escapeHtml(itemDesc)}">${escapeHtml(itemDesc)}</div>
                `}
              </div>
            </td>
            <td>
              <span class="subcat-tag">${escapeHtml(item.subCategory || 'Raw Materials')}</span>
            </td>
            <td>
              <div style="font-weight: 500;">${escapeHtml(item.material || '-')}</div>
            </td>
            <td>
              <div style="font-family: var(--font-mono); font-size: 0.82rem; color: var(--text-main);">${escapeHtml(item.size || '-')}</div>
            </td>
            <td>
              <span class="unit-badge">${escapeHtml(item.unit || 'PCS')}</span>
            </td>
            <td>
              <span class="weight-val">${item.weightKg ? item.weightKg + ' kg' : '-'}</span>
            </td>
            <td>
              ${canEditStatus ? `
                <div class="catalog-status-cell-wrapper">
                  <select class="catalog-status-select status-val-${statusClass}" 
                          data-sku="${escapeHtml(item.sku)}"
                          title="Change status for ${escapeHtml(item.sku)}">
                    <option value="Available"${itemStatus === 'Available' ? ' selected' : ''}>Available</option>
                    <option value="Out of Stock"${itemStatus === 'Out of Stock' ? ' selected' : ''}>Out of Stock</option>
                  </select>
                  <div class="catalog-status-feedback" id="statusFeedback_${escapeHtml(item.sku)}"></div>
                </div>
              ` : `
                <span class="status-badge ${statusClass}">
                  ● ${escapeHtml(itemStatus)}
                </span>
              `}
            </td>
            <td>
              <div class="catalog-supply-cell-wrapper" id="supplyWrapper_${escapeHtml(item.sku)}">
                <div class="supply-select-header" style="display:flex; align-items:center; gap:6px;">
                  <select class="catalog-supply-select supply-val-full-size" 
                          data-sku="${escapeHtml(item.sku)}"
                          id="supplySelect_${escapeHtml(item.sku)}"
                          title="Select Supply Type for ${escapeHtml(item.sku)}">
                    <option value="Full Size" selected>Full Size</option>
                    <option value="Cut Size">Cut Size</option>
                  </select>
                  <span class="supply-badge full-size" id="supplyBadge_${escapeHtml(item.sku)}">FULL SIZE</span>
                </div>
                <div class="catalog-cut-panel" id="cutPanel_${escapeHtml(item.sku)}" style="display: none;">
                  <div class="cut-orig-dim-display" title="Original Dimensions (Read-only)">
                    <span class="cut-dim-label">Original:</span>
                    <span class="cut-dim-orig-val" id="origDim_${escapeHtml(item.sku)}">${escapeHtml(item.size || item.sizeDimensions || '—')}</span>
                  </div>
                  <div class="cut-inputs-grid">
                    <div class="cut-input-group">
                      <label class="cut-dim-sublabel" for="cutLength_${escapeHtml(item.sku)}">Cut Length <span class="req">*</span></label>
                      <input type="number" step="any" min="0" 
                             class="input-cut-dim input-cut-length" 
                             id="cutLength_${escapeHtml(item.sku)}" 
                             data-sku="${escapeHtml(item.sku)}" 
                             placeholder="Length (mm)">
                    </div>
                    <div class="cut-input-group">
                      <label class="cut-dim-sublabel" for="cutWidth_${escapeHtml(item.sku)}">Cut Width <span class="cut-width-req-mark req" style="display:${isPlateSheet ? 'inline' : 'none'};">*</span></label>
                      <input type="number" step="any" min="0" 
                             class="input-cut-dim input-cut-width" 
                             id="cutWidth_${escapeHtml(item.sku)}" 
                             data-sku="${escapeHtml(item.sku)}" 
                             placeholder="Width (mm)">
                    </div>
                  </div>
                  <div class="cut-dim-error" id="cutErr_${escapeHtml(item.sku)}" style="display:none;"></div>
                </div>
              </div>
            </td>
            <td>
              ${canEditRemarks ? `
                <div class="catalog-remarks-cell-wrapper">
                  <textarea 
                    class="catalog-remarks-textarea" 
                    data-sku="${escapeHtml(item.sku)}" 
                    placeholder="Add remarks..." 
                    rows="2"
                    title="Directly edit Remarks for ${escapeHtml(item.sku)}"
                  >${escapeHtml(itemRemarks)}</textarea>
                  <div class="catalog-remarks-status" id="remarksStatus_${escapeHtml(item.sku)}"></div>
                </div>
              ` : `
                <div class="catalog-remarks-readonly" title="${escapeHtml(itemRemarks || '—')}">
                  ${escapeHtml(itemRemarks || '—')}
                </div>
              `}
            </td>
            <td>
              <div class="catalog-price-wrapper">
                ${canEditPrice ? `
                  <div class="price-input-group" id="priceGroup_${escapeHtml(item.sku)}">
                    <span class="price-currency-tag">IDR</span>
                    <input type="number" step="any" min="0" 
                           class="catalog-price-input" 
                           data-sku="${escapeHtml(item.sku)}" 
                           value="${(item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '') ? item.unitPrice : ''}" 
                           placeholder="${REQUIRE_UNIT_PRICE ? 'Required' : 'Optional'}" 
                           title="Edit Current Unit Price (IDR) for ${escapeHtml(item.sku)}">
                  </div>
                  <span class="catalog-price-unit">/ ${escapeHtml(item.unit || 'Unit')}</span>
                  <div class="catalog-price-status" id="priceStatus_${escapeHtml(item.sku)}"></div>
                ` : `
                  <div class="catalog-price-readonly">${DataService.formatUnitPrice(item.unitPrice, item.unit)}</div>
                `}
              </div>
            </td>
            <td>
              <div class="table-actions">
                <button class="btn btn-primary btn-sm btn-action-add-cart" data-sku="${escapeHtml(item.sku)}" title="Add material to PR Requisition Cart">
                  <span>+ Add to PR Cart</span>
                </button>
                <button class="btn btn-secondary btn-sm btn-action-specs" data-sku="${escapeHtml(item.sku)}" title="View Engineering Specifications & Full Description">
                  <span>Specs</span>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // Bind direct editing on Item Description textareas
      if (canEditDescription) {
        const debounceTimers = {};
        tbody.querySelectorAll('.catalog-desc-textarea').forEach(textarea => {
          const sku = textarea.getAttribute('data-sku');
          const statusEl = document.getElementById(`descStatus_${sku}`);

          const saveVal = async () => {
            const val = textarea.value;
            await DataService.updateMasterItemDescription(sku, val);
            textarea.classList.add('saved-flash');
            setTimeout(() => textarea.classList.remove('saved-flash'), 800);
            if (statusEl) {
              statusEl.innerHTML = '<span style="color:#10b981; font-weight:600;">✓ Saved</span>';
              setTimeout(() => {
                if (statusEl && statusEl.textContent.includes('Saved')) statusEl.innerHTML = '';
              }, 2500);
            }
          };

          textarea.addEventListener('input', () => {
            if (statusEl) statusEl.innerHTML = '<span style="color:#0284c7;">Editing...</span>';
            clearTimeout(debounceTimers[sku]);
            debounceTimers[sku] = setTimeout(saveVal, 600);
          });

          textarea.addEventListener('change', () => {
            clearTimeout(debounceTimers[sku]);
            saveVal();
          });

          textarea.addEventListener('blur', () => {
            clearTimeout(debounceTimers[sku]);
            saveVal();
          });
        });
      }

      // Bind interactive Status selects
      if (canEditStatus) {
        tbody.querySelectorAll('.catalog-status-select').forEach(selectEl => {
          const sku = selectEl.getAttribute('data-sku');
          const feedbackEl = document.getElementById(`statusFeedback_${sku}`);

          selectEl.addEventListener('change', async () => {
            const newStatus = selectEl.value;
            const statusClass = newStatus.toLowerCase().replace(/[\s_]+/g, '-');
            selectEl.className = `catalog-status-select status-val-${statusClass}`;

            try {
              await DataService.updateMasterItemStatus(sku, newStatus);
              selectEl.classList.add('saved-flash');
              setTimeout(() => selectEl.classList.remove('saved-flash'), 800);
              if (feedbackEl) {
                feedbackEl.innerHTML = '<span style="color:#10b981; font-weight:600;">✓ Saved</span>';
                setTimeout(() => {
                  if (feedbackEl && feedbackEl.textContent.includes('Saved')) feedbackEl.innerHTML = '';
                }, 2000);
              }
            } catch (err) {
              console.error('[Catalog UI] Error updating status:', err);
              if (feedbackEl) {
                feedbackEl.innerHTML = '<span style="color:#e11d48; font-weight:600;">Error</span>';
              }
            }
          });
        });
      }

      // Bind interactive Supply Type selects (Available to Employee and Admin)
      tbody.querySelectorAll('.catalog-supply-select').forEach(selectEl => {
        const sku = selectEl.getAttribute('data-sku');
        const badgeEl = document.getElementById(`supplyBadge_${sku}`);
        const cutPanelEl = document.getElementById(`cutPanel_${sku}`);
        const errEl = document.getElementById(`cutErr_${sku}`);

        selectEl.addEventListener('change', () => {
          const newSupply = selectEl.value;
          if (newSupply === 'Cut Size') {
            selectEl.className = 'catalog-supply-select supply-val-cut-size';
            if (badgeEl) {
              badgeEl.className = 'supply-badge cut-size';
              badgeEl.textContent = 'CUT SIZE';
            }
            if (cutPanelEl) {
              cutPanelEl.style.display = 'block';
              const lenInput = cutPanelEl.querySelector('.input-cut-length');
              if (lenInput) lenInput.focus();
            }
          } else {
            selectEl.className = 'catalog-supply-select supply-val-full-size';
            if (badgeEl) {
              badgeEl.className = 'supply-badge full-size';
              badgeEl.textContent = 'FULL SIZE';
            }
            if (cutPanelEl) {
              cutPanelEl.style.display = 'none';
            }
            if (errEl) {
              errEl.style.display = 'none';
              errEl.textContent = '';
            }
          }
        });
      });

      // Bind direct editing on Remarks textareas
      if (canEditRemarks) {
        const remarksDebounceTimers = {};
        tbody.querySelectorAll('.catalog-remarks-textarea').forEach(textarea => {
          const sku = textarea.getAttribute('data-sku');
          const statusEl = document.getElementById(`remarksStatus_${sku}`);

          const saveRemarks = async () => {
            const val = textarea.value;
            try {
              await DataService.updateMasterItemRemarks(sku, val);
              textarea.classList.add('saved-flash');
              setTimeout(() => textarea.classList.remove('saved-flash'), 800);
              if (statusEl) {
                statusEl.innerHTML = '<span style="color:#10b981; font-weight:600;">✓ Saved</span>';
                setTimeout(() => {
                  if (statusEl && statusEl.textContent.includes('Saved')) statusEl.innerHTML = '';
                }, 2500);
              }
            } catch (err) {
              console.error('[Catalog UI] Error saving remarks:', err);
              if (statusEl) {
                statusEl.innerHTML = '<span style="color:#e11d48; font-weight:600;">Save Failed</span>';
              }
            }
          };

          textarea.addEventListener('input', () => {
            if (statusEl) statusEl.innerHTML = '<span style="color:#0284c7;">Editing...</span>';
            clearTimeout(remarksDebounceTimers[sku]);
            remarksDebounceTimers[sku] = setTimeout(saveRemarks, 600);
          });

          textarea.addEventListener('change', () => {
            clearTimeout(remarksDebounceTimers[sku]);
            saveRemarks();
          });

          textarea.addEventListener('blur', () => {
            clearTimeout(remarksDebounceTimers[sku]);
            saveRemarks();
          });
        });
      }

      // Bind direct editing on Current Unit Price inputs
      if (canEditPrice) {
        const priceDebounceTimers = {};
        tbody.querySelectorAll('.catalog-price-input').forEach(inputEl => {
          const sku = inputEl.getAttribute('data-sku');
          const statusEl = document.getElementById(`priceStatus_${sku}`);
          const groupEl = document.getElementById(`priceGroup_${sku}`);

          const savePrice = async () => {
            const val = inputEl.value.trim();
            if (!val) {
              if (REQUIRE_UNIT_PRICE) {
                inputEl.classList.add('input-error');
                if (statusEl) {
                  statusEl.innerHTML = '<span style="color:#e11d48; font-weight:600; font-size:0.75rem;">Current Unit Price (IDR) is required.</span>';
                }
                return;
              }
              // Optional: clear price
              inputEl.classList.remove('input-error');
              try {
                await DataService.updateMasterItemPrice(sku, null);
                if (groupEl) {
                  groupEl.classList.add('saved-flash');
                  setTimeout(() => groupEl.classList.remove('saved-flash'), 800);
                }
                if (statusEl) {
                  statusEl.innerHTML = '<span style="color:#10b981; font-weight:600;">✓ Saved</span>';
                  setTimeout(() => {
                    if (statusEl && statusEl.textContent.includes('Saved')) statusEl.innerHTML = '';
                  }, 2500);
                }
              } catch (err) {
                inputEl.classList.add('input-error');
                if (statusEl) {
                  statusEl.innerHTML = `<span style="color:#e11d48; font-weight:600; font-size:0.75rem;">${escapeHtml(err.message || 'Failed to update price.')}</span>`;
                }
              }
              return;
            }

            const num = Number(val);
            if (isNaN(num) || !isFinite(num) || num < 0) {
              inputEl.classList.add('input-error');
              if (statusEl) {
                statusEl.innerHTML = '<span style="color:#e11d48; font-weight:600; font-size:0.75rem;">Current Unit Price (IDR) must be a valid positive number.</span>';
              }
              return;
            }
            inputEl.classList.remove('input-error');
            try {
              await DataService.updateMasterItemPrice(sku, val);
              if (groupEl) {
                groupEl.classList.add('saved-flash');
                setTimeout(() => groupEl.classList.remove('saved-flash'), 800);
              }
              if (statusEl) {
                statusEl.innerHTML = '<span style="color:#10b981; font-weight:600;">✓ Saved</span>';
                setTimeout(() => {
                  if (statusEl && statusEl.textContent.includes('Saved')) statusEl.innerHTML = '';
                }, 2500);
              }
            } catch (err) {
              inputEl.classList.add('input-error');
              if (statusEl) {
                statusEl.innerHTML = `<span style="color:#e11d48; font-weight:600; font-size:0.75rem;">${escapeHtml(err.message || 'Current Unit Price (IDR) is required.')}</span>`;
              }
            }
          };

          inputEl.addEventListener('input', () => {
            if (statusEl) statusEl.innerHTML = '<span style="color:#0284c7;">Editing...</span>';
            clearTimeout(priceDebounceTimers[sku]);
            priceDebounceTimers[sku] = setTimeout(savePrice, 600);
          });

          inputEl.addEventListener('change', () => {
            clearTimeout(priceDebounceTimers[sku]);
            savePrice();
          });

          inputEl.addEventListener('blur', () => {
            clearTimeout(priceDebounceTimers[sku]);
            savePrice();
          });
        });
      }

      // Bind row action buttons
      tbody.querySelectorAll('.btn-action-add-cart').forEach(btn => {
        btn.addEventListener('click', async () => {
          const sku = btn.getAttribute('data-sku');
          const descEl = tbody.querySelector(`.catalog-desc-textarea[data-sku="${sku}"]`);
          const priceEl = tbody.querySelector(`.catalog-price-input[data-sku="${sku}"]`);
          const remarksEl = tbody.querySelector(`.catalog-remarks-textarea[data-sku="${sku}"]`);
          if (canEditDescription && descEl) await DataService.updateMasterItemDescription(sku, descEl.value);
          if (canEditRemarks && remarksEl) await DataService.updateMasterItemRemarks(sku, remarksEl.value);
          if (canEditPrice && priceEl && priceEl.value.trim() && parseFloat(priceEl.value.trim()) > 0) {
            try { await DataService.updateMasterItemPrice(sku, priceEl.value.trim()); } catch (e) {}
          }
          const item = await DataService.getMasterItemBySku(sku);
          if (!item) return;

          // Check selected supply type and cut dimensions from row
          const supplySelect = document.getElementById(`supplySelect_${sku}`);
          const supplyType = supplySelect ? supplySelect.value : 'Full Size';
          const errEl = document.getElementById(`cutErr_${sku}`);

          let cutLength = '';
          let cutWidth = '';

          if (supplyType === 'Cut Size') {
            const lenInput = document.getElementById(`cutLength_${sku}`);
            const widInput = document.getElementById(`cutWidth_${sku}`);
            cutLength = lenInput ? lenInput.value.trim() : '';
            cutWidth = widInput ? widInput.value.trim() : '';

            // Validate cutLength is positive numeric
            const lenNum = Number(cutLength);
            if (!cutLength || isNaN(lenNum) || lenNum <= 0) {
              if (errEl) {
                errEl.textContent = 'Required Cut Length must be a positive numeric value.';
                errEl.style.display = 'block';
              }
              if (lenInput) {
                lenInput.classList.add('input-error');
                lenInput.focus();
              }
              UI.showToast('Validation Error', 'Required Cut Length must be a positive numeric value.');
              return;
            } else {
              if (lenInput) lenInput.classList.remove('input-error');
            }

            // Check if plate / sheet material
            const isPlateSheet = /plate|sheet|plat/i.test(`${item.productName || ''} ${item.itemDescription || ''} ${item.unit || ''} ${item.subCategory || ''} ${item.category || ''}`);
            if (isPlateSheet) {
              const widNum = Number(cutWidth);
              if (!cutWidth || isNaN(widNum) || widNum <= 0) {
                if (errEl) {
                  errEl.textContent = 'Required Cut Width is mandatory for plate/sheet materials (positive numeric).';
                  errEl.style.display = 'block';
                }
                if (widInput) {
                  widInput.classList.add('input-error');
                  widInput.focus();
                }
                UI.showToast('Validation Error', 'Required Cut Width is mandatory for plate/sheet materials.');
                return;
              } else {
                if (widInput) widInput.classList.remove('input-error');
              }
            } else if (cutWidth) {
              const widNum = Number(cutWidth);
              if (isNaN(widNum) || widNum <= 0) {
                if (errEl) {
                  errEl.textContent = 'Required Cut Width must be a positive numeric value.';
                  errEl.style.display = 'block';
                }
                if (widInput) {
                  widInput.classList.add('input-error');
                  widInput.focus();
                }
                UI.showToast('Validation Error', 'Required Cut Width must be a positive numeric value.');
                return;
              } else {
                if (widInput) widInput.classList.remove('input-error');
              }
            }

            if (errEl) {
              errEl.style.display = 'none';
              errEl.textContent = '';
            }
          }

          if (typeof PRCart !== 'undefined' && PRCart.addItem) {
            PRCart.addItem(item, {
              supplyType,
              originalDimensions: item.size || item.sizeDimensions || '—',
              cutLength,
              cutWidth
            });
          } else {
            this.openCreatePrModal(sku);
          }
        });
      });

      tbody.querySelectorAll('.btn-action-specs').forEach(btn => {
        btn.addEventListener('click', async () => {
          const sku = btn.getAttribute('data-sku');
          const descEl = tbody.querySelector(`.catalog-desc-textarea[data-sku="${sku}"]`);
          const priceEl = tbody.querySelector(`.catalog-price-input[data-sku="${sku}"]`);
          const remarksEl = tbody.querySelector(`.catalog-remarks-textarea[data-sku="${sku}"]`);
          if (canEditDescription && descEl) await DataService.updateMasterItemDescription(sku, descEl.value);
          if (canEditRemarks && remarksEl) await DataService.updateMasterItemRemarks(sku, remarksEl.value);
          if (canEditPrice && priceEl && priceEl.value.trim() && parseFloat(priceEl.value.trim()) > 0) {
            try { await DataService.updateMasterItemPrice(sku, priceEl.value.trim()); } catch (e) {}
          }
          this.openSpecsModal(sku);
        });
      });
    },

    // =========================================================================
    // 4. NEW SKU CREATION — SIMPLE DRAG & DROP WORKFLOW
    // =========================================================================
    _skuUploadedFile: null,

    openNewSkuModal() {
      if (!window.PermissionService || !window.PermissionService.can('CAN_CREATE_SKU')) {
        this.showAccessDeniedModal('Access Denied — Administrator permission required.');
        return;
      }
      const modal = document.getElementById('modalNewSku');
      if (!modal) return;

      // Reset state
      this._skuUploadedFile = null;
      this._skuPendingReplaceFile = null;
      this._skuShowStep('skuStep1');
      this._skuUpdateStepLabel(1);

      // Reset file UI (both Step 1 and Step 2)
      const fileInput = document.getElementById('skuFileInput');
      if (fileInput) fileInput.value = '';
      const fileInfo = document.getElementById('skuFileInfo');
      if (fileInfo) fileInfo.style.display = 'none';
      const fileInput2 = document.getElementById('skuFileInput2');
      if (fileInput2) fileInput2.value = '';
      const fileInfo2 = document.getElementById('skuFileInfo2');
      if (fileInfo2) fileInfo2.style.display = 'none';
      const extractBtn = document.getElementById('btnSkuExtract');
      if (extractBtn) extractBtn.disabled = true;
      const replaceConfirm = document.getElementById('skuReplaceConfirm');
      if (replaceConfirm) replaceConfirm.style.display = 'none';
      const notice = document.getElementById('skuExtractNotice');
      if (notice) notice.style.display = 'none';
      const progress = document.getElementById('skuExtractProgress');
      if (progress) progress.style.display = 'none';
      const errorBanner = document.getElementById('skuExtractError');
      if (errorBanner) errorBanner.style.display = 'none';
      const rawTextWrapper = document.getElementById('skuRawTextWrapper');
      if (rawTextWrapper) rawTextWrapper.style.display = 'none';
      const rawTextContent = document.getElementById('skuRawTextContent');
      if (rawTextContent) rawTextContent.textContent = '';

      // Reset form fields
      ['newSkuName','newSkuDescription','newSkuMaterial','newSkuSize','newSkuSpec','newSkuWeight','newSkuBrand','newSkuFinish','newSkuRemarks','newSkuPrice'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const statusSel = document.getElementById('newSkuStatus');
      if (statusSel) statusSel.value = 'Available';
      const cutSizeCheck = document.getElementById('newSkuIsCutSize');
      if (cutSizeCheck) cutSizeCheck.checked = false;
      const unitSel = document.getElementById('newSkuUnit');
      if (unitSel) unitSel.value = 'Sheet';
      const catSel = document.getElementById('newSkuCategory');
      if (catSel) catSel.value = this.currentCategory || 'Raw Materials';

      // Set next SKU
      const skuInput = document.getElementById('newSkuCode');
      if (skuInput) skuInput.value = DataService.getNextSuggestedSKU();

      // Clear duplicate banner
      const dup = document.getElementById('skuDuplicateAlert');
      if (dup) { dup.innerHTML = ''; dup.classList.remove('active'); }

      modal.classList.add('active');
    },

    initNewSkuWorkflow() {
      // Prevent browser default file-opening behavior when dropping anywhere
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        window.addEventListener(eventName, (e) => {
          e.preventDefault();
        }, false);
      });

      // Dropzone 1 (Step 1)
      const dropzone = document.getElementById('skuDropzone');
      const fileInput = document.getElementById('skuFileInput');
      const browseBtn = document.getElementById('skuBrowseBtn');

      if (dropzone && fileInput) {
        dropzone.addEventListener('click', () => fileInput.click());
        browseBtn?.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });

        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
        dropzone.addEventListener('drop', (e) => {
          e.preventDefault();
          dropzone.classList.remove('drag-over');
          if (e.dataTransfer.files.length) this._skuHandleFile(e.dataTransfer.files[0]);
        });

        fileInput.addEventListener('change', () => {
          if (fileInput.files.length) this._skuHandleFile(fileInput.files[0]);
        });
      }

      // Remove file from Step 1
      document.getElementById('skuFileRemove')?.addEventListener('click', () => {
        this._skuUploadedFile = null;
        this._skuPendingReplaceFile = null;
        this._skuClearFileDisplay();
      });

      // Step navigation
      document.getElementById('btnSkuSkipUpload')?.addEventListener('click', () => {
        this._skuShowStep('skuStep2');
        this._skuUpdateStepLabel(2);
      });

      document.getElementById('btnSkuExtract')?.addEventListener('click', async () => {
        this._skuShowStep('skuStep2');
        this._skuUpdateStepLabel(2);
        await this._skuExtractFromFile();
      });

      document.getElementById('btnSkuBackTo1')?.addEventListener('click', () => {
        this._skuShowStep('skuStep1');
        this._skuUpdateStepLabel(1);
      });

      document.getElementById('btnSkuToReview')?.addEventListener('click', () => {
        if (!this._skuValidateForm()) return;
        this._skuRunDuplicateCheck().then(canProceed => {
          if (canProceed) {
            this._skuRenderReview();
            this._skuShowStep('skuStep3');
            this._skuUpdateStepLabel(3);
          }
        });
      });

      document.getElementById('btnSkuBackTo2')?.addEventListener('click', () => {
        this._skuShowStep('skuStep2');
        this._skuUpdateStepLabel(2);
      });

      document.getElementById('btnSkuConfirmCreate')?.addEventListener('click', () => {
        this._skuConfirmCreate();
      });

      document.getElementById('btnSkuCreatePr')?.addEventListener('click', () => {
        const sku = document.getElementById('skuSuccessSku')?.textContent?.replace('SKU: ', '');
        this.closeAllModals();
        if (sku) this.openCreatePrModal(sku);
      });

      document.getElementById('btnSkuBackToCatalog')?.addEventListener('click', () => {
        this.closeAllModals();
        this.updateDashboardStats();
        this.renderMasterCatalogTable();
      });

      // --- Step 2 compact dropzone ---
      const dropzone2 = document.getElementById('skuDropzone2');
      const fileInput2 = document.getElementById('skuFileInput2');
      const browseBtn2 = document.getElementById('skuBrowseBtn2');

      if (dropzone2 && fileInput2) {
        dropzone2.addEventListener('click', () => fileInput2.click());
        browseBtn2?.addEventListener('click', (e) => { e.stopPropagation(); fileInput2.click(); });

        dropzone2.addEventListener('dragover', (e) => { e.preventDefault(); dropzone2.classList.add('drag-over'); });
        dropzone2.addEventListener('dragleave', () => dropzone2.classList.remove('drag-over'));
        dropzone2.addEventListener('drop', (e) => {
          e.preventDefault();
          dropzone2.classList.remove('drag-over');
          if (e.dataTransfer.files.length) this._skuHandleStep2File(e.dataTransfer.files[0]);
        });

        fileInput2.addEventListener('change', () => {
          if (fileInput2.files.length) this._skuHandleStep2File(fileInput2.files[0]);
        });
      }

      // Remove file from Step 2
      document.getElementById('skuFileRemove2')?.addEventListener('click', () => {
        this._skuUploadedFile = null;
        this._skuPendingReplaceFile = null;
        this._skuClearFileDisplay();
      });

      // Replace file confirmation buttons
      document.getElementById('btnReplaceCancel')?.addEventListener('click', () => {
        this._skuPendingReplaceFile = null;
        const rc = document.getElementById('skuReplaceConfirm');
        if (rc) rc.style.display = 'none';
      });

      document.getElementById('btnReplaceConfirm')?.addEventListener('click', async () => {
        if (this._skuPendingReplaceFile) {
          this._skuUploadedFile = this._skuPendingReplaceFile;
          this._skuPendingReplaceFile = null;
          const rc = document.getElementById('skuReplaceConfirm');
          if (rc) rc.style.display = 'none';
          this._skuUpdateStep2FileInfo();
          await this._skuExtractFromFile();
        }
      });

      // Copy extracted text button
      document.getElementById('btnCopyExtractedText')?.addEventListener('click', () => {
        const text = document.getElementById('skuRawTextContent')?.textContent;
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('btnCopyExtractedText');
            if (btn) {
              const old = btn.textContent;
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = old; }, 1500);
            }
          }).catch(err => {
            console.error('Clipboard copy failed:', err);
          });
        }
      });
    },

    _skuPendingReplaceFile: null,

    _skuClearFileDisplay() {
      ['skuFileInfo', 'skuFileInfo2'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      ['skuFileInput', 'skuFileInput2'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const eb = document.getElementById('btnSkuExtract');
      if (eb) eb.disabled = true;
      const rc = document.getElementById('skuReplaceConfirm');
      if (rc) rc.style.display = 'none';
      const notice = document.getElementById('skuExtractNotice');
      if (notice) notice.style.display = 'none';
      const progress = document.getElementById('skuExtractProgress');
      if (progress) progress.style.display = 'none';
      const errorBanner = document.getElementById('skuExtractError');
      if (errorBanner) errorBanner.style.display = 'none';
    },

    async _skuHandleStep2File(file) {
      // If a file is already uploaded, prompt to replace
      if (this._skuUploadedFile) {
        this._skuPendingReplaceFile = file;
        const rc = document.getElementById('skuReplaceConfirm');
        if (rc) rc.style.display = 'flex';
        return;
      }
      this._skuUploadedFile = file;
      this._skuUpdateStep2FileInfo();
      await this._skuExtractFromFile();
    },

    _skuUpdateStep2FileInfo() {
      const fi2 = document.getElementById('skuFileInfo2');
      const fn2 = document.getElementById('skuFileName2');
      if (fi2 && this._skuUploadedFile) {
        fi2.style.display = 'flex';
        if (fn2) fn2.textContent = `📎 ${this._skuUploadedFile.name} (${(this._skuUploadedFile.size / 1024).toFixed(1)} KB)`;
      }
      // Also update Step 1 display
      const fi1 = document.getElementById('skuFileInfo');
      const fn1 = document.getElementById('skuFileName');
      const eb = document.getElementById('btnSkuExtract');
      if (fi1 && this._skuUploadedFile) {
        fi1.style.display = 'flex';
        if (fn1) fn1.textContent = `📎 ${this._skuUploadedFile.name} (${(this._skuUploadedFile.size / 1024).toFixed(1)} KB)`;
      }
      if (eb) eb.disabled = false;
    },

    _skuShowStep(stepId) {
      ['skuStep1','skuStep2','skuStep3','skuStepSuccess'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === stepId) ? 'block' : 'none';
      });
    },

    _skuUpdateStepLabel(num) {
      const label = document.getElementById('newSkuStepLabel');
      if (!label) return;
      const labels = {
        1: 'Step 1 of 3 — Upload Reference File',
        2: 'Step 2 of 3 — Material Details',
        3: 'Step 3 of 3 — Review & Confirm',
        4: 'Complete'
      };
      label.textContent = labels[num] || '';
    },

    _skuHandleFile(file) {
      this._skuUploadedFile = file;
      this._skuUpdateStep2FileInfo();
    },

    _skuSetProgress(mainText, subText) {
      const prog = document.getElementById('skuExtractProgress');
      const textEl = document.getElementById('skuProgressText');
      const subEl = document.getElementById('skuProgressSubtext');
      if (prog) prog.style.display = 'flex';
      if (textEl && mainText) textEl.textContent = mainText;
      if (subEl && subText) subEl.textContent = subText;
      const err = document.getElementById('skuExtractError');
      if (err) err.style.display = 'none';
    },

    // =========================================================================
    // DOCUMENT EXTRACTION & OCR ENGINE
    // =========================================================================
    async _skuExtractFromFile() {
      if (!this._skuUploadedFile) return;

      const file = this._skuUploadedFile;
      const name = file.name.toLowerCase();
      const mime = file.type || '';

      // [FILE UPLOAD] Debug Console Logging
      console.log(`[FILE UPLOAD]\nfilename: ${file.name}\nfile type: ${mime || 'unknown'}\nfile size: ${file.size} bytes`);

      // Progress: Step 1 - Reading file
      this._skuSetProgress('Reading file...', `Loading ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`);

      let extractedText = '';
      let method = 'Unknown';
      let extraData = {};

      try {
        // Method A: Images (JPG, JPEG, PNG, WEBP, BMP, TIFF) -> Browser OCR via Tesseract.js
        if (mime.startsWith('image/') || /\.(jpe?g|png|bmp|webp|tiff?)$/i.test(name)) {
          method = 'Browser OCR (Tesseract.js)';
          extractedText = await this._skuProcessImage(file);
        }
        // Method B: PDF Documents -> PDF.js (Text stream + Scanned Canvas OCR)
        else if (mime === 'application/pdf' || name.endsWith('.pdf')) {
          method = 'PDF Document Parser (PDF.js)';
          extractedText = await this._skuProcessPdf(file);
        }
        // Method C: Excel Workbooks (XLSX, XLS) -> SheetJS
        else if (name.endsWith('.xlsx') || name.endsWith('.xls') || mime.includes('spreadsheet') || mime.includes('excel')) {
          method = 'Excel Workbook Parser (SheetJS)';
          const res = await this._skuProcessExcel(file);
          extractedText = res.fullText;
          extraData = res;
        }
        // Method D: Delimited text, CSV, TSV, JSON, TXT
        else {
          method = 'Plain Text / CSV Parser';
          extractedText = await file.text();
        }

        // [EXTRACTION] Debug Console Logging
        console.log(`[EXTRACTION]\nextraction started\nextraction method: ${method}\nextracted text length: ${extractedText.length}`);

        // Progress: Step 3 - Identifying material details
        this._skuSetProgress('Identifying material details...', 'Parsing specifications, dimensions, weight, and grade...');

        // Map extracted text to fields
        const mapped = this._skuParseTextForFields(extractedText, method, extraData);

        // [FIELD MAPPING] Debug Console Logging
        console.log(`[FIELD MAPPING]\nproduct name: ${mapped.productName || '(empty)'}\nmaterial: ${mapped.material || '(empty)'}\nsize: ${mapped.size || '(empty)'}\nspecification: ${mapped.spec || '(empty)'}\nunit: ${mapped.unit || '(empty)'}\nweight: ${mapped.weight || '(empty)'}\nbrand: ${mapped.brand || '(empty)'}\nfinish: ${mapped.finish || '(empty)'}`);

        // Update raw extracted text drawer
        const rawWrapper = document.getElementById('skuRawTextWrapper');
        const rawBadge = document.getElementById('skuRawTextBadge');
        const rawMeta = document.getElementById('skuRawTextMeta');
        const rawContent = document.getElementById('skuRawTextContent');

        if (rawWrapper) rawWrapper.style.display = 'block';
        if (rawBadge) rawBadge.textContent = `${extractedText.length} chars`;
        if (rawMeta) rawMeta.textContent = `Method: ${method} • Source: ${file.name}`;
        if (rawContent) rawContent.textContent = extractedText || '(No text could be extracted)';

        // Progress: Complete -> show notice
        const prog = document.getElementById('skuExtractProgress');
        if (prog) prog.style.display = 'none';

        const notice = document.getElementById('skuExtractNotice');
        if (notice) {
          notice.textContent = '⚠️ Extracted from reference file — Please verify';
          notice.style.display = 'block';
        }

        const err = document.getElementById('skuExtractError');
        if (err) err.style.display = 'none';

      } catch (err) {
        console.error('[EXTRACTION FAILED]', err);
        const prog = document.getElementById('skuExtractProgress');
        if (prog) prog.style.display = 'none';

        const errBanner = document.getElementById('skuExtractError');
        if (errBanner) {
          errBanner.textContent = '⚠️ Unable to extract details from this file. Please enter the information manually.';
          errBanner.style.display = 'block';
        }

        const notice = document.getElementById('skuExtractNotice');
        if (notice) notice.style.display = 'none';
      }
    },

    async _skuProcessImage(fileOrCanvas) {
      this._skuSetProgress('Extracting text with OCR...', 'Scanning document text and tables via Tesseract.js...');

      if (typeof Tesseract === 'undefined') {
        throw new Error('Tesseract.js OCR library is not loaded');
      }

      // Optimize image resolution if it is a large photo
      let imageSource = fileOrCanvas;
      if (fileOrCanvas instanceof Blob || fileOrCanvas instanceof File) {
        try {
          imageSource = await this._skuOptimizeImageForOcr(fileOrCanvas);
        } catch (e) {
          console.warn('Image optimization skipped, using raw file:', e);
          imageSource = fileOrCanvas;
        }
      }

      // Worker options for local serving with CDN fallback
      const workerOptions = {};
      if (window.location.protocol.startsWith('http')) {
        workerOptions.workerPath = window.location.origin + '/assets/libs/worker.min.js';
        workerOptions.corePath = window.location.origin + '/assets/libs/tesseract-core.wasm.js';
        workerOptions.langPath = window.location.origin + '/assets/libs';
      }

      let result;
      try {
        result = await Tesseract.recognize(imageSource, 'eng', {
          ...workerOptions,
          logger: m => {
            if (m.status === 'recognizing text' && m.progress) {
              const pct = Math.round(m.progress * 100);
              this._skuSetProgress('Extracting text with OCR...', `Processing image text: ${pct}% complete`);
            }
          }
        });
      } catch (localErr) {
        console.warn('Local OCR worker failed, falling back to CDN worker:', localErr);
        result = await Tesseract.recognize(imageSource, 'eng', {
          logger: m => {
            if (m.status === 'recognizing text' && m.progress) {
              const pct = Math.round(m.progress * 100);
              this._skuSetProgress('Extracting text with OCR...', `Processing image text: ${pct}% complete`);
            }
          }
        });
      }

      return result?.data?.text || '';
    },

    async _skuOptimizeImageForOcr(file) {
      return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(url);
          const maxDim = 2000;
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (w > maxDim || h > maxDim) {
            const ratio = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(file);
        };
        img.src = url;
      });
    },

    async _skuProcessPdf(file) {
      this._skuSetProgress('Extracting text from PDF...', 'Reading PDF document streams...');
      if (typeof pdfjsLib === 'undefined') {
        throw new Error('PDF.js library is not loaded');
      }

      if (window.location.protocol.startsWith('http')) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = window.location.origin + '/assets/libs/pdf.worker.min.js';
      }

      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = '';
      const numPages = Math.min(pdf.numPages, 5);

      for (let i = 1; i <= numPages; i++) {
        this._skuSetProgress('Extracting text from PDF...', `Reading page ${i} of ${numPages}...`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += `--- Page ${i} ---\n` + pageText + '\n';
      }

      // If little or no text found, it is a scanned/image PDF -> render canvas and run OCR
      if (fullText.replace(/--- Page \d+ ---|\s/g, '').length < 30) {
        this._skuSetProgress('Extracting text with OCR...', 'Scanned PDF detected. Rendering page for OCR...');
        const firstPage = await pdf.getPage(1);
        const viewport = firstPage.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await firstPage.render({ canvasContext: ctx, viewport }).promise;
        
        fullText = await this._skuProcessImage(canvas);
      }

      return fullText;
    },

    async _skuProcessExcel(file) {
      this._skuSetProgress('Extracting workbook data...', 'Reading worksheets and catalog tables...');
      if (typeof XLSX === 'undefined') {
        throw new Error('SheetJS (XLSX) library is not loaded');
      }

      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      let fullText = '';
      const sheetDataList = [];

      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (rows && rows.length > 0) {
          sheetDataList.push({ sheetName, rows });
          fullText += `=== Sheet: ${sheetName} ===\n`;
          rows.slice(0, 30).forEach(row => {
            const line = row.map(c => String(c).trim()).filter(Boolean).join(' | ');
            if (line) fullText += line + '\n';
          });
          fullText += '\n';
        }
      });

      return { fullText, sheetDataList };
    },

    _skuParseTextForFields(text, method, extraData) {
      const mapped = {
        productName: '',
        material: '',
        size: '',
        spec: '',
        unit: '',
        weight: '',
        brand: '',
        finish: '',
        remarks: ''
      };

      if (!text || !text.trim()) return mapped;

      const setVal = (id, val, mappedKey) => {
        if (val && String(val).trim()) {
          const cleanVal = String(val).trim();
          mapped[mappedKey] = cleanVal;
          const el = document.getElementById(id);
          if (el) el.value = cleanVal;
        }
      };

      // -----------------------------------------------------------------------
      // Special Excel workbook handling: use structured sheet names and column data
      // -----------------------------------------------------------------------
      if (extraData && extraData.sheetDataList && extraData.sheetDataList.length > 0) {
        const firstSheet = extraData.sheetDataList[0];
        const sheetName = firstSheet.sheetName || '';
        const rows = firstSheet.rows || [];

        // Set Product Name from Sheet Name
        let pName = sheetName;
        if (pName.endsWith('s') && !pName.endsWith('ss') && !pName.endsWith('us')) {
          pName = pName.replace(/s$/, ''); // e.g. Marine Plates -> Marine Plate
        }
        setVal('newSkuName', pName, 'productName');

        // Check if rows have headers
        if (rows.length >= 2) {
          const headers = rows[0].map(h => String(h).trim().toLowerCase());
          const dataRow = rows[1];

          let thickness = '';
          let width = '';
          let length = '';
          let sizeVal = '';
          let weightVal = '';

          headers.forEach((h, idx) => {
            const val = dataRow[idx];
            if (val === undefined || val === '') return;

            if (h.includes('thick')) {
              thickness = String(val).trim() + (h.includes('mm') && !String(val).includes('mm') ? 'mm' : '');
            } else if (h.includes('width')) {
              width = String(val).trim() + (h.includes('ft') && !String(val).includes('ft') ? 'ft' : '');
            } else if (h.includes('length')) {
              length = String(val).trim() + (h.includes('ft') ? 'ft' : (h.includes('m') ? 'm' : ''));
            } else if (h.includes('size') || h.includes('diam')) {
              sizeVal = String(val).trim();
            } else if (h.includes('weight') || h.includes('berat')) {
              weightVal = String(val).trim();
            } else if (h.includes('grade') || h.includes('material')) {
              setVal('newSkuMaterial', String(val), 'material');
            } else if (h.includes('spec') || h.includes('standard')) {
              setVal('newSkuSpec', String(val), 'spec');
            }
          });

          // Build size
          if (thickness && width && length) {
            setVal('newSkuSize', `${thickness} × ${width} × ${length}`, 'size');
          } else if (sizeVal && length) {
            setVal('newSkuSize', `${sizeVal} × ${length}`, 'size');
          } else if (sizeVal) {
            setVal('newSkuSize', sizeVal, 'size');
          }

          if (weightVal) {
            const num = weightVal.replace(/[^0-9.]/g, '');
            if (num) setVal('newSkuWeight', num, 'weight');
          }
        }
      }

      // -----------------------------------------------------------------------
      // General Catalogue Text Parsing (OCR, PDF, Text, CSV)
      // -----------------------------------------------------------------------
      const cleanText = text.replace(/\r/g, '');
      const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);

      // 1. Brand Detection
      const brandMatches = [
        { regex: /FZ[\s\-_]*LOCK/i, name: 'FZ-Lock' },
        { regex: /PT[\s\.]+PERSADA\s+NUSANTARA\s+STEEL/i, name: 'PT Persada Nusantara Steel' },
        { regex: /KAIROS(?:BAUT)?/i, name: 'PT Kairos Multi Sejahtera' },
        { regex: /FLOW[\s\-_]*FORCE/i, name: 'Flow Force' }
      ];
      for (const b of brandMatches) {
        if (b.regex.test(cleanText)) {
          setVal('newSkuBrand', b.name, 'brand');
          break;
        }
      }

      // 2. Specification Detection
      const specMatch = cleanText.match(/\b(DIN\s*\d+[A-Z]?|ASTM\s+[A-Z0-9]+|JIS\s+[A-Z0-9]+|SNI\s*[0-9:]+|ISO\s*\d+|BS\s*\d+)\b/i);
      if (specMatch) {
        setVal('newSkuSpec', specMatch[1].toUpperCase(), 'spec');
      } else if (/TAPER[\s\-_]*LOCK\s+BUSH\s+DIMENSIONS/i.test(cleanText)) {
        setVal('newSkuSpec', 'Taperlock Bush Dimensions', 'spec');
      }

      // 3. Product Name Detection
      const productTypes = [
        { regex: /TAPER[\s\-_]*LOCK\s+BUSH/i, name: 'Taperlock Bush' },
        { regex: /FLAT\s+WASHER/i, name: 'Flat Washer' },
        { regex: /SPRING\s+LOCK\s+WASHER/i, name: 'Spring Lock Washer' },
        { regex: /HEX\s+BOLT(?:\s+FULL\s+THREAD)?/i, name: 'Hex Bolt Full Thread' },
        { regex: /U[\s\-_]*BOLT/i, name: 'U Bolt' },
        { regex: /MARINE\s+PLATE/i, name: 'Marine Plate' },
        { regex: /CHECKERED\s+PLATE/i, name: 'Checkered Plate' },
        { regex: /WIDE\s+FLANGE\s+BEAM/i, name: 'Wide Flange Beam' },
        { regex: /U[\s\-_]*CHANNEL/i, name: 'U Channel' },
        { regex: /EQUAL\s+ANGLE/i, name: 'Equal Angle' },
        { regex: /ROUND\s+BAR/i, name: 'Round Bar' },
        { regex: /DEFORMED\s+BAR/i, name: 'Deformed Bar' },
        { regex: /SQUARE\s+TUBE/i, name: 'Square Tube' },
        { regex: /PIPE\s+SCH\s*80/i, name: 'Pipe SCH 80' },
        { regex: /WIRE\s+MESH/i, name: 'Wire Mesh' }
      ];

      for (const pt of productTypes) {
        if (pt.regex.test(cleanText)) {
          let fullName = pt.name;
          const currentSpec = mapped.spec || document.getElementById('newSkuSpec')?.value?.trim();
          const currentBrand = mapped.brand || document.getElementById('newSkuBrand')?.value?.trim();
          if (currentSpec && currentSpec.startsWith('DIN') && !fullName.includes('DIN')) {
            fullName = `${currentSpec} ${fullName}`;
          } else if (currentBrand && currentBrand === 'FZ-Lock' && !fullName.includes('FZ-Lock')) {
            fullName = `FZ-Lock ${fullName}`;
          }
          setVal('newSkuName', fullName, 'productName');
          break;
        }
      }

      // Fallback for Product Name: if line 0 or 1 looks like title
      if (!mapped.productName && lines.length > 0) {
        for (let i = 0; i < Math.min(3, lines.length); i++) {
          if (lines[i].length > 3 && !/^(?:grade|size|for|dia|table|weight|berat)/i.test(lines[i])) {
            setVal('newSkuName', lines[i], 'productName');
            break;
          }
        }
      }

      // 4. Material / Grade Detection
      const gradeLine = lines.find(l => /^Grade\b/i.test(l));
      if (gradeLine) {
        let g = gradeLine.replace(/^Grade[:\s]*/i, '').trim();
        if (/^[A-Z]$/.test(g)) g = 'Grade ' + g;
        setVal('newSkuMaterial', g, 'material');
      } else {
        const gradeMatch = cleanText.match(/\b(SS304|SS316|SS400|SS41|Grade\s+[A-Z0-9]+|4\.6|8\.8|10\.9|12\.9|ST41|S45C|A36|Q235)\b/i);
        if (gradeMatch) {
          setVal('newSkuMaterial', gradeMatch[0].trim(), 'material');
        }
      }

      // 5. Size / Dimensions Detection
      const bushMatch = cleanText.match(/\b(1008\s*-\s*3030|\b(?:1008|1108|1210|1610|1615|2012|2517|3020|3030)\b)/i);
      const boltMatch = cleanText.match(/\b(M\d+(?:\s*[xX]\s*\d+)?)\b/);
      const inchMatch = cleanText.match(/\b(\d+(?:\s*\d+\/\d+|\/\d+)?\s*(?:inch|"))\b/i);
      const dimMatch = cleanText.match(/\b(\d+(?:\.\d+)?\s*(?:mm)?\s*[xX×*]\s*\d+(?:\.\d+)?\s*(?:ft|m|mm)?(?:\s*[xX×*]\s*\d+(?:\.\d+)?\s*(?:ft|m|mm)?)?)\b/);

      if ((mapped.productName || '').includes('Bush') && bushMatch) {
        setVal('newSkuSize', bushMatch[1], 'size');
      } else if (dimMatch && /(?:Plate|Sheet|Beam|Tube|Channel|Angle)/i.test(mapped.productName || cleanText)) {
        setVal('newSkuSize', dimMatch[1], 'size');
      } else if (boltMatch) {
        setVal('newSkuSize', boltMatch[1], 'size');
      } else if (inchMatch) {
        setVal('newSkuSize', inchMatch[1], 'size');
      } else if (bushMatch) {
        setVal('newSkuSize', bushMatch[1], 'size');
      }

      // 6. Weight Detection
      const weightValMatch = cleanText.match(/(?:weight|berat|gram|kg|pcs)[^\d\n]*(\d+(?:[\.,]\d+)?)/i) ||
                            cleanText.match(/\b(\d+(?:[\.,]\d+)?)\s*(?:kg|gram|g\/pc|kg\/pc)\b/i);
      if (weightValMatch) {
        const rawNum = weightValMatch[1].replace(',', '.');
        if (!isNaN(parseFloat(rawNum))) {
          setVal('newSkuWeight', rawNum, 'weight');
        }
      }

      // 7. Standard Unit / UOM Selection
      const unitSel = document.getElementById('newSkuUnit');
      if (unitSel) {
        if (/Plate|Sheet|Mesh/i.test(mapped.productName || '')) {
          unitSel.value = 'Sheet';
          mapped.unit = 'Sheet';
        } else if (/Beam|Channel|Angle|Bar|Pipe|Tube/i.test(mapped.productName || '')) {
          unitSel.value = 'Length';
          mapped.unit = 'Length';
        } else if (/Washer|Bolt|Bush|Fastener|Nut|Screw/i.test(mapped.productName || '')) {
          unitSel.value = 'PCS';
          mapped.unit = 'PCS';
        }
      }

      // 8. Finish / Coating Detection
      const finishMatch = cleanText.match(/\b(Zinc\s+Plated|Galvanized|Hot\s+Dip\s+Galvanized|HDG|Black\s+Oxide|Full\s+Thread|Stainless\s+Steel)\b/i);
      if (finishMatch) {
        setVal('newSkuFinish', finishMatch[1], 'finish');
      }

      // 9. Initial Multiline Item Description Auto-Composition (if not already filled)
      const descEl = document.getElementById('newSkuDescription');
      if (descEl && (!descEl.value || descEl.value.trim() === '')) {
        const descLines = [
          mapped.productName || '',
          mapped.material ? `Material / Grade: ${mapped.material}` : '',
          mapped.size ? `Dimensions: ${mapped.size}` : '',
          mapped.specification ? `Specification: ${mapped.specification}` : '',
          mapped.brand ? `Manufacturer / Brand: ${mapped.brand}` : '',
          mapped.finish ? `Finish / Coating: ${mapped.finish}` : ''
        ].filter(Boolean);
        if (descLines.length > 0) {
          descEl.value = descLines.join('\n');
          mapped.itemDescription = descEl.value;
        }
      }

      return mapped;
    },

    _skuValidateForm() {
      const required = [
        { id: 'newSkuName', label: 'Product Name' },
        { id: 'newSkuDescription', label: 'Item Description' },
        { id: 'newSkuMaterial', label: 'Material / Grade' },
        { id: 'newSkuSize', label: 'Size / Dimensions' },
        { id: 'newSkuSpec', label: 'Specification' },
        { id: 'newSkuWeight', label: 'Theoretical Weight' },
      ];

      for (const f of required) {
        const el = document.getElementById(f.id);
        if (!el || !el.value.trim()) {
          alert(`Please enter: ${f.label}`);
          el?.focus();
          return false;
        }
      }

      const priceEl = document.getElementById('newSkuPrice');
      const rawPrice = priceEl ? priceEl.value.trim() : '';
      if (!rawPrice) {
        if (REQUIRE_UNIT_PRICE) {
          alert('Current Unit Price (IDR) is required.');
          priceEl?.focus();
          return false;
        }
      } else {
        const priceNum = Number(rawPrice);
        if (isNaN(priceNum) || !isFinite(priceNum) || priceNum < 0) {
          alert('Current Unit Price (IDR) must be a valid positive number.');
          priceEl?.focus();
          return false;
        }
      }

      return true;
    },

    async _skuRunDuplicateCheck() {
      const sku = document.getElementById('newSkuCode')?.value?.trim();
      const name = document.getElementById('newSkuName')?.value?.trim();
      const material = document.getElementById('newSkuMaterial')?.value?.trim();
      const size = document.getElementById('newSkuSize')?.value?.trim();
      const spec = document.getElementById('newSkuSpec')?.value?.trim();
      const banner = document.getElementById('skuDuplicateAlert');

      if (!sku) return false;

      // Check exact SKU duplicate
      const dupCheck = await DataService.checkDuplicate(sku, name);
      if (dupCheck.isDuplicateSku) {
        if (banner) {
          banner.classList.add('active');
          banner.innerHTML = `
            <div class="alert-icon">⚠️</div>
            <div class="alert-content">
              <h4>Duplicate SKU Detected (${escapeHtml(sku)})</h4>
              <p>This SKU already exists: <strong>${escapeHtml(dupCheck.duplicateSkuItem.productName)}</strong>. Cannot create duplicate.</p>
            </div>
          `;
        }
        return false;
      }

      // Check for similar existing items by name + material + size + spec
      const allItems = await DataService.getAllMasterItems();
      const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const similar = allItems.find(item => {
        const nameMatch = normalize(item.productName) === normalize(name);
        const matMatch = normalize(item.material) === normalize(material);
        const sizeMatch = normalize(item.size) === normalize(size);
        // If name + material + size all match, it's likely a duplicate
        return nameMatch && matMatch && sizeMatch;
      });

      if (similar) {
        if (banner) {
          banner.classList.add('active');
          banner.innerHTML = `
            <div class="alert-icon">⚠️</div>
            <div class="alert-content">
              <h4>Possible Existing Master Item Found</h4>
              <p>An existing item matches this entry:</p>
              <p style="margin:0.5rem 0;"><strong>${escapeHtml(similar.sku)}</strong> — ${escapeHtml(similar.productName)}<br>
              ${escapeHtml(similar.material || '')} | ${escapeHtml(similar.size || '')}</p>
              <p>Please review the existing item before creating a duplicate.</p>
              <div style="margin-top:0.5rem;">
                <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('skuDuplicateAlert').classList.remove('active');document.getElementById('skuDuplicateAlert').innerHTML='';">Proceed Anyway</button>
              </div>
            </div>
          `;
        }
        return false;
      }

      // Clear any previous alerts
      if (banner) { banner.classList.remove('active'); banner.innerHTML = ''; }
      return true;
    },

    _skuRenderReview() {
      const card = document.getElementById('skuReviewCard');
      if (!card) return;

      const fields = [
        { label: 'SKU', id: 'newSkuCode' },
        { label: 'Product Name', id: 'newSkuName' },
        { label: 'Item Description', id: 'newSkuDescription', multiline: true },
        { label: 'Material / Grade', id: 'newSkuMaterial' },
        { label: 'Size / Dimensions', id: 'newSkuSize' },
        { label: 'Specification', id: 'newSkuSpec' },
        { label: 'Unit / UOM', id: 'newSkuUnit' },
        { label: 'Weight', id: 'newSkuWeight' },
        { label: 'Current Unit Price (IDR)', id: 'newSkuPrice', isPrice: true },
        { label: 'Manufacturer / Brand', id: 'newSkuBrand' },
        { label: 'Finish / Coating', id: 'newSkuFinish' },
        { label: 'Status', id: 'newSkuStatus' },
        { label: 'Supply Type', id: 'newSkuSupplyType' },
        { label: 'Remarks', id: 'newSkuRemarks' },
      ];

      let rows = fields.map(f => {
        const el = document.getElementById(f.id);
        let val = el ? (el.value || '—') : '—';
        if (f.isPrice) {
          if (val !== '—' && val !== '' && !isNaN(Number(val)) && Number(val) >= 0) {
            val = `IDR ${Number(val).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
          } else {
            val = '—';
          }
        }
        return `<div class="sku-review-row">
          <div class="sku-review-label">${f.label}</div>
          <div class="sku-review-value" style="${f.multiline ? 'white-space:pre-wrap; line-height:1.5;' : ''}">${escapeHtml(val)}</div>
        </div>`;
      }).join('');

      card.innerHTML = `<h4>NEW MASTER ITEM REVIEW</h4>${rows}`;
    },

    async _skuConfirmCreate() {
      if (!window.PermissionService || !window.PermissionService.can('CAN_CREATE_SKU')) {
        this.showAccessDeniedModal('Access Denied — Administrator permission required.');
        return;
      }
      const sku = document.getElementById('newSkuCode')?.value?.trim();
      const productName = document.getElementById('newSkuName')?.value?.trim();
      const itemDescription = document.getElementById('newSkuDescription')?.value?.trim() || '';
      const material = document.getElementById('newSkuMaterial')?.value?.trim();
      const size = document.getElementById('newSkuSize')?.value?.trim();
      const spec = document.getElementById('newSkuSpec')?.value?.trim();
      const unit = document.getElementById('newSkuUnit')?.value?.trim() || 'PCS';
      const weightKg = parseFloat(document.getElementById('newSkuWeight')?.value) || 0;
      const brand = document.getElementById('newSkuBrand')?.value?.trim() || '';
      const finish = document.getElementById('newSkuFinish')?.value?.trim() || '';
      const statusRaw = document.getElementById('newSkuStatus')?.value?.trim() || 'Available';
      const status = (statusRaw === 'Out of Stock') ? 'Out of Stock' : 'Available';
      const supplyTypeRaw = document.getElementById('newSkuSupplyType')?.value?.trim() || 'Full Size';
      const supplyType = (supplyTypeRaw === 'Cut Size') ? 'Cut Size' : 'Full Size';
      const remarks = document.getElementById('newSkuRemarks')?.value?.trim() || '';
      const rawPrice = document.getElementById('newSkuPrice')?.value?.trim();
      let unitPrice = null;
      if (rawPrice !== undefined && rawPrice !== '' && rawPrice !== null) {
        const pNum = Number(rawPrice);
        if (isNaN(pNum) || !isFinite(pNum) || pNum < 0) {
          alert('Current Unit Price (IDR) must be a valid positive number.');
          document.getElementById('newSkuPrice')?.focus();
          return;
        }
        unitPrice = pNum;
      } else if (REQUIRE_UNIT_PRICE) {
        alert('Current Unit Price (IDR) is required.');
        document.getElementById('newSkuPrice')?.focus();
        return;
      }

      // Final duplicate safety check
      const dup = await DataService.checkDuplicate(sku, productName);
      if (dup.isDuplicateSku) {
        alert(`Cannot save: SKU ${sku} already exists.`);
        return;
      }

      const newItem = {
        sku,
        productName,
        itemDescription,
        category: document.getElementById('newSkuCategory')?.value || this.currentCategory || 'Raw Materials',
        subCategory: 'Engineering Entry',
        material,
        size,
        unit,
        weightKg,
        status,
        supplyType,
        remarks,
        unitPrice,
        brand: brand || '',
        sourceFile: this._skuUploadedFile ? this._skuUploadedFile.name : 'Manual Engineering Entry',
        sourceSheet: 'Engineering Verified',
        specificAttributes: {}
      };

      if (spec) newItem.specificAttributes['Specification'] = spec;
      if (finish) newItem.specificAttributes['Finish / Coating'] = finish;
      if (remarks) newItem.specificAttributes['Engineering Notes'] = remarks;

      try {
        await DataService.addMasterItem(newItem);
        this.showToast('New SKU Created', `Master Item ${sku} (${productName}) saved successfully.`);
        this.updateDashboardStats();
        this.renderMasterCatalogTable();

        // Show success screen
        const successSku = document.getElementById('skuSuccessSku');
        if (successSku) successSku.textContent = `SKU: ${sku}`;
        this._skuShowStep('skuStepSuccess');
        this._skuUpdateStepLabel(4);
      } catch (err) {
        alert('Error creating new SKU: ' + err.message);
      }
    },

    // =========================================================================
    // 5. PURCHASE REQUEST CREATION (WHITE DOCUMENT-STYLE INTERFACE)
    // =========================================================================
    async openCreatePrModal(sku) {
      if (window.PermissionService && !window.PermissionService.can('CAN_CREATE_PR')) {
        this.showAccessDeniedModal('Access Denied — PR creation permission required.');
        return;
      }
      const item = await DataService.getMasterItemBySku(sku);
      if (!item) {
        alert(`Master SKU ${sku} not found!`);
        return;
      }

      this.selectedMasterItemForPR = item;
      const modal = document.getElementById('modalCreatePr');
      const form = document.getElementById('formCreatePr');
      if (!modal || !form) return;

      form.reset();

      // Automatically prefill Requester with authenticated user
      const currentUser = window.AuthService ? window.AuthService.getCurrentUser() : null;
      const elRequester = document.getElementById('prRequester');
      if (elRequester && currentUser) {
        elRequester.value = currentUser.fullName;
      }

      // Calculate next prospective PR number for display
      const prs = await DataService.getPurchaseRequests();
      const year = new Date().getFullYear();
      const nextSeq = String(prs.length + 1).padStart(4, '0');
      const prospectivePrNumber = `PR-${year}-${nextSeq}`;

      // Format current date as DD/MM/YYYY
      const now = new Date();
      const day = String(now.getDate()).padStart(2, '0');
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const formattedToday = `${day}/${month}/${year}`;

      // Populate PR Document Header
      const elPrNum = document.getElementById('prDisplayNumber');
      const elPrDate = document.getElementById('prDisplayDate');
      if (elPrNum) elPrNum.textContent = prospectivePrNumber;
      if (elPrDate) elPrDate.textContent = formattedToday;

      // Populate Locked Master Item Technical Specifications (Read-Only Single Source of Truth)
      const elSku = document.getElementById('prLockedSku');
      const elCat = document.getElementById('prLockedCategory');
      const elName = document.getElementById('prLockedName');
      const elDesc = document.getElementById('prLockedDescription');
      const elPrInputDesc = document.getElementById('prItemDescription');
      const elSubcat = document.getElementById('prLockedSubcat');
      const elMat = document.getElementById('prLockedMaterial');
      const elSize = document.getElementById('prLockedSize');
      const elSpec = document.getElementById('prLockedSpec');
      const elBrand = document.getElementById('prLockedBrand');
      const elUnit = document.getElementById('prLockedUnit');
      const elWeight = document.getElementById('prLockedWeight');
      const elQtyUnit = document.getElementById('prQtyUnitBadge');
      const elCalcWt = document.getElementById('prCalculatedTotalWeight');

      const masterDescription = this.getItemDescription(item);

      if (elSku) elSku.textContent = item.sku;
      if (elCat) elCat.textContent = item.category || 'Raw Materials';
      if (elName) elName.textContent = item.productName;
      if (elDesc) elDesc.textContent = masterDescription;
      if (elPrInputDesc) elPrInputDesc.value = masterDescription;
      if (elSubcat) elSubcat.textContent = item.subCategory || '-';
      if (elMat) elMat.textContent = item.material || '-';
      if (elSize) elSize.textContent = item.size || '-';
      if (elSpec) elSpec.textContent = item.specification || item.sourceSheet || 'PT Persada Nusantara Steel Standard';
      if (elBrand) elBrand.textContent = item.brand || 'PT Persada Nusantara Steel';
      if (elUnit) elUnit.textContent = item.unit || 'Sheet';
      if (elWeight) elWeight.textContent = item.weightKg ? `${item.weightKg} kg / ${item.unit || 'pc'}` : '-';
      if (elQtyUnit) elQtyUnit.textContent = item.unit || 'Units';
      if (elCalcWt) elCalcWt.textContent = 'Total Est: -';

      const elLockedPrice = document.getElementById('prLockedUnitPrice');
      const elSumPrice = document.getElementById('sumUnitPrice');
      const formattedUnitPrice = DataService.formatUnitPrice(item.unitPrice, item.unit);
      if (elLockedPrice) {
        elLockedPrice.innerHTML = (item.unitPrice && Number(item.unitPrice) > 0)
          ? escapeHtml(formattedUnitPrice)
          : '<span style="color:#64748b; font-weight:400;">Not Available</span>';
      }
      if (elSumPrice) {
        elSumPrice.textContent = formattedUnitPrice;
      }

      // Set default Required Date (1 week from today)
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const dateInput = document.getElementById('prRequiredDate');
      if (dateInput) {
        dateInput.value = nextWeek.toISOString().split('T')[0];
        dateInput.min = new Date().toISOString().split('T')[0];
      }

      // Populate Master Data into Purchase Request Summary section
      const elSumPrNum = document.getElementById('sumPrNumber');
      const elSumPrDate = document.getElementById('sumPrDate');
      const elSumSku = document.getElementById('sumSku');
      const elSumName = document.getElementById('sumProductName');
      const elSumCat = document.getElementById('sumCategory');
      const elSumSubcat = document.getElementById('sumSubcategory');
      const elSumMat = document.getElementById('sumMaterial');
      const elSumSize = document.getElementById('sumSize');
      const elSumSpec = document.getElementById('sumSpecification');
      const elSumUnit = document.getElementById('sumUnit');
      const elSumBrand = document.getElementById('sumBrand');
      const elSumDesc = document.getElementById('sumItemDescription');

      if (elSumPrNum) elSumPrNum.textContent = prospectivePrNumber;
      if (elSumPrDate) elSumPrDate.textContent = formattedToday;
      if (elSumSku) elSumSku.textContent = item.sku;
      if (elSumName) elSumName.textContent = item.productName;
      if (elSumCat) elSumCat.textContent = item.category || 'Raw Materials';
      if (elSumSubcat) elSumSubcat.textContent = item.subCategory || '-';
      if (elSumMat) elSumMat.textContent = item.material || '-';
      if (elSumSize) elSumSize.textContent = item.size || '-';
      if (elSumSpec) elSumSpec.textContent = item.specification || item.sourceSheet || 'PT Persada Nusantara Steel Standard';
      if (elSumUnit) elSumUnit.textContent = item.unit || 'Sheet';
      if (elSumBrand) elSumBrand.textContent = item.brand || 'PT Persada Nusantara Steel';
      if (elSumDesc) elSumDesc.textContent = masterDescription;

      // Live Synchronizer Function: Updates the Purchase Request Summary live as user fills the form
      const syncPrSummaryLive = () => {
        const qtyVal = document.getElementById('prQuantity')?.value;
        const qty = parseFloat(qtyVal) || 0;
        const pid = document.getElementById('prProjectId')?.value.trim() || '';
        const dept = document.getElementById('prDepartment')?.value || '';
        const requester = document.getElementById('prRequester')?.value.trim() || '';
        const reqDate = document.getElementById('prRequiredDate')?.value || '';
        const urgency = document.getElementById('prUrgency')?.value || 'Standard (1-2 Weeks)';
        const prDesc = document.getElementById('prItemDescription')?.value || '';
        const reason = document.getElementById('prReason')?.value.trim() || '';
        const remarks = document.getElementById('prRemarks')?.value.trim() || '';

        // 1. Project / Request Information
        const elSumPid = document.getElementById('sumProjectId');
        const elSumDept = document.getElementById('sumDepartment');
        const elSumReq = document.getElementById('sumRequestedBy');
        const elSumDate = document.getElementById('sumRequiredDate');
        const elSumUrg = document.getElementById('sumUrgency');

        if (elSumPid) elSumPid.textContent = pid || '(Not entered)';
        if (elSumDept) elSumDept.textContent = dept || '-';
        if (elSumReq) elSumReq.textContent = requester || '(Not entered)';
        if (elSumDate) {
          if (reqDate) {
            const parts = reqDate.split('-');
            elSumDate.textContent = parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : reqDate;
          } else {
            elSumDate.textContent = '(Not selected)';
          }
        }
        if (elSumUrg) {
          elSumUrg.textContent = urgency;
          elSumUrg.className = 'pr-sum-value ' + (urgency.includes('Critical') ? 'pr-urgency-critical' : (urgency.includes('Urgent') ? 'pr-urgency-urgent' : ''));
        }

        // 2. Item Details (Quantity & Weight calculation & Item Description)
        const elSumQty = document.getElementById('sumQuantity');
        const elSumWeight = document.getElementById('sumWeight');
        const elSumDescLive = document.getElementById('sumItemDescription');

        if (elSumQty) {
          elSumQty.textContent = qty > 0 ? `${qty} ${item.unit || 'Units'}` : '(Enter quantity)';
        }

        if (qty > 0 && item.weightKg) {
          const tot = (qty * item.weightKg).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const mt = ((qty * item.weightKg) / 1000).toFixed(3);
          if (elSumWeight) elSumWeight.textContent = `${item.weightKg} kg / ${item.unit || 'pc'} (Total Est: ${tot} kg / ${mt} MT)`;
          if (elCalcWt) elCalcWt.textContent = `Total Est: ${tot} kg (${mt} MT)`;
        } else {
          if (elSumWeight) elSumWeight.textContent = item.weightKg ? `${item.weightKg} kg / ${item.unit || 'pc'}` : '-';
          if (elCalcWt) elCalcWt.textContent = 'Total Est: -';
        }

        if (elSumDescLive) {
          elSumDescLive.textContent = prDesc || '(No description entered)';
        }

        const elSumCost = document.getElementById('sumTotalCost');
        if (elSumCost) {
          if (qty > 0 && item.unitPrice && !isNaN(Number(item.unitPrice)) && Number(item.unitPrice) >= 0) {
            const totCost = qty * Number(item.unitPrice);
            elSumCost.textContent = `IDR ${totCost.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
          } else {
            elSumCost.textContent = '—';
          }
        }

        // 3. Reason / Requirement
        const elSumReason = document.getElementById('sumReason');
        const elSumRemarks = document.getElementById('sumRemarks');

        if (elSumReason) elSumReason.textContent = reason || '(Please enter reason for purchase)';
        if (elSumRemarks) elSumRemarks.textContent = remarks || '(None)';
      };

      // Bind input and change events to all form inputs for immediate live reflection
      const monitoredFields = ['prQuantity', 'prProjectId', 'prDepartment', 'prRequester', 'prRequiredDate', 'prUrgency', 'prItemDescription', 'prReason', 'prRemarks'];
      monitoredFields.forEach(id => {
        const inputEl = document.getElementById(id);
        if (inputEl) {
          inputEl.oninput = syncPrSummaryLive;
          inputEl.onchange = syncPrSummaryLive;
        }
      });

      // Bind quick PID preset pills
      modal.querySelectorAll('.btn-pid-preset').forEach(btn => {
        btn.onclick = () => {
          const pid = btn.getAttribute('data-pid');
          const pidInput = document.getElementById('prProjectId');
          if (pidInput && pid) {
            pidInput.value = pid;
            syncPrSummaryLive();
          }
        };
      });

      // Initial live sync so summary immediately displays defaults
      syncPrSummaryLive();

      modal.classList.add('active');
    },

    async handleCreatePurchaseRequest() {
      if (window.PermissionService && !window.PermissionService.can('CAN_CREATE_PR')) {
        this.showAccessDeniedModal('Access Denied — PR creation permission required.');
        return;
      }
      if (!this.selectedMasterItemForPR) {
        alert('No Master Item selected!');
        return;
      }

      const item = this.selectedMasterItemForPR;
      const quantity = parseFloat(document.getElementById('prQuantity').value);
      const projectId = document.getElementById('prProjectId').value.trim();
      const itemDescription = document.getElementById('prItemDescription')?.value.trim() || this.getItemDescription(item);
      const reasonForPurchase = document.getElementById('prReason').value.trim();
      const requiredDate = document.getElementById('prRequiredDate').value;
      const urgency = document.getElementById('prUrgency').value;
      const department = document.getElementById('prDepartment').value;
      const requestedBy = document.getElementById('prRequester').value.trim();
      const remarks = document.getElementById('prRemarks').value.trim();

      if (!quantity || quantity <= 0) {
        alert('Please enter a valid positive quantity (greater than 0).');
        return;
      }
      if (!projectId) {
        alert('Please enter Project / PID.');
        return;
      }
      if (!itemDescription) {
        alert('Please enter an Item Description.');
        return;
      }
      if (!reasonForPurchase) {
        alert('Please enter Reason for Purchase.');
        return;
      }
      if (!requiredDate) {
        alert('Please select Required Date.');
        return;
      }

      if (REQUIRE_UNIT_PRICE) {
        const rawPrice = item.unitPrice;
        const priceNum = (rawPrice !== undefined && rawPrice !== null && rawPrice !== '') ? parseFloat(rawPrice) : null;
        if (priceNum === null || isNaN(priceNum) || priceNum <= 0) {
          alert(`Cannot create PR. Current Unit Price is missing for: ${item.sku} - ${item.productName || item.sku}`);
          return;
        }
      }

      const prPayload = {
        // Master Item technical data (Retrieved directly from Master Item, NOT re-entered)
        sku: item.sku,
        productName: item.productName,
        itemDescription,
        category: item.category || 'Raw Materials',
        subCategory: item.subCategory,
        material: item.material,
        size: item.size,
        specification: item.specification || item.sourceSheet || 'PT Persada Nusantara Steel Standard',
        unit: item.unit,
        weightKg: item.weightKg,
        brand: item.brand,
        specificAttributes: item.specificAttributes,

        // Transactional PR user inputs
        quantity,
        totalWeightKg: item.weightKg ? (item.weightKg * quantity).toFixed(2) : null,
        unitPrice: (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '' && !isNaN(Number(item.unitPrice))) ? Number(item.unitPrice) : null,
        totalCost: (item.unitPrice && Number(item.unitPrice) > 0) ? Number((Number(item.unitPrice) * quantity).toFixed(2)) : null,
        projectId,
        reasonForPurchase,
        requiredDate,
        urgency,
        department,
        requestedBy,
        remarks
      };

      try {
        const savedPR = await DataService.createPurchaseRequest(prPayload);
        this.closeAllModals();
        this.showToast('Purchase Request Created', `${savedPR.prNumber} successfully generated for SKU ${item.sku}.`);

        // Refresh statistics & tables
        this.updateDashboardStats();
        this.renderPRRegisterTable();

        // Immediately open completed White PR Document for review / printing
        this.openVoucherModal(savedPR);

      } catch (err) {
        alert('Error creating Purchase Request: ' + err.message);
      }
    },

    // =========================================================================
    async renderPRRegisterTable() {
      const allPrs = await DataService.getPurchaseRequests();
      const currentUser = window.AuthService ? window.AuthService.getCurrentUser() : null;
      const isAdmin = currentUser && currentUser.role === 'ADMIN';

      let prs = allPrs;
      if (!isAdmin && currentUser) {
        prs = allPrs.filter(p => 
          p.userId === currentUser.id ||
          p.createdById === currentUser.id ||
          p.requesterUsername === currentUser.username ||
          (p.requestedBy && p.requestedBy.toLowerCase() === currentUser.fullName.toLowerCase())
        );
      }

      const tbody = document.getElementById('prRegisterTbody');
      const countEl = document.getElementById('prRegisterCount');

      // Update PR Register KPI Cards (Section 5)
      const kpiTotal = document.getElementById('prKpiTotal');
      const kpiPending = document.getElementById('prKpiPending');
      const kpiApproved = document.getElementById('prKpiApproved');
      const kpiRejected = document.getElementById('prKpiRejected');

      const pendingCount = prs.filter(p => p.status === 'PENDING' || p.status === 'PENDING APPROVAL' || (!p.status && !p.approvedAt && !p.rejectedAt)).length;
      const approvedCount = prs.filter(p => p.status === 'APPROVED').length;
      const rejectedCount = prs.filter(p => p.status === 'REJECTED').length;

      if (kpiTotal) kpiTotal.textContent = prs.length;
      if (kpiPending) kpiPending.textContent = pendingCount;
      if (kpiApproved) kpiApproved.textContent = approvedCount;
      if (kpiRejected) kpiRejected.textContent = rejectedCount;

      if (!tbody) return;
      if (countEl) {
        if (!isAdmin) {
          countEl.innerHTML = `Showing <strong>${prs.length}</strong> of your submitted Purchase Requisitions`;
        } else {
          countEl.innerHTML = `Total <strong>${prs.length}</strong> Purchase Requisitions recorded`;
        }
      }

      if (prs.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" style="text-align:center; padding: 3rem 1rem; color: var(--text-muted);">
              <div style="font-size: 2rem; margin-bottom: 0.5rem;">📋</div>
              <strong>No Purchase Requests found.</strong>
              <p style="font-size:0.85rem; margin-top:0.25rem;">Go to the Raw Materials Catalog, add materials to your PR Cart and submit a Purchase Request.</p>
              <button class="btn btn-primary btn-sm" style="margin-top:1rem;" onclick="UI.switchView('catalog')">+ New PR</button>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = prs.map((pr) => {
        const reqDateFormatted = formatDateDisplay(pr.createdAt);
        const reqDueDateFormatted = formatDateDisplay(pr.requiredDate);

        const isApproved = pr.status === 'APPROVED';
        const isRejected = pr.status === 'REJECTED';
        const isPending = !isApproved && !isRejected;

        const statusBadge = isApproved
          ? '<span class="status-badge status-approved">APPROVED</span>'
          : (isRejected
              ? '<span class="status-badge status-rejected">REJECTED</span>'
              : '<span class="status-badge status-pending">PENDING APPROVAL</span>');

        // Total Cost calculation
        let totCost = pr.totalCost || pr.estimatedTotalCost;
        if ((!totCost || totCost === 0) && pr.unitPrice && pr.quantity) {
          totCost = pr.unitPrice * pr.quantity;
        }
        const costStr = formatCurrency(totCost);

        const requester = pr.requesterName || pr.requestedBy || 'User';
        const username = pr.requesterUsername || pr.createdByName || '-';
        const projCode = pr.projectCode || pr.projectId || '-';

        return `
          <tr data-pr-id="${pr.id || pr.prNumber}">
            <td><span class="pr-badge">${escapeHtml(pr.prNumber)}</span></td>
            <td>
              <div style="font-weight:600; color:var(--text-main); font-size:0.85rem;">${escapeHtml(requester)}</div>
              <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono);">${escapeHtml(username)}</div>
            </td>
            <td><span class="project-code-tag" style="font-size:0.8rem; padding:2px 6px;">${escapeHtml(projCode)}</span></td>
            <td style="font-size:0.85rem; color:var(--text-main);">${reqDateFormatted}</td>
            <td style="font-size:0.85rem; font-weight:600; color:var(--text-main);">${reqDueDateFormatted}</td>
            <td style="font-weight:700; color:#059669; font-family:var(--font-mono); text-align:right;">${costStr}</td>
            <td style="text-align:center;">${statusBadge}</td>
            <td style="text-align:right;">
              <div class="table-actions-compact">
                <button type="button" class="btn btn-secondary btn-sm btn-reg-view" data-pr-id="${pr.id || pr.prNumber}" title="View PR Details">
                  View
                </button>
                ${(isAdmin && isPending) ? `
                  <button type="button" class="btn btn-primary btn-sm btn-reg-approve" data-pr-id="${pr.id}" data-pr-num="${pr.prNumber}" style="background:#059669; border-color:#047857; font-size:0.75rem; padding:4px 8px;" title="Approve Purchase Request">
                    Approve
                  </button>
                  <button type="button" class="btn btn-danger btn-sm btn-reg-reject" data-pr-id="${pr.id}" data-pr-num="${pr.prNumber}" style="font-size:0.75rem; padding:4px 8px;" title="Reject Purchase Request">
                    Reject
                  </button>
                ` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // Bind row events
      tbody.querySelectorAll('.btn-reg-view').forEach(btn => {
        btn.addEventListener('click', () => {
          const prId = btn.getAttribute('data-pr-id');
          this.openViewPrDetailsModal(prId);
        });
      });

      tbody.querySelectorAll('.btn-reg-approve').forEach(btn => {
        btn.addEventListener('click', () => {
          const prId = btn.getAttribute('data-pr-id');
          this.handleApprovePr(prId);
        });
      });

      tbody.querySelectorAll('.btn-reg-reject').forEach(btn => {
        btn.addEventListener('click', () => {
          const prId = btn.getAttribute('data-pr-id');
          const prNum = btn.getAttribute('data-pr-num');
          this.openRejectModal(prId, prNum);
        });
      });
    },

    async openViewPrDetailsModal(prId) {
      const modal = document.getElementById('modalViewPrDetails');
      const numberEl = document.getElementById('viewPrNumber');
      const badgeEl = document.getElementById('viewPrStatusBadge');
      const bodyEl = document.getElementById('viewPrBodyContent');
      const footerEl = document.getElementById('viewPrFooterActions');

      if (!modal) return;

      try {
        let pr = null;
        let docs = [];
        let history = [];

        // Fetch details from backend DataService
        try {
          const res = await DataService.getPurchaseRequestDetails(prId);
          pr = res.purchaseRequest || res.pr || res;
          docs = res.documents || [];
          history = res.history || [];
          if (res.items && (!pr.items || pr.items.length === 0)) {
            pr.items = res.items;
          }
        } catch (e) {
          // Fallback to local
          const allPrs = await DataService.getPurchaseRequests();
          pr = allPrs.find(p => p.id === prId || p.prNumber === prId);
        }

        if (!pr) {
          alert('Purchase Request details not found.');
          return;
        }

        if (numberEl) numberEl.textContent = pr.prNumber;
        
        const isApproved = pr.status === 'APPROVED';
        const isRejected = pr.status === 'REJECTED';
        const isPending = !isApproved && !isRejected;

        if (badgeEl) {
          if (isApproved) {
            badgeEl.className = 'status-badge status-approved';
            badgeEl.textContent = '✓ APPROVED';
          } else if (isRejected) {
            badgeEl.className = 'status-badge status-rejected';
            badgeEl.textContent = '✗ REJECTED';
          } else {
            badgeEl.className = 'status-badge status-pending';
            badgeEl.textContent = '● PENDING APPROVAL';
          }
        }

        const reqDateStr = formatDateDisplay(pr.createdAt);
        const reqBy = pr.requesterName || pr.requestedBy || 'Flow Force User';
        const reqUser = pr.requesterUsername || pr.createdByName || '-';

        const items = pr.items || [{
          sku: pr.sku,
          productName: pr.productName,
          itemDescription: pr.itemDescription,
          materialGrade: pr.material,
          sizeDimensions: pr.size,
          specification: pr.specification,
          unit: pr.unit,
          quantity: pr.quantity,
          weight: pr.weightKg || pr.totalWeightKg,
          unitPrice: pr.unitPrice,
          estimatedTotalCost: pr.totalCost || (pr.unitPrice * pr.quantity)
        }];

        const grandTotal = items.reduce((sum, it) => sum + (parseFloat(it.estimatedTotalCost || (it.unitPrice * it.quantity)) || 0), 0);

        if (bodyEl) {
          bodyEl.innerHTML = `
            <!-- SECTION 1: PROJECT / REQUEST INFORMATION -->
            <div class="pr-doc-section">
              <div class="pr-doc-section-title">
                <span>PROJECT / REQUEST INFORMATION</span>
                <span style="font-size:0.85rem; font-weight:700; color:var(--primary-600); font-family:var(--font-mono);">${escapeHtml(pr.prNumber)}</span>
              </div>
              <div class="pr-meta-grid" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px 18px; background:#f8fafc; padding:14px 18px; border:1px solid #e2e8f0; border-radius:6px; font-size:0.85rem;">
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Project / PID:</strong> <div style="font-weight:700; color:#0f172a;">${escapeHtml(pr.projectCode || pr.projectId || '-')}</div></div>
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Project Name:</strong> <div style="font-weight:600; color:#0f172a;">${escapeHtml(pr.projectName || '-')}</div></div>
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Job Location:</strong> <div style="font-weight:700; color:#0f172a;">📍 ${escapeHtml(pr.jobLocation || '-')}</div></div>
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Created By:</strong> <div style="font-weight:600; color:#0f172a;">${escapeHtml(reqBy)}</div></div>
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Username:</strong> <div style="font-family:var(--font-mono); color:#0284c7;">${escapeHtml(reqUser)}</div></div>
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Department:</strong> <div style="font-weight:600;">${escapeHtml(pr.department || 'Engineering')}</div></div>
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Request Date:</strong> <div>${reqDateStr}</div></div>
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Required Date:</strong> <div style="font-weight:600;">${formatDateDisplay(pr.requiredDate)}</div></div>
                <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Urgency:</strong> <span style="font-weight:700; color:${(pr.urgency && pr.urgency.includes('Critical')) ? '#e11d48' : '#d97706'}">${escapeHtml(pr.urgency || 'Standard')}</span></div>
                ${pr.purchaseType === 'PROJECT-SPECIFIC CUT SIZE' ? `
                  <div style="grid-column: span 3; background:#fff7ed; padding:8px 12px; border:1px solid #fed7aa; border-radius:4px;">
                    <strong style="color:#c2410c; font-size:0.8rem;">✂️ PURCHASE TYPE: PROJECT-SPECIFIC CUT SIZE</strong>
                    <div style="font-weight:700; color:#9a3412; font-family:var(--font-mono); margin-top:2px;">Required Cut Size: ${escapeHtml(pr.requiredCutSize || '-')}</div>
                  </div>
                ` : ''}
              </div>
            </div>

            <!-- SECTION 2: ITEM DETAILS -->
            <div class="pr-doc-section" style="margin-top:1.5rem;">
              <div class="pr-doc-section-title">
                <span>ITEM DETAILS (${items.length} Materials)</span>
              </div>
              <div class="table-responsive" style="margin-top:8px;">
                <table class="data-table" style="font-size:0.85rem;">
                  <thead>
                    <tr>
                      <th style="width:35px;">#</th>
                      <th style="width:95px;">SKU</th>
                      <th>Product Name &amp; Description</th>
                      <th>Material / Grade</th>
                      <th>Size / Dimensions</th>
                      <th>Unit</th>
                      <th style="text-align:right;">Quantity</th>
                      <th style="text-align:right;">Unit Price (IDR)</th>
                      <th style="text-align:right;">Est. Total (IDR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${items.map((it, idx) => {
                      const p = it.unitPrice || 0;
                      const q = it.quantity || 1;
                      const tot = it.estimatedTotalCost || (p * q);
                      const formattedUnitPrice = formatCurrency(p);
                      const priceStr = formattedUnitPrice !== '—' ? `${formattedUnitPrice} / ${escapeHtml(it.unit || 'Unit')}` : '—';
                      const totStr = formatCurrency(tot);

                      return `
                        <tr>
                          <td style="color:var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
                          <td><span class="sku-badge">${escapeHtml(it.sku)}</span></td>
                          <td>
                            <div style="font-weight:600; color:var(--text-main);">${escapeHtml(it.productName || '—')}</div>
                            <div style="font-size:0.78rem; color:var(--text-muted); white-space:pre-wrap; margin-top:3px; line-height:1.45;">${escapeHtml(it.itemDescription || '')}</div>
                          </td>
                          <td>${escapeHtml(it.materialGrade || it.material || '-')}</td>
                          <td style="font-family:var(--font-mono);">${escapeHtml(it.sizeDimensions || it.size || '-')}</td>
                          <td><span class="unit-badge">${escapeHtml(it.unit || 'Sheet')}</span></td>
                          <td style="text-align:right; font-weight:700; font-family:var(--font-mono);">${q}</td>
                          <td style="text-align:right; font-weight:600; font-family:var(--font-mono);">${priceStr}</td>
                          <td style="text-align:right; font-weight:700; color:#059669; font-family:var(--font-mono);">${totStr}</td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                  <tfoot>
                    <tr style="background:#f1f5f9; font-weight:700;">
                      <td colspan="8" style="text-align:right; text-transform:uppercase; font-size:0.8rem; letter-spacing:0.5px;">Grand Estimated Cost:</td>
                      <td style="text-align:right; font-size:0.95rem; color:#059669; font-family:var(--font-mono);">
                        ${formatCurrency(grandTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <!-- SECTION 3: REASON & REMARKS -->
            <div class="pr-doc-section" style="margin-top:1.5rem;">
              <div class="pr-doc-section-title"><span>REASON / REQUIREMENT</span></div>
              <div style="background:#f8fafc; padding:12px 16px; border:1px solid #e2e8f0; border-radius:6px; font-size:0.85rem;">
                <div style="margin-bottom:8px;">
                  <strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Reason for Purchase:</strong>
                  <div style="margin-top:3px; color:#0f172a; white-space:pre-wrap;">${escapeHtml(pr.reasonForPurchase || '-')}</div>
                </div>
                ${pr.remarks ? `
                  <div>
                    <strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Remarks:</strong>
                    <div style="margin-top:3px; color:#0f172a; white-space:pre-wrap;">${escapeHtml(pr.remarks)}</div>
                  </div>
                ` : ''}
              </div>
            </div>

            <!-- SECTION 4: APPROVAL & AUDIT TRAIL -->
            <div class="pr-doc-section" style="margin-top:1.5rem;">
              <div class="pr-doc-section-title"><span>APPROVAL & AUDIT TRAIL</span></div>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
                <div style="background:#f8fafc; padding:12px 16px; border:1px solid #e2e8f0; border-radius:6px; font-size:0.85rem;">
                  <strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Requester Submission:</strong>
                  <div style="margin-top:4px;"><strong>${escapeHtml(reqBy)}</strong> (${escapeHtml(reqUser)})</div>
                  <div style="color:var(--text-muted); font-size:0.78rem;">Submitted: ${reqDateStr}</div>
                </div>
                <div style="background:#f8fafc; padding:12px 16px; border:1px solid #e2e8f0; border-radius:6px; font-size:0.85rem;">
                  <strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Administrative Review:</strong>
                  ${isApproved ? `
                    <div style="margin-top:4px; color:#059669; font-weight:700;">✓ Approved by ${escapeHtml(pr.approvedByName || pr.approvedByUsername || 'Admin')}</div>
                    <div style="color:var(--text-muted); font-size:0.78rem;">Timestamp: ${formatDateDisplay(pr.approvedAt)}</div>
                  ` : (isRejected ? `
                    <div style="margin-top:4px; color:#e11d48; font-weight:700;">✗ Rejected by ${escapeHtml(pr.rejectedByName || pr.rejectedByUsername || 'Admin')}</div>
                    <div style="color:var(--text-muted); font-size:0.78rem;">Timestamp: ${formatDateDisplay(pr.rejectedAt)}</div>
                    <div style="margin-top:6px; padding:6px 10px; background:#fff1f2; border:1px solid #fecdd3; border-radius:4px; color:#be123c; font-size:0.8rem;">
                      <strong>Reason:</strong> ${escapeHtml(pr.rejectionReason || 'No reason specified')}
                    </div>
                  ` : `
                    <div style="margin-top:4px; color:#d97706; font-weight:600;">⏳ Pending Review by Administrator</div>
                    <div style="color:var(--text-muted); font-size:0.78rem;">Awaiting executive approval</div>
                  `)}
                </div>
              </div>

              ${history && history.length > 0 ? `
                <div style="margin-top:12px;">
                  <div style="font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:6px;">Approval History:</div>
                  <div style="display:flex; flex-direction:column; gap:6px;">
                    ${history.map(h => `
                      <div style="font-size:0.8rem; display:flex; justify-content:space-between; background:#fff; padding:6px 12px; border:1px solid #e2e8f0; border-radius:4px;">
                        <span><strong>${escapeHtml(h.action)}</strong> by ${escapeHtml(h.performedByName || h.performedByUsername || 'User')} ${h.remarks ? `— <em>${escapeHtml(h.remarks)}</em>` : ''}</span>
                        <span style="color:var(--text-muted); font-family:var(--font-mono); font-size:0.75rem;">${formatDateDisplay(h.performedAt)}</span>
                      </div>
                    `).join('')}
                  </div>
                </div>
              ` : ''}
            </div>
          `;
        }

        // Render Footer Actions
        const currentUser = window.AuthService ? window.AuthService.getCurrentUser() : null;
        const isAdmin = currentUser && currentUser.role === 'ADMIN';

        const excelDoc = docs.find(d => d.documentType === 'PR_EXCEL');
        const pdfDoc = docs.find(d => d.documentType === 'PR_PDF');

        if (footerEl) {
          footerEl.innerHTML = `
            <div style="display:flex; gap:10px; align-items:center;">
              ${excelDoc ? `
                <button type="button" class="btn btn-secondary btn-sm" id="btnModalDlExcel">
                  📊 Download Excel (${escapeHtml(excelDoc.fileName)})
                </button>
              ` : ''}
              ${pdfDoc ? `
                <button type="button" class="btn btn-secondary btn-sm" id="btnModalDlPdf">
                  📄 Download PDF (${escapeHtml(pdfDoc.fileName)})
                </button>
              ` : ''}
              <button type="button" class="btn btn-secondary btn-sm" onclick="window.print()">
                🖨️ Print View
              </button>
            </div>

            <div style="display:flex; gap:10px; align-items:center;">
              ${(isAdmin && isPending) ? `
                <button type="button" class="btn btn-danger btn-sm" id="btnModalRejectPr">
                  ✗ Reject PR
                </button>
                <button type="button" class="btn btn-success btn-sm" id="btnModalApprovePr" style="background:#059669; border-color:#047857; color:#fff;">
                  ✓ Approve PR
                </button>
              ` : ''}
              <button type="button" class="btn btn-secondary btn-sm" data-modal-close>
                Close
              </button>
            </div>
          `;

          // Bind download buttons
          if (excelDoc) {
            document.getElementById('btnModalDlExcel')?.addEventListener('click', () => {
              this.downloadDocument(excelDoc.id, excelDoc.fileName);
            });
          }
          if (pdfDoc) {
            document.getElementById('btnModalDlPdf')?.addEventListener('click', () => {
              this.downloadDocument(pdfDoc.id, pdfDoc.fileName);
            });
          }

          // Bind Admin approval / reject buttons in modal
          if (isAdmin && isPending) {
            document.getElementById('btnModalApprovePr')?.addEventListener('click', () => {
              this.handleApprovePr(pr.id);
            });
            document.getElementById('btnModalRejectPr')?.addEventListener('click', () => {
              this.openRejectModal(pr.id, pr.prNumber);
            });
          }

          // Bind close buttons in footer
          footerEl.querySelectorAll('[data-modal-close]').forEach(btn => {
            btn.addEventListener('click', () => {
              this.closeModal('modalViewPrDetails');
            });
          });
        }

        modal.classList.add('active');

      } catch (err) {
        alert('Error viewing PR details: ' + err.message);
      }
    },

    async handleApprovePr(prId) {
      if (!window.PermissionService || !window.PermissionService.can('CAN_APPROVE_PR')) {
        this.showAccessDeniedModal('Access Denied — Administrator permission required to approve PRs.');
        return;
      }

      if (!confirm('Are you sure you want to APPROVE this Purchase Request?')) {
        return;
      }

      try {
        const res = await DataService.approvePurchaseRequest(prId);
        this.showToast('PR Approved', `Purchase Request ${res.prNumber || ''} has been approved.`);
        await this.updateDashboardStats();
        await this.renderPRRegisterTable();

        // Refresh modal if currently open
        const modal = document.getElementById('modalViewPrDetails');
        if (modal && modal.classList.contains('active')) {
          this.openViewPrDetailsModal(prId);
        }
      } catch (err) {
        alert('Error approving Purchase Request: ' + err.message);
      }
    },

    openRejectModal(prId, prNumber) {
      if (!window.PermissionService || !window.PermissionService.can('CAN_REJECT_PR')) {
        this.showAccessDeniedModal('Access Denied — Administrator permission required to reject PRs.');
        return;
      }

      const modal = document.getElementById('modalPrRejectReason');
      const targetInput = document.getElementById('rejectTargetPrId');
      const subEl = document.getElementById('rejectModalSubtitle');
      const reasonEl = document.getElementById('rejectReasonText');
      const errAlert = document.getElementById('rejectErrorAlert');

      if (!modal) return;
      if (targetInput) targetInput.value = prId;
      if (subEl) subEl.textContent = prNumber || `PR #${prId}`;
      if (reasonEl) reasonEl.value = '';
      if (errAlert) errAlert.style.display = 'none';

      modal.classList.add('active');
    },

    initAdminApprovalWorkflow() {
      const formReject = document.getElementById('formRejectPr');
      if (formReject && !formReject._bound) {
        formReject._bound = true;
        formReject.addEventListener('submit', async (e) => {
          e.preventDefault();
          const prId = document.getElementById('rejectTargetPrId')?.value;
          const reason = document.getElementById('rejectReasonText')?.value?.trim();
          const errAlert = document.getElementById('rejectErrorAlert');
          const errMsg = document.getElementById('rejectErrorMsg');

          if (!prId || !reason) {
            if (errAlert && errMsg) {
              errMsg.textContent = 'Please enter a rejection reason.';
              errAlert.style.display = 'flex';
            }
            return;
          }

          try {
            const res = await DataService.rejectPurchaseRequest(prId, reason);
            this.closeModal('modalPrRejectReason');
            this.showToast('PR Rejected', `Purchase Request ${res.prNumber || ''} has been rejected.`);
            await this.updateDashboardStats();
            await this.renderPRRegisterTable();

            // Refresh modal if currently open
            const modal = document.getElementById('modalViewPrDetails');
            if (modal && modal.classList.contains('active')) {
              this.openViewPrDetailsModal(prId);
            }
          } catch (err) {
            if (errAlert && errMsg) {
              errMsg.textContent = err.message;
              errAlert.style.display = 'flex';
            } else {
              alert('Error rejecting PR: ' + err.message);
            }
          }
        });
      }
    },

    async downloadDocument(docId, fileName) {
      const token = window.AuthService ? window.AuthService.getToken() : '';
      if (!token) {
        alert('Authentication required to download document.');
        return;
      }
      try {
        const resp = await fetch(`/api/documents/${docId}/download`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) {
          const err = await resp.json();
          throw new Error(err.error || 'Download failed');
        }
        const blob = await resp.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName || `PR-Document-${docId}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      } catch (e) {
        alert('Download error: ' + e.message);
      }
    },

    openVoucherModal(pr) {
      this.selectedPRForVoucher = pr;
      const modal = document.getElementById('modalPrVoucher');
      const container = document.getElementById('prVoucherContainer');
      if (!modal || !container) return;

      const d = new Date(pr.createdAt);
      const reqDateFormatted = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

      // Update PR Voucher Header Meta
      const elVoucherNum = document.getElementById('prVoucherDisplayNumber');
      const elVoucherDate = document.getElementById('prVoucherDisplayDate');
      if (elVoucherNum) elVoucherNum.textContent = pr.prNumber;
      if (elVoucherDate) elVoucherDate.textContent = reqDateFormatted;

      container.innerHTML = `
        <!-- SECTION 1: PROJECT / REQUEST INFORMATION -->
        <div class="pr-doc-section">
          <div class="pr-doc-section-title">
            <span>PROJECT / REQUEST INFORMATION</span>
            <span style="font-size:0.85rem; font-weight:800; color:#0284c7; font-family:var(--font-mono);">${escapeHtml(pr.prNumber)}</span>
          </div>

          <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem 1.5rem; background:#f8fafc; padding: 14px 18px; border:1px solid #e2e8f0; border-radius:var(--radius-md); font-size:0.88rem;">
            <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">PR Number:</strong> <div style="font-weight:700; color:#0284c7; font-family:var(--font-mono);">${escapeHtml(pr.prNumber)}</div></div>
            <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Request Date:</strong> <div style="font-weight:700; color:#0f172a;">${reqDateFormatted}</div></div>
            <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Project / PID:</strong> <div style="font-weight:700; color:#0f172a;">${escapeHtml(pr.projectId || '-')}</div></div>
            <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Department:</strong> <div style="font-weight:700; color:#0f172a;">${escapeHtml(pr.department)}</div></div>
            <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Requested By:</strong> <div style="font-weight:700; color:#0f172a;">${escapeHtml(pr.requestedBy)}</div></div>
            <div><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Required Date:</strong> <div style="font-weight:700; color:#0f172a;">${escapeHtml(pr.requiredDate)}</div></div>
            <div style="grid-column: span 2;"><strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase;">Urgency:</strong> <span style="font-weight:700; color:${pr.urgency.includes('Critical') ? '#e11d48' : (pr.urgency.includes('Urgent') ? '#d97706' : '#0284c7')}">${escapeHtml(pr.urgency)}</span></div>
          </div>
        </div>

        <!-- SECTION 2: ITEM DETAILS -->
        <div class="pr-doc-section">
          <div class="pr-doc-section-title">
            <span>ITEM DETAILS</span>
            <span class="pr-source-truth-tag">🔒 Master Item (Single Source of Truth)</span>
          </div>

          <div class="pr-item-details-card">
            <table class="pr-spec-table">
              <tbody>
                <tr>
                  <th style="width: 18%;">SKU</th>
                  <td style="width: 32%;"><span class="pr-sku-pill">${escapeHtml(pr.sku)}</span></td>
                  <th style="width: 18%;">Category</th>
                  <td style="width: 32%;">${escapeHtml(pr.category || 'Raw Materials')}</td>
                </tr>
                <tr>
                  <th>Product Name</th>
                  <td colspan="3" class="pr-product-name-highlight">${escapeHtml(pr.productName)}</td>
                </tr>
                <tr>
                  <th style="vertical-align: top;">Item Description</th>
                  <td colspan="3" style="white-space: pre-wrap; font-size: 0.84rem; line-height: 1.5; color: #334155; word-break: break-word; background: #fafafa;">${escapeHtml(pr.itemDescription || this.getItemDescription(pr))}</td>
                </tr>
                <tr>
                  <th>Subcategory</th>
                  <td>${escapeHtml(pr.subCategory || '-')}</td>
                  <th>Material / Grade</th>
                  <td class="pr-bold-cell">${escapeHtml(pr.material)}</td>
                </tr>
                <tr>
                  <th>Size / Dimensions</th>
                  <td class="pr-mono-cell">${escapeHtml(pr.size)}</td>
                  <th>Specification</th>
                  <td>${escapeHtml(pr.specification || 'PT Persada Nusantara Steel Standard')}</td>
                </tr>
                <tr>
                  <th>Manufacturer / Brand</th>
                  <td>${escapeHtml(pr.brand || 'PT Persada Nusantara Steel')}</td>
                  <th>Unit</th>
                  <td>${escapeHtml(pr.unit)}</td>
                </tr>
                <tr style="background:#f0fdf4;">
                  <th>Requisition Quantity</th>
                  <td>
                    <div style="font-size:1.15rem; font-weight:800; color:#0284c7; font-family:var(--font-mono);">
                      ${pr.quantity} <span style="font-size:0.85rem; font-weight:700; color:#475569;">${escapeHtml(pr.unit)}</span>
                    </div>
                  </td>
                  <th>Weight</th>
                  <td>
                    <div style="font-weight:700; color:#0f172a;">${pr.weightKg ? pr.weightKg + ' kg / ' + pr.unit : '-'}</div>
                    ${pr.totalWeightKg ? `<div class="pr-calc-total-wt">Total Weight: ${parseFloat(pr.totalWeightKg).toLocaleString()} kg (${(parseFloat(pr.totalWeightKg)/1000).toFixed(3)} MT)</div>` : ''}
                  </td>
                </tr>
                <tr style="background:#f8fafc;">
                  <th>Unit Price (IDR)</th>
                  <td style="font-weight:700; color:#0f172a;">${(pr.unitPrice !== undefined && pr.unitPrice !== null && pr.unitPrice !== '' && Number(pr.unitPrice) >= 0) ? `IDR ${Number(pr.unitPrice).toLocaleString('id-ID')} / ${escapeHtml(pr.unit || 'Unit')}` : '—'}</td>
                  <th>Est. Total Cost (IDR)</th>
                  <td style="font-weight:800; color:#059669; font-size:0.95rem;">${(pr.totalCost || (pr.unitPrice !== undefined && pr.unitPrice !== null && pr.unitPrice !== '' && Number(pr.unitPrice) >= 0 && pr.quantity)) ? `IDR ${Number(pr.totalCost || (Number(pr.unitPrice) * pr.quantity)).toLocaleString('id-ID')}` : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- SECTION 3: REASON / REQUIREMENT -->
        <div class="pr-doc-section">
          <div class="pr-doc-section-title">
            <span>REASON / REQUIREMENT</span>
          </div>

          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:var(--radius-md); padding:14px 18px; font-size:0.88rem;">
            <div style="margin-bottom:0.75rem;">
              <strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase; display:block; margin-bottom:2px;">Reason for Purchase:</strong>
              <div style="color:#0f172a; font-weight:600;">${escapeHtml(pr.reasonForPurchase)}</div>
            </div>
            ${pr.remarks ? `
              <div style="border-top:1px dashed #e2e8f0; padding-top:0.75rem;">
                <strong style="color:#64748b; font-size:0.75rem; text-transform:uppercase; display:block; margin-bottom:2px;">Remarks / Purchasing Notes:</strong>
                <div style="color:#475569;">${escapeHtml(pr.remarks)}</div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Formal Approval Signature Blocks -->
        <div style="margin-top:2rem; padding-top:1.5rem; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; font-size:0.8rem; color:#64748b;">
          <div>
            <div>Requisitioned By:</div>
            <div style="width:170px; border-top:1px solid #94a3b8; margin-top:40px; text-align:center; padding-top:4px; font-weight:700; color:#0f172a;">
              ${escapeHtml(pr.requestedBy)}<br>
              <span style="font-size:0.7rem; color:#94a3b8; font-weight:400;">${escapeHtml(pr.department)}</span>
            </div>
          </div>
          <div>
            <div>Engineering Verification:</div>
            <div style="width:170px; border-top:1px solid #94a3b8; margin-top:40px; text-align:center; padding-top:4px; font-weight:700; color:#0f172a;">
              Lead Materials Engineer<br>
              <span style="font-size:0.7rem; color:#059669; font-weight:600;">Specification Verified</span>
            </div>
          </div>
          <div>
            <div>Purchasing Approval:</div>
            <div style="width:170px; border-top:1px solid #94a3b8; margin-top:40px; text-align:center; padding-top:4px; font-weight:700; color:#0f172a;">
              Procurement Manager<br>
              <span style="font-size:0.7rem; color:#0284c7; font-weight:600;">Pending Order</span>
            </div>
          </div>
        </div>
      `;

      modal.classList.add('active');
    },

    openSpecsModal(sku) {
      if (window.PermissionService && !window.PermissionService.can('CAN_VIEW_SPECS')) {
        this.showAccessDeniedModal('Access Denied — Specifications viewing permission required.');
        return;
      }
      DataService.getMasterItemBySku(sku).then(item => {
        if (!item) return;
        const modal = document.getElementById('modalSpecsView');
        const body = document.getElementById('specsViewBody');
        if (!modal || !body) return;

        const specsObj = item.specificAttributes || {};
        const specRows = Object.entries(specsObj).map(([k, v]) => `
          <div class="spec-item">
            <span class="spec-item-label">${escapeHtml(k)}</span>
            <span class="spec-item-val">${escapeHtml(v)}</span>
          </div>
        `).join('');

        body.innerHTML = `
          <div class="master-spec-lock-card">
            <div class="master-lock-header">
              <div class="master-lock-title">
                <span>🛡️ Single Source of Truth Master Item</span>
              </div>
              <span class="sku-badge" style="font-size:0.95rem;">${escapeHtml(item.sku)}</span>
            </div>
            <div style="font-size:1.15rem; font-weight:700; color:var(--text-main); margin-bottom:0.5rem;">
              ${escapeHtml(item.productName || '—')}
            </div>
            <div class="spec-attributes-grid">
              <div class="spec-item"><span class="spec-item-label">Category</span><span class="spec-item-val">${escapeHtml(item.category || 'Raw Materials')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Subcategory</span><span class="spec-item-val">${escapeHtml(item.subCategory || '-')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Material / Grade</span><span class="spec-item-val">${escapeHtml(item.material || '-')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Dimensions / Size</span><span class="spec-item-val" style="font-family:var(--font-mono);">${escapeHtml(item.size || '-')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Standard Unit</span><span class="spec-item-val">${escapeHtml(item.unit || 'PCS')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Unit Weight</span><span class="spec-item-val">${item.weightKg ? item.weightKg + ' kg' : '-'}</span></div>
              <div class="spec-item"><span class="spec-item-label">Status</span><span class="spec-item-val"><span class="status-badge ${(item.status === 'Out of Stock') ? 'out-of-stock' : 'available'}">● ${escapeHtml(item.status || 'Available')}</span></span></div>
              <div class="spec-item"><span class="spec-item-label">Supply Type</span><span class="spec-item-val"><span class="supply-badge ${(item.supplyType === 'Cut Size') ? 'cut-size' : 'full-size'}">${escapeHtml(item.supplyType || 'Full Size')}</span></span></div>
              <div class="spec-item"><span class="spec-item-label">Remarks</span><span class="spec-item-val">${escapeHtml(item.remarks || '—')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Current Unit Price (IDR)</span><span class="spec-item-val" style="font-weight:700; color:var(--primary-400);">${DataService.formatUnitPrice(item.unitPrice, item.unit)}</span></div>
              <div class="spec-item"><span class="spec-item-label">Manufacturer / Mill</span><span class="spec-item-val">${escapeHtml(item.brand || 'PT Persada Nusantara Steel')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Reference Source</span><span class="spec-item-val">${escapeHtml(item.sourceSheet || item.sourceFile || 'Catalog')}</span></div>
            </div>
          </div>

          <div style="margin-top: 1rem; margin-bottom: 1.25rem; background: rgba(255,255,255,0.04); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 14px 16px;">
            <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--text-dim); margin-bottom: 6px; letter-spacing: 0.05em;">Complete Item Description</div>
            <div style="white-space: pre-wrap; word-break: break-word; font-family: var(--font-sans); font-size: 0.88rem; line-height: 1.5; color: var(--text-main);">${escapeHtml(this.getItemDescription(item))}</div>
          </div>

          <h4 style="font-size:0.9rem; font-weight:700; text-transform:uppercase; color:var(--text-dim); margin-bottom:0.75rem; letter-spacing:0.05em;">Category-Specific Technical Details</h4>
          <div class="spec-attributes-grid" style="background:rgba(0,0,0,0.2); padding:1rem; border-radius:var(--radius-md); border:1px solid var(--border-subtle);">
            ${specRows || '<div style="color:var(--text-muted); font-size:0.85rem;">Standard mill catalog specifications.</div>'}
          </div>

          <div style="margin-top:1.5rem; text-align:right;">
            <button class="btn btn-primary" onclick="UI.closeAllModals(); UI.openCreatePrModal('${escapeHtml(item.sku)}')">
              <span>+ Create Purchase Request with this SKU</span>
            </button>
          </div>
        `;

        modal.classList.add('active');
      });
    },

    // =========================================================================
    // 7. SYSTEM SETTINGS & GOOGLE SHEETS SETUP
    // =========================================================================
    loadSettingsUI() {
      if (window.PermissionService && !window.PermissionService.can('CAN_ACCESS_SETTINGS')) {
        return;
      }
      const cfg = DataService.getConfig();
      const prefixInput = document.getElementById('cfgSkuPrefix');
      const nextNumInput = document.getElementById('cfgNextNum');
      const driverSelect = document.getElementById('cfgDriver');
      const apiUrlInput = document.getElementById('cfgApiUrl');

      if (prefixInput) prefixInput.value = cfg.skuPrefix;
      if (nextNumInput) nextNumInput.value = cfg.skuNextNumber;
      if (driverSelect) driverSelect.value = cfg.storageDriver;
      if (apiUrlInput) apiUrlInput.value = cfg.googleAppsScriptUrl || '';
    },

    handleSaveSettings() {
      if (window.PermissionService && !window.PermissionService.can('CAN_ACCESS_SETTINGS')) {
        this.showAccessDeniedModal('Access Denied — Administrator permission required.');
        return;
      }
      const prefix = document.getElementById('cfgSkuPrefix').value.trim() || 'FF';
      const nextNum = parseInt(document.getElementById('cfgNextNum').value, 10) || 4236;
      const driver = document.getElementById('cfgDriver').value;
      const apiUrl = document.getElementById('cfgApiUrl').value.trim();

      DataService.saveConfig({
        skuPrefix: prefix,
        skuNextNumber: nextNum,
        storageDriver: driver,
        googleAppsScriptUrl: apiUrl
      });

      this.showToast('Settings Saved', 'SKU Generation and Storage configurations updated.');
    },

    closeModal(modalId) {
      const el = document.getElementById(modalId);
      if (el) el.classList.remove('active');
    },

    closeAllModals() {
      document.querySelectorAll('.modal-backdrop').forEach(modal => {
        modal.classList.remove('active');
      });
    },

    showToast(title, message) {
      const container = document.getElementById('toastContainer');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = `
        <div class="toast-content">
          <div class="toast-icon">✓</div>
          <div class="toast-text">
            <h5>${escapeHtml(title)}</h5>
            <p>${escapeHtml(message)}</p>
          </div>
        </div>
      `;

      container.appendChild(toast);
      setTimeout(() => {
        toast.style.animation = 'slideInToast 0.25s reverse ease-in';
        setTimeout(() => toast.remove(), 250);
      }, 4000);
    }
  };

  // Helper Escape HTML function
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Central Date Formatter (Section 6: Consistent "15 Sep 2026" or "09 Sep 2026", never ISO timestamps)
  function formatDateDisplay(val) {
    if (!val) return '—';
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) {
        const parts = String(val).split('T')[0].split('-');
        if (parts.length === 3) {
          const year = parts[0];
          const monthIndex = parseInt(parts[1], 10) - 1;
          const day = parts[2].padStart(2, '0');
          const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          return `${day} ${months[monthIndex] || 'Sep'} ${year}`;
        }
        return String(val);
      }
      const day = String(d.getDate()).padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[d.getMonth()];
      const year = d.getFullYear();
      return `${day} ${month} ${year}`;
    } catch (e) {
      return String(val) || '—';
    }
  }

  // Central Currency Formatter (Section 7: IDR 30,000,000, never ₹, INR, undefined, NaN; if empty: '—')
  function formatCurrency(val) {
    if (val === null || val === undefined || val === '' || isNaN(Number(val)) || Number(val) <= 0) {
      return '—';
    }
    return `IDR ${Number(val).toLocaleString('en-US')}`;
  }

  // Expose UI to global scope
  window.UI = UI;
  window.DataService = DataService;
  window.formatDateDisplay = formatDateDisplay;
  window.formatCurrency = formatCurrency;
  window.renderUserManagement = () => UI.renderUserManagement();

  // Initialize once DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    UI.init();
  });

})();
