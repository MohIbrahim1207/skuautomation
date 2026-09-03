/**
 * Enterprise SKU & Purchase Request Automation Engine
 * Single Source of Truth: Master Item Catalog
 * Proof-of-Concept for RAW MATERIALS (50 Verified Items: FF4186 - FF4235)
 */

(function () {
  'use strict';

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
      // Load configuration
      const savedConfig = localStorage.getItem(STORAGE_KEYS.SKU_CONFIG);
      this.config = savedConfig ? JSON.parse(savedConfig) : { ...DEFAULT_CONFIG };

      // Check if master items are initialized in localStorage
      const existingItems = localStorage.getItem(STORAGE_KEYS.MASTER_ITEMS);
      if (!existingItems) {
        await this.loadInitialMasterData();
      }
    },

    async loadInitialMasterData() {
      try {
        const response = await fetch('raw_materials_master.json');
        if (response.ok) {
          const items = await response.json();
          localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));
          localStorage.setItem(STORAGE_KEYS.INITIALIZED, 'true');
          console.log(`[DataService] Initialized master catalog with ${items.length} verified items (FF4186-FF4235).`);
          return items;
        }
      } catch (err) {
        console.error('[DataService] Failed to load raw_materials_master.json, fallback', err);
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
      if (this.config.storageDriver === 'googleAppsScript' && this.config.googleAppsScriptUrl) {
        try {
          const resp = await fetch(`${this.config.googleAppsScriptUrl}?action=getMasterItems`);
          if (resp.ok) return await resp.json();
        } catch (e) {
          console.warn('[DataService] Google Sheets fetch failed, falling back to local', e);
        }
      }
      const raw = localStorage.getItem(STORAGE_KEYS.MASTER_ITEMS);
      return raw ? JSON.parse(raw) : [];
    },

    async getMasterItemBySku(sku) {
      const items = await this.getMasterItems();
      return items.find(i => i.sku.toUpperCase() === sku.toUpperCase()) || null;
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
      const items = await this.getMasterItems();
      
      // Ensure unique SKU
      const existing = items.find(i => i.sku.toUpperCase() === newItem.sku.toUpperCase());
      if (existing) {
        throw new Error(`Duplicate SKU Error: ${newItem.sku} already exists in Master Items.`);
      }

      newItem.createdAt = new Date().toISOString();
      items.unshift(newItem); // Add new to top of table
      localStorage.setItem(STORAGE_KEYS.MASTER_ITEMS, JSON.stringify(items));

      // Increment sequential SKU number if matched pattern
      const match = newItem.sku.match(/^([A-Za-z]+)(\d+)$/);
      if (match) {
        const num = parseInt(match[2], 10);
        if (num >= this.config.skuNextNumber) {
          this.config.skuNextNumber = num + 1;
          this.saveConfig(this.config);
        }
      }

      // If Google Apps Script active, sync in background
      if (this.config.storageDriver === 'googleAppsScript' && this.config.googleAppsScriptUrl) {
        fetch(this.config.googleAppsScriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'addMasterItem', item: newItem })
        }).catch(err => console.error('[DataService] Google Sheets sync error', err));
      }

      return newItem;
    },

    getNextSuggestedSKU() {
      return `${this.config.skuPrefix}${this.config.skuNextNumber}`;
    },

    // Purchase Requests API
    async getPurchaseRequests() {
      if (this.config.storageDriver === 'googleAppsScript' && this.config.googleAppsScriptUrl) {
        try {
          const resp = await fetch(`${this.config.googleAppsScriptUrl}?action=getPurchaseRequests`);
          if (resp.ok) return await resp.json();
        } catch (e) {
          console.warn('[DataService] Google Sheets PR fetch failed, falling back to local', e);
        }
      }
      const raw = localStorage.getItem(STORAGE_KEYS.PURCHASE_REQUESTS);
      return raw ? JSON.parse(raw) : [];
    },

    async createPurchaseRequest(prData) {
      const prs = await this.getPurchaseRequests();
      
      // Generate PR Number e.g. PR-2026-0001
      const year = new Date().getFullYear();
      const nextSeq = String(prs.length + 1).padStart(4, '0');
      const prNumber = `PR-${year}-${nextSeq}`;

      const fullPR = {
        prNumber,
        ...prData,
        status: 'Submitted (Pending Purchasing Review)',
        createdAt: new Date().toISOString()
      };

      prs.unshift(fullPR);
      localStorage.setItem(STORAGE_KEYS.PURCHASE_REQUESTS, JSON.stringify(prs));

      // If Google Apps Script active, sync in background
      if (this.config.storageDriver === 'googleAppsScript' && this.config.googleAppsScriptUrl) {
        fetch(this.config.googleAppsScriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'createPurchaseRequest', pr: fullPR })
        }).catch(err => console.error('[DataService] Google Sheets PR sync error', err));
      }

      return fullPR;
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

    async init() {
      await DataService.init();
      this.bindEvents();
      this.updateDashboardStats();
      this.renderMasterCatalogTable();
      this.renderPRRegisterTable();
      this.loadSettingsUI();
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

      // Category Card Click
      const rawMatCard = document.getElementById('cardRawMaterials');
      if (rawMatCard) {
        rawMatCard.addEventListener('click', () => {
          this.switchView('catalog');
        });
      }

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

      // Dynamic subcategory change in New SKU form
      const newSkuSubcat = document.getElementById('newSkuSubcategory');
      if (newSkuSubcat) {
        newSkuSubcat.addEventListener('change', (e) => {
          this.onNewSkuSubcategoryChange(e.target.value);
        });
      }

      // Live Duplicate Check on SKU input
      const newSkuInput = document.getElementById('newSkuCode');
      if (newSkuInput) {
        newSkuInput.addEventListener('input', () => {
          this.validateNewSkuDuplicate();
        });
      }

      // Auto-SKU regenerate button
      const btnRegenSku = document.getElementById('btnRegenerateSku');
      if (btnRegenSku) {
        btnRegenSku.addEventListener('click', () => {
          const nextSku = DataService.getNextSuggestedSKU();
          document.getElementById('newSkuCode').value = nextSku;
          this.validateNewSkuDuplicate();
        });
      }

      // New SKU Form Submit
      const formNewSku = document.getElementById('formNewSku');
      if (formNewSku) {
        formNewSku.addEventListener('submit', (e) => {
          e.preventDefault();
          this.handleCreateNewSku();
        });
      }

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
      }
      
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    async updateDashboardStats() {
      const masterItems = await DataService.getMasterItems();
      const prs = await DataService.getPurchaseRequests();

      const elTotalSkus = document.getElementById('kpiTotalSkus');
      const elTotalPrs = document.getElementById('kpiTotalPrs');
      const elPendingPrs = document.getElementById('kpiPendingPrs');
      const elNavPrCount = document.getElementById('navPrBadge');
      const elNavSkuCount = document.getElementById('navCatalogBadge');

      if (elTotalSkus) elTotalSkus.textContent = masterItems.length;
      if (elTotalPrs) elTotalPrs.textContent = prs.length;
      if (elPendingPrs) elPendingPrs.textContent = prs.length; // all initial are pending purchasing
      if (elNavPrCount) elNavPrCount.textContent = prs.length;
      if (elNavSkuCount) elNavSkuCount.textContent = masterItems.length;
    },

    // =========================================================================
    // 3. MASTER CATALOG RENDERING (50 ROWS TABLE)
    // =========================================================================
    async renderMasterCatalogTable() {
      const masterItems = await DataService.getMasterItems();
      const tbody = document.getElementById('masterCatalogTbody');
      const countEl = document.getElementById('catalogRowCount');
      const filterChipsContainer = document.getElementById('filterChipsContainer');

      if (!tbody) return;

      // Calculate Subcategory Breakdown for filter chips
      const subcategories = {};
      masterItems.forEach(item => {
        const sub = item.subCategory || 'Other';
        subcategories[sub] = (subcategories[sub] || 0) + 1;
      });

      // Render Subcategory Filter Chips
      if (filterChipsContainer) {
        let chipsHtml = `
          <button class="filter-chip ${this.activeSubcategoryFilter === 'ALL' ? 'active' : ''}" data-subcat="ALL">
            All Raw Materials <span class="chip-count">${masterItems.length}</span>
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

      // Filter items
      const q = this.searchQuery;
      const filtered = masterItems.filter(item => {
        // Subcategory match
        if (this.activeSubcategoryFilter !== 'ALL' && item.subCategory !== this.activeSubcategoryFilter) {
          return false;
        }
        // Search text match
        if (!q) return true;
        const searchCorpus = [
          item.sku,
          item.productName,
          item.subCategory,
          item.material,
          item.size,
          item.unit,
          item.brand,
          item.sourceSheet || '',
          JSON.stringify(item.specificAttributes || {})
        ].join(' ').toLowerCase();

        return searchCorpus.includes(q);
      });

      if (countEl) {
        countEl.innerHTML = `Showing <strong>${filtered.length}</strong> of <strong>${masterItems.length}</strong> Master Items (50 Default Reference Items Loaded)`;
      }

      if (filtered.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align:center; padding: 3rem 1rem; color: var(--text-muted);">
              <div style="font-size: 2rem; margin-bottom: 0.5rem;">🔍</div>
              <strong>No Raw Material records found matching "${escapeHtml(this.searchQuery)}"</strong>
              <p style="font-size:0.85rem; margin-top:0.25rem;">Try adjusting your search or click "+ Create New SKU" for Engineering verification.</p>
              <button class="btn btn-primary btn-sm" style="margin-top:1rem;" onclick="document.getElementById('btnOpenNewSku').click()">+ Create New SKU</button>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = filtered.map((item, idx) => {
        // Prepare technical specs string
        const specsObj = item.specificAttributes || {};
        const specSummary = Object.entries(specsObj)
          .map(([k, v]) => `<span style="display:inline-block; font-size:0.75rem; background:#f1f5f9; padding:1px 5px; border-radius:3px; margin:1px 2px;"><strong style="color:var(--text-dim);">${k}:</strong> ${v}</span>`)
          .join(' ');

        return `
          <tr data-sku="${escapeHtml(item.sku)}">
            <td style="color: var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
            <td>
              <span class="sku-badge">${escapeHtml(item.sku)}</span>
            </td>
            <td>
              <div style="font-weight: 600; color: var(--text-main);">${escapeHtml(item.productName)}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(item.sourceSheet ? 'Source: ' + item.sourceSheet : '')}</div>
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
              <div class="table-actions">
                <button class="btn btn-primary btn-sm btn-action-pr" data-sku="${escapeHtml(item.sku)}" title="Create Purchase Request with this Master SKU">
                  <span>+ Create PR</span>
                </button>
                <button class="btn btn-secondary btn-sm btn-action-specs" data-sku="${escapeHtml(item.sku)}" title="View Engineering Specifications">
                  <span>Specs</span>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // Bind row action buttons
      tbody.querySelectorAll('.btn-action-pr').forEach(btn => {
        btn.addEventListener('click', () => {
          const sku = btn.getAttribute('data-sku');
          this.openCreatePrModal(sku);
        });
      });

      tbody.querySelectorAll('.btn-action-specs').forEach(btn => {
        btn.addEventListener('click', () => {
          const sku = btn.getAttribute('data-sku');
          this.openSpecsModal(sku);
        });
      });
    },

    // =========================================================================
    // 4. NEW SKU CREATION - ENGINEERING VERIFICATION WORKFLOW
    // =========================================================================
    openNewSkuModal() {
      const modal = document.getElementById('modalNewSku');
      const form = document.getElementById('formNewSku');
      if (!modal || !form) return;

      form.reset();
      
      // Auto-suggest next sequential company SKU (FF-series)
      const nextSku = DataService.getNextSuggestedSKU();
      const skuInput = document.getElementById('newSkuCode');
      if (skuInput) skuInput.value = nextSku;

      // Set default subcategory and trigger dynamic attributes
      const subcatSelect = document.getElementById('newSkuSubcategory');
      if (subcatSelect) {
        subcatSelect.value = 'Marine Plates';
        this.onNewSkuSubcategoryChange('Marine Plates');
      }

      this.validateNewSkuDuplicate();
      modal.classList.add('active');
    },

    onNewSkuSubcategoryChange(subcat) {
      const container = document.getElementById('dynamicSpecFieldsContainer');
      if (!container) return;

      // Render category-specific technical fields based on actual engineering parameters
      if (subcat.includes('Plate') || subcat.includes('Sheet')) {
        container.innerHTML = `
          <div class="form-group">
            <label class="form-label">Thickness (mm) <span class="req">*</span></label>
            <input type="text" id="specThickness" class="form-input" placeholder="e.g. 12" required>
          </div>
          <div class="form-group">
            <label class="form-label">Width (ft / mm) <span class="req">*</span></label>
            <input type="text" id="specWidth" class="form-input" placeholder="e.g. 5 ft (1524 mm)" required>
          </div>
          <div class="form-group">
            <label class="form-label">Length (ft / mm) <span class="req">*</span></label>
            <input type="text" id="specLength" class="form-input" placeholder="e.g. 20 ft (6096 mm)" required>
          </div>
          <div class="form-group">
            <label class="form-label">Standard / Specification</label>
            <input type="text" id="specStandard" class="form-input" placeholder="e.g. ASTM A131 Grade A / JIS G3101">
          </div>
        `;
      } else if (subcat.includes('Beam') || subcat.includes('Channel') || subcat.includes('Angle')) {
        container.innerHTML = `
          <div class="form-group">
            <label class="form-label">Profile / Cross Section (Size) <span class="req">*</span></label>
            <input type="text" id="specProfile" class="form-input" placeholder="e.g. 200x100x5.5x8 or 100 x 50 x 6" required>
          </div>
          <div class="form-group">
            <label class="form-label">Length (m) <span class="req">*</span></label>
            <input type="text" id="specLength" class="form-input" placeholder="e.g. 6 or 12" required>
          </div>
          <div class="form-group">
            <label class="form-label">Flange / Web Details</label>
            <input type="text" id="specFlangeWeb" class="form-input" placeholder="e.g. Web 5.5mm, Flange 8mm">
          </div>
          <div class="form-group">
            <label class="form-label">Standard / Specification</label>
            <input type="text" id="specStandard" class="form-input" placeholder="e.g. JIS G3192 / ASTM A36">
          </div>
        `;
      } else if (subcat.includes('Bar')) {
        container.innerHTML = `
          <div class="form-group">
            <label class="form-label">Diameter (mm) / Profile <span class="req">*</span></label>
            <input type="text" id="specDiameter" class="form-input" placeholder="e.g. 16 mm or D25" required>
          </div>
          <div class="form-group">
            <label class="form-label">Length (m) <span class="req">*</span></label>
            <input type="text" id="specLength" class="form-input" placeholder="e.g. 12" required>
          </div>
          <div class="form-group">
            <label class="form-label">Deformation / Surface Type</label>
            <input type="text" id="specSurface" class="form-input" placeholder="e.g. Ribbed High-Tensile / Plain Smooth">
          </div>
          <div class="form-group">
            <label class="form-label">Standard / Specification</label>
            <input type="text" id="specStandard" class="form-input" placeholder="e.g. SNI 2052:2017 / JIS G3112">
          </div>
        `;
      } else if (subcat.includes('Pipe') || subcat.includes('Tube')) {
        container.innerHTML = `
          <div class="form-group">
            <label class="form-label">Nominal Size / OD <span class="req">*</span></label>
            <input type="text" id="specNominalSize" class="form-input" placeholder="e.g. 2 inch or 75 x 45 mm" required>
          </div>
          <div class="form-group">
            <label class="form-label">Wall Thickness (mm) / Schedule <span class="req">*</span></label>
            <input type="text" id="specWallThk" class="form-input" placeholder="e.g. SCH 80 (5.5mm)" required>
          </div>
          <div class="form-group">
            <label class="form-label">Length (m) <span class="req">*</span></label>
            <input type="text" id="specLength" class="form-input" placeholder="e.g. 6" required>
          </div>
          <div class="form-group">
            <label class="form-label">Inside Diameter (ID mm)</label>
            <input type="text" id="specID" class="form-input" placeholder="e.g. 49.5">
          </div>
        `;
      } else {
        container.innerHTML = `
          <div class="form-group">
            <label class="form-label">Dimensions / Sizing <span class="req">*</span></label>
            <input type="text" id="specGeneralDim" class="form-input" placeholder="e.g. 5.4 x 2.1 m" required>
          </div>
          <div class="form-group">
            <label class="form-label">Technical Specification</label>
            <input type="text" id="specStandard" class="form-input" placeholder="e.g. Mill Standard Spec">
          </div>
        `;
      }
    },

    async validateNewSkuDuplicate() {
      const skuInput = document.getElementById('newSkuCode');
      const nameInput = document.getElementById('newSkuName');
      const alertBanner = document.getElementById('skuDuplicateAlert');
      const btnSubmit = document.getElementById('btnSubmitNewSku');
      if (!skuInput || !alertBanner || !btnSubmit) return;

      const sku = skuInput.value.trim();
      const name = nameInput ? nameInput.value.trim() : '';

      if (!sku) {
        alertBanner.classList.remove('active');
        btnSubmit.disabled = false;
        return;
      }

      const dupCheck = await DataService.checkDuplicate(sku, name);
      if (dupCheck.isDuplicateSku) {
        alertBanner.classList.add('active');
        alertBanner.innerHTML = `
          <div class="alert-icon">⚠️</div>
          <div class="alert-content">
            <h4>Duplicate SKU Detected (${escapeHtml(sku)})</h4>
            <p>This SKU is already registered in the Master Item catalog as: <strong>${escapeHtml(dupCheck.duplicateSkuItem.productName)}</strong> (${escapeHtml(dupCheck.duplicateSkuItem.size || '')}). Duplicate SKU creation is prevented by system rules.</p>
          </div>
        `;
        btnSubmit.disabled = true;
      } else {
        alertBanner.classList.remove('active');
        btnSubmit.disabled = false;
      }
    },

    async handleCreateNewSku() {
      const sku = document.getElementById('newSkuCode').value.trim();
      const productName = document.getElementById('newSkuName').value.trim();
      const subCategory = document.getElementById('newSkuSubcategory').value.trim();
      const material = document.getElementById('newSkuMaterial').value.trim();
      const size = document.getElementById('newSkuSize').value.trim();
      const unit = document.getElementById('newSkuUnit').value.trim();
      const weightKg = parseFloat(document.getElementById('newSkuWeight').value) || 0;
      const brand = document.getElementById('newSkuBrand').value.trim() || 'PT Persada Nusantara Steel';
      const engineerName = document.getElementById('newSkuEngineer').value.trim();
      const engNotes = document.getElementById('newSkuNotes').value.trim();

      // Collect dynamic technical attributes
      const specificAttributes = {};
      const dynInputs = document.querySelectorAll('#dynamicSpecFieldsContainer input');
      dynInputs.forEach(input => {
        const label = input.previousElementSibling ? input.previousElementSibling.textContent.replace('*', '').trim() : input.id;
        if (input.value.trim()) {
          specificAttributes[label] = input.value.trim();
        }
      });
      if (engNotes) specificAttributes['Engineering Verification Notes'] = engNotes;
      if (engineerName) specificAttributes['Verified By Engineer'] = engineerName;

      // Final Duplicate check
      const dup = await DataService.checkDuplicate(sku, productName);
      if (dup.isDuplicateSku) {
        alert(`Cannot save: SKU ${sku} already exists.`);
        return;
      }

      const newItem = {
        sku,
        productName,
        category: 'Raw Materials',
        subCategory,
        material,
        size,
        unit,
        weightKg,
        brand,
        sourceFile: 'Engineering New Master Entry',
        sourceSheet: 'Engineering Verified',
        specificAttributes
      };

      try {
        await DataService.addMasterItem(newItem);
        this.closeAllModals();
        this.showToast('New SKU Verified & Created', `Master Item ${sku} (${productName}) is saved and ready for Purchase Requests.`);
        
        // Refresh UI
        this.updateDashboardStats();
        this.renderMasterCatalogTable();

        // Prompt user if they want to create a PR immediately
        setTimeout(() => {
          if (confirm(`New SKU ${sku} saved to Master Items.\n\nWould you like to create a Purchase Request (PR) for this item now?`)) {
            this.openCreatePrModal(sku);
          }
        }, 300);

      } catch (err) {
        alert('Error creating new SKU: ' + err.message);
      }
    },

    // =========================================================================
    // 5. PURCHASE REQUEST CREATION (WHITE DOCUMENT-STYLE INTERFACE)
    // =========================================================================
    async openCreatePrModal(sku) {
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

      // Populate Locked Master Item Technical Specifications (Single Source of Truth)
      const elSku = document.getElementById('prLockedSku');
      const elCat = document.getElementById('prLockedCategory');
      const elName = document.getElementById('prLockedName');
      const elSubcat = document.getElementById('prLockedSubcat');
      const elMat = document.getElementById('prLockedMaterial');
      const elSize = document.getElementById('prLockedSize');
      const elSpec = document.getElementById('prLockedSpec');
      const elBrand = document.getElementById('prLockedBrand');
      const elUnit = document.getElementById('prLockedUnit');
      const elWeight = document.getElementById('prLockedWeight');
      const elQtyUnit = document.getElementById('prQtyUnitBadge');
      const elCalcWt = document.getElementById('prCalculatedTotalWeight');

      if (elSku) elSku.textContent = item.sku;
      if (elCat) elCat.textContent = item.category || 'Raw Materials';
      if (elName) elName.textContent = item.productName;
      if (elSubcat) elSubcat.textContent = item.subCategory || '-';
      if (elMat) elMat.textContent = item.material || '-';
      if (elSize) elSize.textContent = item.size || '-';
      if (elSpec) elSpec.textContent = item.specification || item.sourceSheet || 'PT Persada Nusantara Steel Standard';
      if (elBrand) elBrand.textContent = item.brand || 'PT Persada Nusantara Steel';
      if (elUnit) elUnit.textContent = item.unit || 'Sheet';
      if (elWeight) elWeight.textContent = item.weightKg ? `${item.weightKg} kg / ${item.unit || 'pc'}` : '-';
      if (elQtyUnit) elQtyUnit.textContent = item.unit || 'Units';
      if (elCalcWt) elCalcWt.textContent = 'Total Est Weight: -';

      // Setup dynamic calculation of total weight on quantity change
      const qtyInput = document.getElementById('prQuantity');
      if (qtyInput) {
        qtyInput.oninput = () => {
          const qty = parseFloat(qtyInput.value) || 0;
          if (qty > 0 && item.weightKg) {
            const tot = (qty * item.weightKg).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const mt = ((qty * item.weightKg) / 1000).toFixed(3);
            if (elCalcWt) elCalcWt.textContent = `Total Est: ${tot} kg (${mt} MT)`;
          } else {
            if (elCalcWt) elCalcWt.textContent = 'Total Est Weight: -';
          }
        };
      }

      // Set default Required Date (1 week from today)
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const dateInput = document.getElementById('prRequiredDate');
      if (dateInput) {
        dateInput.value = nextWeek.toISOString().split('T')[0];
        dateInput.min = new Date().toISOString().split('T')[0];
      }

      modal.classList.add('active');
    },

    async handleCreatePurchaseRequest() {
      if (!this.selectedMasterItemForPR) {
        alert('No Master Item selected!');
        return;
      }

      const item = this.selectedMasterItemForPR;
      const quantity = parseFloat(document.getElementById('prQuantity').value);
      const projectId = document.getElementById('prProjectId').value.trim();
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
      if (!reasonForPurchase) {
        alert('Please enter Reason for Purchase.');
        return;
      }
      if (!requiredDate) {
        alert('Please select Required Date.');
        return;
      }

      const prPayload = {
        // Master Item technical data (Retrieved directly from Master Item, NOT re-entered)
        sku: item.sku,
        productName: item.productName,
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
    // 6. PURCHASE REQUEST REGISTER & WHITE PR DOCUMENT VOUCHER
    // =========================================================================
    async renderPRRegisterTable() {
      const prs = await DataService.getPurchaseRequests();
      const tbody = document.getElementById('prRegisterTbody');
      const countEl = document.getElementById('prRegisterCount');

      if (!tbody) return;
      if (countEl) countEl.innerHTML = `Total <strong>${prs.length}</strong> Purchase Requisitions recorded`;

      if (prs.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align:center; padding: 3rem 1rem; color: var(--text-muted);">
              <div style="font-size: 2rem; margin-bottom: 0.5rem;">📋</div>
              <strong>No Purchase Requests created yet.</strong>
              <p style="font-size:0.85rem; margin-top:0.25rem;">Go to the Raw Materials Catalog, select an existing SKU or create a new SKU to generate a PR.</p>
              <button class="btn btn-primary btn-sm" style="margin-top:1rem;" onclick="UI.switchView('catalog')">Browse Raw Materials</button>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = prs.map((pr, idx) => {
        const urgencyClass = pr.urgency.includes('Urgent') ? 'urgent' : (pr.urgency.includes('Critical') ? 'critical' : 'standard');
        const formattedDate = new Date(pr.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

        return `
          <tr>
            <td style="color:var(--text-dim); font-family:var(--font-mono);">${idx + 1}</td>
            <td>
              <span class="pr-badge">${escapeHtml(pr.prNumber)}</span>
            </td>
            <td>
              <span class="sku-badge">${escapeHtml(pr.sku)}</span>
            </td>
            <td>
              <div style="font-weight:600; color:var(--text-main);">${escapeHtml(pr.productName)}</div>
              <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(pr.material)} | ${escapeHtml(pr.size)}</div>
            </td>
            <td>
              <div style="font-weight:700; color:var(--primary-400); font-family:var(--font-mono); font-size:0.95rem;">
                ${pr.quantity} <span style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(pr.unit)}</span>
              </div>
              ${pr.totalWeightKg ? `<div style="font-size:0.72rem; color:var(--text-dim);">Est. ${parseFloat(pr.totalWeightKg).toLocaleString()} kg</div>` : ''}
            </td>
            <td>
              <div style="font-weight:600; font-family:var(--font-mono); font-size:0.82rem;">${escapeHtml(pr.projectId || 'N/A')}</div>
              <div style="font-size:0.75rem; color:var(--text-muted); max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(pr.reasonForPurchase)}">${escapeHtml(pr.reasonForPurchase)}</div>
            </td>
            <td>
              <span class="urgency-pill ${urgencyClass}">${escapeHtml(pr.urgency)}</span>
              <div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">Need: ${escapeHtml(pr.requiredDate)}</div>
            </td>
            <td>
              <span class="status-pill-submitted">${escapeHtml(pr.status)}</span>
              <div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">By: ${escapeHtml(pr.requestedBy)}</div>
            </td>
            <td>
              <button class="btn btn-secondary btn-sm btn-view-pr-voucher" data-pr="${escapeHtml(pr.prNumber)}" title="View & Print Official Purchase Request">
                <span>View PR</span>
              </button>
            </td>
          </tr>
        `;
      }).join('');

      // Bind PR Voucher button events
      tbody.querySelectorAll('.btn-view-pr-voucher').forEach(btn => {
        btn.addEventListener('click', () => {
          const prNum = btn.getAttribute('data-pr');
          const found = prs.find(p => p.prNumber === prNum);
          if (found) this.openVoucherModal(found);
        });
      });
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
        <!-- SECTION 1: PURCHASE REQUEST SUMMARY -->
        <div class="pr-doc-section">
          <div class="pr-doc-section-title">
            <span>PURCHASE REQUEST SUMMARY</span>
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
              ${escapeHtml(item.productName)}
            </div>
            <div class="spec-attributes-grid">
              <div class="spec-item"><span class="spec-item-label">Category</span><span class="spec-item-val">${escapeHtml(item.category || 'Raw Materials')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Subcategory</span><span class="spec-item-val">${escapeHtml(item.subCategory || '-')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Material / Grade</span><span class="spec-item-val">${escapeHtml(item.material || '-')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Dimensions / Size</span><span class="spec-item-val" style="font-family:var(--font-mono);">${escapeHtml(item.size || '-')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Standard Unit</span><span class="spec-item-val">${escapeHtml(item.unit || 'PCS')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Unit Weight</span><span class="spec-item-val">${item.weightKg ? item.weightKg + ' kg' : '-'}</span></div>
              <div class="spec-item"><span class="spec-item-label">Manufacturer / Mill</span><span class="spec-item-val">${escapeHtml(item.brand || 'PT Persada Nusantara Steel')}</span></div>
              <div class="spec-item"><span class="spec-item-label">Reference Source</span><span class="spec-item-val">${escapeHtml(item.sourceSheet || item.sourceFile || 'Catalog')}</span></div>
            </div>
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

  // Expose UI to global scope
  window.UI = UI;
  window.DataService = DataService;

  // Initialize once DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    UI.init();
  });

})();
