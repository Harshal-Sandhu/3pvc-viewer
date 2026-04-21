const AdminTab = {
    influxConfig: null,
    vendorConfig: null,
    siteConfig: null,
    databaseData: {},

    init() {
        this.influxConfig = ConfigUtils.getInfluxConfig();
        this.vendorConfig = ConfigUtils.getVendorConfig();
        this.siteConfig = ConfigUtils.getSiteConfig();
        this.bindEvents();
        this.loadConnectionSettings();
        this.checkLoginStatus();
    },

    bindEvents() {
        document.getElementById('adminLoginBtn').addEventListener('click', () => {
            this.handleLogin();
        });

        document.getElementById('adminPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleLogin();
        });

        document.getElementById('adminLogout').addEventListener('click', () => {
            this.handleLogout();
        });

        document.querySelectorAll('.section-header').forEach(header => {
            header.addEventListener('click', () => {
                header.closest('.collapsible').classList.toggle('collapsed');
            });
        });

        document.getElementById('testConnection').addEventListener('click', () => {
            this.testConnection();
        });

        document.getElementById('saveConnection').addEventListener('click', () => {
            this.saveConnection();
        });

        document.getElementById('testComplianceConnection').addEventListener('click', () => {
            this.testComplianceConnection();
        });

        document.getElementById('saveComplianceConnection').addEventListener('click', () => {
            this.saveComplianceConnection();
        });

        document.getElementById('refreshDatabases').addEventListener('click', () => {
            this.refreshDatabases();
        });

        document.getElementById('saveDbConfig').addEventListener('click', () => {
            this.saveDbConfig();
        });

        document.getElementById('addVendorBtn').addEventListener('click', () => {
            this.addVendor();
        });

        document.getElementById('saveVendorConfig').addEventListener('click', () => {
            this.saveVendorConfig();
        });

        document.getElementById('addSiteBtn').addEventListener('click', () => {
            this.addSite();
        });

        document.getElementById('saveSiteConfig').addEventListener('click', () => {
            this.saveSiteConfig();
        });

        document.getElementById('deleteDatabase').addEventListener('change', (e) => {
            this.onDeleteDatabaseChange(e.target.value);
        });

        document.getElementById('deleteMeasurement').addEventListener('change', () => {
            this.updateDeletePreview();
        });

        document.getElementById('deleteStartTime').addEventListener('change', () => {
            this.updateDeletePreview();
        });

        document.getElementById('deleteEndTime').addEventListener('change', () => {
            this.updateDeletePreview();
        });

        document.getElementById('deleteConfirm').addEventListener('input', (e) => {
            document.getElementById('executeDelete').disabled = e.target.value !== 'DELETE';
        });

        document.getElementById('executeDelete').addEventListener('click', () => {
            this.executeDelete();
        });

        document.getElementById('updateCredentials').addEventListener('click', () => {
            this.updateCredentials();
        });
    },

    checkLoginStatus() {
        if (Auth.isLoggedIn()) {
            this.showAdminContent();
        } else {
            this.showLoginModal();
        }
    },

    async handleLogin() {
        const username = document.getElementById('adminUsername').value.trim();
        const password = document.getElementById('adminPassword').value;

        if (!username || !password) {
            this.showLoginError('Please enter username and password');
            return;
        }

        const result = await Auth.login(username, password);

        if (result.success) {
            this.showAdminContent();
            if (result.isDefault) {
                UIUtils.showInfo('Using default credentials. Please change your password.');
            }
        } else {
            this.showLoginError(result.error);
        }
    },

    handleLogout() {
        Auth.logout();
        this.showLoginModal();
        document.getElementById('adminUsername').value = '';
        document.getElementById('adminPassword').value = '';
        UIUtils.showInfo('Logged out successfully');
    },

    showLoginModal() {
        document.getElementById('adminLoginModal').classList.remove('hidden');
        document.getElementById('adminContent').classList.add('hidden');
        document.getElementById('loginError').classList.add('hidden');
    },

    showAdminContent() {
        document.getElementById('adminLoginModal').classList.add('hidden');
        document.getElementById('adminContent').classList.remove('hidden');
        this.loadAdminData();
    },

    showLoginError(message) {
        const errorEl = document.getElementById('loginError');
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    },

    loadConnectionSettings() {
        const conn = InfluxUtils.getConnection();
        document.getElementById('serverHost').value = conn.server;
        document.getElementById('serverPort').value = conn.port;

        const complianceConn = InfluxUtils.getComplianceConnection();
        document.getElementById('complianceServerHost').value = complianceConn.server;
        document.getElementById('complianceServerPort').value = complianceConn.port;
    },

    loadAdminData() {
        this.renderDatabaseList();
        this.renderVendorConfig();
        this.renderSiteConfig();
        this.loadDeleteDatabases();
    },

    async testConnection() {
        const server = document.getElementById('serverHost').value.trim();
        const port = document.getElementById('serverPort').value.trim();

        if (!server || !port) {
            UIUtils.showError('Please enter server host and port');
            return;
        }

        InfluxUtils.saveConnection(server, parseInt(port));

        const resultEl = document.getElementById('connectionTestResult');
        resultEl.classList.remove('hidden', 'success', 'error');
        resultEl.textContent = 'Testing connection...';

        const result = await InfluxUtils.testConnection();

        if (result.success) {
            resultEl.classList.add('success');
            resultEl.textContent = `Connected! Found ${result.databases.length} database(s): ${result.databases.join(', ')}`;
            this.updateConnectionStatus(true);
        } else {
            resultEl.classList.add('error');
            resultEl.textContent = `Connection failed: ${result.error}`;
            this.updateConnectionStatus(false);
        }
    },

    saveConnection() {
        const server = document.getElementById('serverHost').value.trim();
        const port = document.getElementById('serverPort').value.trim();

        if (!server || !port) {
            UIUtils.showError('Please enter server host and port');
            return;
        }

        InfluxUtils.saveConnection(server, parseInt(port));
        UIUtils.showSuccess('Primary connection settings saved');
    },

    async testComplianceConnection() {
        const server = document.getElementById('complianceServerHost').value.trim();
        const port = document.getElementById('complianceServerPort').value.trim();

        if (!server || !port) {
            UIUtils.showError('Please enter compliance server host and port');
            return;
        }

        const serverConfig = { server, port: parseInt(port) };
        const resultEl = document.getElementById('complianceConnectionTestResult');
        resultEl.classList.remove('hidden', 'success', 'error');
        resultEl.textContent = 'Testing connection...';

        const result = await InfluxUtils.testServerConnection(serverConfig);

        if (result.success) {
            resultEl.classList.add('success');
            resultEl.textContent = `Connected! Found ${result.databases.length} database(s): ${result.databases.join(', ')}`;
        } else {
            resultEl.classList.add('error');
            resultEl.textContent = `Connection failed: ${result.error}`;
        }
    },

    saveComplianceConnection() {
        const server = document.getElementById('complianceServerHost').value.trim();
        const port = document.getElementById('complianceServerPort').value.trim();

        if (!server || !port) {
            UIUtils.showError('Please enter compliance server host and port');
            return;
        }

        InfluxUtils.saveComplianceConnection(server, parseInt(port));
        UIUtils.showSuccess('Compliance server settings saved');
    },

    updateConnectionStatus(connected) {
        const statusEl = document.getElementById('connectionStatus');
        const dot = statusEl.querySelector('.status-dot');
        const text = statusEl.querySelector('.status-text');

        dot.classList.toggle('connected', connected);
        dot.classList.toggle('disconnected', !connected);
        text.textContent = connected ? 'Connected' : 'Disconnected';
    },

    async refreshDatabases() {
        try {
            UIUtils.showInfo('Fetching databases...');
            const databases = await InfluxUtils.getDatabases();
            
            this.databaseData = {};
            databases.forEach(db => {
                const existing = this.influxConfig.databases[db];
                this.databaseData[db] = {
                    enabled: existing ? existing.enabled : false,
                    measurements: existing ? existing.measurements : [],
                    allMeasurements: []
                };
            });

            this.renderDatabaseList();
            UIUtils.showSuccess(`Found ${databases.length} database(s)`);
        } catch (error) {
            UIUtils.showError(error.message);
        }
    },

    renderDatabaseList() {
        const container = document.getElementById('databaseList');
        
        if (Object.keys(this.databaseData).length === 0) {
            const savedConfig = ConfigUtils.getInfluxConfig();
            if (Object.keys(savedConfig.databases).length > 0) {
                Object.entries(savedConfig.databases).forEach(([name, config]) => {
                    this.databaseData[name] = {
                        enabled: config.enabled,
                        measurements: config.measurements || [],
                        allMeasurements: config.measurements || []
                    };
                });
            } else {
                container.innerHTML = '<p class="placeholder-text">Click "Refresh Databases" to load...</p>';
                return;
            }
        }

        container.innerHTML = Object.entries(this.databaseData).map(([dbName, dbData]) => `
            <div class="database-item" data-db="${dbName}">
                <div class="database-header">
                    <div class="database-name">
                        <span class="collapse-icon">▶</span>
                        <span>${dbName}</span>
                    </div>
                    <div class="database-toggle">
                        <span>Enable</span>
                        <label class="toggle-switch">
                            <input type="checkbox" class="db-enabled" ${dbData.enabled ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
                <div class="database-measurements">
                    <button class="btn btn-sm fetch-measurements" data-db="${dbName}">Fetch Measurements</button>
                    <div class="measurement-list" id="measurements-${dbName}">
                        ${this.renderMeasurementList(dbName, dbData)}
                    </div>
                    <div class="add-inline">
                        <input type="text" class="form-input add-measurement-input" placeholder="Add custom measurement">
                        <button class="btn btn-sm add-measurement-btn" data-db="${dbName}">Add</button>
                    </div>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.database-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (!e.target.closest('.database-toggle')) {
                    header.closest('.database-item').classList.toggle('expanded');
                }
            });
        });

        container.querySelectorAll('.fetch-measurements').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.fetchMeasurements(btn.dataset.db);
            });
        });

        container.querySelectorAll('.add-measurement-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = btn.previousElementSibling;
                const measurement = input.value.trim();
                if (measurement) {
                    this.addMeasurement(btn.dataset.db, measurement);
                    input.value = '';
                }
            });
        });

        container.querySelectorAll('.db-enabled').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const dbName = e.target.closest('.database-item').dataset.db;
                this.databaseData[dbName].enabled = e.target.checked;
            });
        });
    },

    renderMeasurementList(dbName, dbData) {
        const measurements = dbData.allMeasurements.length > 0 ? dbData.allMeasurements : dbData.measurements;
        
        if (measurements.length === 0) {
            return '<p class="placeholder-text">No measurements. Click "Fetch Measurements" or add custom.</p>';
        }

        return measurements.map(m => `
            <div class="measurement-item">
                <input type="checkbox" class="measurement-enabled" data-db="${dbName}" data-measurement="${m}" 
                    ${dbData.measurements.includes(m) ? 'checked' : ''}>
                <span>${m}</span>
            </div>
        `).join('');
    },

    async fetchMeasurements(dbName) {
        try {
            UIUtils.showInfo(`Fetching measurements for ${dbName}...`);
            const measurements = await InfluxUtils.getMeasurements(dbName);
            
            this.databaseData[dbName].allMeasurements = measurements;
            
            const container = document.getElementById(`measurements-${dbName}`);
            container.innerHTML = this.renderMeasurementList(dbName, this.databaseData[dbName]);

            container.querySelectorAll('.measurement-enabled').forEach(checkbox => {
                checkbox.addEventListener('change', (e) => {
                    this.toggleMeasurement(e.target.dataset.db, e.target.dataset.measurement, e.target.checked);
                });
            });

            UIUtils.showSuccess(`Found ${measurements.length} measurement(s)`);
        } catch (error) {
            UIUtils.showError(error.message);
        }
    },

    addMeasurement(dbName, measurement) {
        if (!this.databaseData[dbName].allMeasurements.includes(measurement)) {
            this.databaseData[dbName].allMeasurements.push(measurement);
        }
        if (!this.databaseData[dbName].measurements.includes(measurement)) {
            this.databaseData[dbName].measurements.push(measurement);
        }

        const container = document.getElementById(`measurements-${dbName}`);
        container.innerHTML = this.renderMeasurementList(dbName, this.databaseData[dbName]);

        container.querySelectorAll('.measurement-enabled').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                this.toggleMeasurement(e.target.dataset.db, e.target.dataset.measurement, e.target.checked);
            });
        });
    },

    toggleMeasurement(dbName, measurement, enabled) {
        const measurements = this.databaseData[dbName].measurements;
        
        if (enabled && !measurements.includes(measurement)) {
            measurements.push(measurement);
        } else if (!enabled) {
            const index = measurements.indexOf(measurement);
            if (index > -1) {
                measurements.splice(index, 1);
            }
        }
    },

    saveDbConfig() {
        const config = { databases: {} };

        Object.entries(this.databaseData).forEach(([dbName, dbData]) => {
            config.databases[dbName] = {
                enabled: dbData.enabled,
                measurements: dbData.measurements
            };
        });

        ConfigUtils.saveInfluxConfig(config);
        this.influxConfig = config;
        
        QueryTab.loadDatabases();
        WriteTab.loadDatabases();
        
        UIUtils.showSuccess('Database configuration saved');
    },

    renderVendorConfig() {
        const container = document.getElementById('vendorConfigList');
        
        container.innerHTML = Object.entries(this.vendorConfig).map(([key, vendor]) => `
            <div class="vendor-config-item" data-vendor="${key}">
                <div class="vendor-config-header">
                    <input type="text" class="form-input vendor-name" value="${vendor.name}" placeholder="Vendor name">
                    <button class="btn btn-icon btn-remove-vendor" title="Remove vendor">×</button>
                </div>
                
                <div class="vendor-sites">
                    <label>Sites</label>
                    <div class="sites-list">
                        ${vendor.sites.map(site => `
                            <span class="site-tag">
                                ${site}
                                <button class="remove-site" data-site="${site}">×</button>
                            </span>
                        `).join('')}
                    </div>
                    <div class="add-inline">
                        <input type="text" class="form-input add-site-input" placeholder="Add site">
                        <button class="btn btn-sm add-site-btn">Add</button>
                    </div>
                </div>

                <div class="vendor-custom-fields">
                    <label>Custom Fields</label>
                    ${Object.entries(vendor.fields).map(([fieldName, options]) => `
                        <div class="custom-field-group" data-field="${fieldName}">
                            <div class="custom-field-header">
                                <input type="text" class="form-input field-name-input" value="${fieldName}" placeholder="Field name">
                                <button class="btn btn-icon remove-field-btn">×</button>
                            </div>
                            <div class="field-options-list">
                                ${options.map(opt => `
                                    <span class="field-option-tag">
                                        ${opt}
                                        <button class="remove-option" data-option="${opt}">×</button>
                                    </span>
                                `).join('')}
                            </div>
                            <div class="add-inline">
                                <input type="text" class="form-input add-option-input" placeholder="Add option">
                                <button class="btn btn-sm add-option-btn">Add</button>
                            </div>
                        </div>
                    `).join('')}
                    <button class="btn btn-sm add-field-btn">+ Add Field</button>
                </div>
            </div>
        `).join('');

        this.bindVendorEvents();
    },

    bindVendorEvents() {
        document.querySelectorAll('.btn-remove-vendor').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const vendorKey = e.target.closest('.vendor-config-item').dataset.vendor;
                delete this.vendorConfig[vendorKey];
                this.renderVendorConfig();
            });
        });

        document.querySelectorAll('.vendor-name').forEach(input => {
            input.addEventListener('change', (e) => {
                const vendorKey = e.target.closest('.vendor-config-item').dataset.vendor;
                this.vendorConfig[vendorKey].name = e.target.value;
            });
        });

        document.querySelectorAll('.add-site-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const vendorItem = e.target.closest('.vendor-config-item');
                const vendorKey = vendorItem.dataset.vendor;
                const input = vendorItem.querySelector('.add-site-input');
                const site = input.value.trim();
                
                if (site && !this.vendorConfig[vendorKey].sites.includes(site)) {
                    this.vendorConfig[vendorKey].sites.push(site);
                    this.renderVendorConfig();
                }
            });
        });

        document.querySelectorAll('.remove-site').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const vendorKey = e.target.closest('.vendor-config-item').dataset.vendor;
                const site = e.target.dataset.site;
                const sites = this.vendorConfig[vendorKey].sites;
                const index = sites.indexOf(site);
                if (index > -1) {
                    sites.splice(index, 1);
                    this.renderVendorConfig();
                }
            });
        });

        document.querySelectorAll('.add-field-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const vendorKey = e.target.closest('.vendor-config-item').dataset.vendor;
                const fieldName = `field_${Date.now()}`;
                this.vendorConfig[vendorKey].fields[fieldName] = [];
                this.renderVendorConfig();
            });
        });

        document.querySelectorAll('.remove-field-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const vendorKey = e.target.closest('.vendor-config-item').dataset.vendor;
                const fieldName = e.target.closest('.custom-field-group').dataset.field;
                delete this.vendorConfig[vendorKey].fields[fieldName];
                this.renderVendorConfig();
            });
        });

        document.querySelectorAll('.field-name-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const vendorKey = e.target.closest('.vendor-config-item').dataset.vendor;
                const oldFieldName = e.target.closest('.custom-field-group').dataset.field;
                const newFieldName = e.target.value.trim();
                
                if (newFieldName && newFieldName !== oldFieldName) {
                    this.vendorConfig[vendorKey].fields[newFieldName] = this.vendorConfig[vendorKey].fields[oldFieldName];
                    delete this.vendorConfig[vendorKey].fields[oldFieldName];
                    this.renderVendorConfig();
                }
            });
        });

        document.querySelectorAll('.add-option-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const vendorKey = e.target.closest('.vendor-config-item').dataset.vendor;
                const fieldName = e.target.closest('.custom-field-group').dataset.field;
                const input = e.target.previousElementSibling;
                const option = input.value.trim();
                
                if (option && !this.vendorConfig[vendorKey].fields[fieldName].includes(option)) {
                    this.vendorConfig[vendorKey].fields[fieldName].push(option);
                    this.renderVendorConfig();
                }
            });
        });

        document.querySelectorAll('.remove-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const vendorKey = e.target.closest('.vendor-config-item').dataset.vendor;
                const fieldName = e.target.closest('.custom-field-group').dataset.field;
                const option = e.target.dataset.option;
                const options = this.vendorConfig[vendorKey].fields[fieldName];
                const index = options.indexOf(option);
                if (index > -1) {
                    options.splice(index, 1);
                    this.renderVendorConfig();
                }
            });
        });
    },

    addVendor() {
        const key = `vendor_${Date.now()}`;
        this.vendorConfig[key] = {
            name: 'New Vendor',
            sites: [],
            fields: {}
        };
        this.renderVendorConfig();
    },

    saveVendorConfig() {
        ConfigUtils.saveVendorConfig(this.vendorConfig);
        WriteTab.loadVendors();
        UIUtils.showSuccess('Vendor configuration saved');
    },

    renderSiteConfig() {
        const container = document.getElementById('siteConfigList');
        
        if (!this.siteConfig || Object.keys(this.siteConfig).length === 0) {
            container.innerHTML = '<p class="placeholder-text">No sites configured. Click "Add Site" to create one.</p>';
            return;
        }

        container.innerHTML = Object.entries(this.siteConfig).map(([key, site]) => `
            <div class="site-config-item" data-site="${key}">
                <div class="site-config-header">
                    <h4>${site.name}</h4>
                    <div class="site-status ${site.lastStatus || 'disconnected'}">
                        <span class="status-dot"></span>
                        <span>${site.lastStatus === 'connected' ? 'Connected' : 'Not tested'}</span>
                    </div>
                </div>
                <div class="site-config-fields">
                    <div class="form-group">
                        <label>Site Name</label>
                        <input type="text" class="form-input site-name-input" value="${site.name}" placeholder="Site name">
                    </div>
                    <div class="form-group">
                        <label>InfluxDB Host</label>
                        <input type="text" class="form-input site-host-input" value="${site.host || ''}" placeholder="e.g., 192.168.1.100">
                    </div>
                    <div class="form-group">
                        <label>Port</label>
                        <input type="number" class="form-input site-port-input" value="${site.port || 8086}" placeholder="8086">
                    </div>
                    <div class="form-group">
                        <label>Database</label>
                        <input type="text" class="form-input site-database-input" value="${site.database || 'GreyOrange'}" placeholder="GreyOrange">
                    </div>
                    <div class="form-group">
                        <label>Measurement</label>
                        <input type="text" class="form-input site-measurement-input" value="${site.measurement || 'x'}" placeholder="x">
                    </div>
                </div>
                <div class="site-config-actions">
                    <button class="btn btn-sm test-site-btn" data-site="${key}">Test Connection</button>
                    <button class="btn btn-sm btn-danger remove-site-btn" data-site="${key}">Remove</button>
                </div>
            </div>
        `).join('');

        this.bindSiteEvents();
    },

    bindSiteEvents() {
        document.querySelectorAll('.site-config-item').forEach(item => {
            const siteKey = item.dataset.site;
            
            item.querySelector('.site-name-input').addEventListener('change', (e) => {
                this.siteConfig[siteKey].name = e.target.value.trim();
            });

            item.querySelector('.site-host-input').addEventListener('change', (e) => {
                this.siteConfig[siteKey].host = e.target.value.trim();
            });

            item.querySelector('.site-port-input').addEventListener('change', (e) => {
                this.siteConfig[siteKey].port = parseInt(e.target.value) || 8086;
            });

            item.querySelector('.site-database-input').addEventListener('change', (e) => {
                this.siteConfig[siteKey].database = e.target.value.trim();
            });

            item.querySelector('.site-measurement-input').addEventListener('change', (e) => {
                this.siteConfig[siteKey].measurement = e.target.value.trim();
            });
        });

        document.querySelectorAll('.test-site-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const siteKey = e.target.dataset.site;
                this.testSiteConnection(siteKey);
            });
        });

        document.querySelectorAll('.remove-site-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const siteKey = e.target.dataset.site;
                if (confirm(`Remove site "${this.siteConfig[siteKey].name}"?`)) {
                    delete this.siteConfig[siteKey];
                    this.renderSiteConfig();
                }
            });
        });
    },

    async testSiteConnection(siteKey) {
        const site = this.siteConfig[siteKey];
        const statusEl = document.querySelector(`.site-config-item[data-site="${siteKey}"] .site-status`);
        
        if (!site.host) {
            UIUtils.showError('Please enter a host address');
            return;
        }

        statusEl.innerHTML = '<span>Testing...</span>';
        statusEl.className = 'site-status';

        try {
            const serverConfig = {
                server: site.host,
                port: site.port || 8086
            };
            await InfluxUtils.testServerConnection(serverConfig);
            
            this.siteConfig[siteKey].lastStatus = 'connected';
            statusEl.innerHTML = '<span class="status-dot"></span><span>Connected</span>';
            statusEl.className = 'site-status connected';
            UIUtils.showSuccess(`Connected to ${site.name}`);
        } catch (error) {
            this.siteConfig[siteKey].lastStatus = 'disconnected';
            statusEl.innerHTML = '<span class="status-dot"></span><span>Failed</span>';
            statusEl.className = 'site-status disconnected';
            UIUtils.showError(`Connection failed: ${error.message}`);
        }
    },

    addSite() {
        const siteKey = `site_${Date.now()}`;
        this.siteConfig[siteKey] = {
            name: 'New Site',
            host: '',
            port: 8086,
            database: 'GreyOrange',
            measurement: 'x',
            lastStatus: null
        };
        this.renderSiteConfig();
    },

    saveSiteConfig() {
        ConfigUtils.saveSiteConfig(this.siteConfig);
        UIUtils.showSuccess('Site configuration saved');
    },

    loadDeleteDatabases() {
        const databases = ConfigUtils.getEnabledDatabases();
        const select = document.getElementById('deleteDatabase');
        UIUtils.populateSelect(select, databases.map(db => db.name), 'Select database...');
    },

    onDeleteDatabaseChange(dbName) {
        const measurementSelect = document.getElementById('deleteMeasurement');
        
        if (!dbName) {
            measurementSelect.disabled = true;
            measurementSelect.innerHTML = '<option value="">Select measurement...</option>';
            return;
        }

        const measurements = ConfigUtils.getMeasurementsForDatabase(dbName);
        UIUtils.populateSelect(measurementSelect, measurements, 'Select measurement...');
        measurementSelect.disabled = false;
        this.updateDeletePreview();
    },

    updateDeletePreview() {
        const preview = document.getElementById('deleteQueryPreview');
        const measurement = document.getElementById('deleteMeasurement').value;
        const startTime = document.getElementById('deleteStartTime').value;
        const endTime = document.getElementById('deleteEndTime').value;

        if (!measurement) {
            preview.textContent = 'Select a measurement to see query...';
            return;
        }

        let query = `DELETE FROM "${measurement}"`;

        if (startTime || endTime) {
            const conditions = [];
            if (startTime) {
                conditions.push(`time >= '${new Date(startTime).toISOString()}'`);
            }
            if (endTime) {
                conditions.push(`time <= '${new Date(endTime).toISOString()}'`);
            }
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        preview.textContent = query;
    },

    async executeDelete() {
        const database = document.getElementById('deleteDatabase').value;
        const measurement = document.getElementById('deleteMeasurement').value;

        if (!database || !measurement) {
            UIUtils.showError('Please select database and measurement');
            return;
        }

        const query = document.getElementById('deleteQueryPreview').textContent;

        try {
            UIUtils.showInfo('Executing delete...');
            await InfluxUtils.query(database, query);
            UIUtils.showSuccess('Data deleted successfully');
            
            document.getElementById('deleteConfirm').value = '';
            document.getElementById('executeDelete').disabled = true;
        } catch (error) {
            UIUtils.showError(error.message);
        }
    },

    async updateCredentials() {
        const currentPassword = document.getElementById('currentPassword').value;
        const newUsername = document.getElementById('newUsername').value.trim();
        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;

        const errorEl = document.getElementById('credentialError');
        errorEl.classList.add('hidden');

        if (!currentPassword || !newUsername || !newPassword || !confirmPassword) {
            errorEl.textContent = 'All fields are required';
            errorEl.classList.remove('hidden');
            return;
        }

        if (newPassword !== confirmPassword) {
            errorEl.textContent = 'Passwords do not match';
            errorEl.classList.remove('hidden');
            return;
        }

        if (newPassword.length < 6) {
            errorEl.textContent = 'Password must be at least 6 characters';
            errorEl.classList.remove('hidden');
            return;
        }

        const result = await Auth.updateCredentials(currentPassword, newUsername, newPassword);

        if (result.success) {
            UIUtils.showSuccess('Credentials updated successfully');
            document.getElementById('currentPassword').value = '';
            document.getElementById('newUsername').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
        } else {
            errorEl.textContent = result.error;
            errorEl.classList.remove('hidden');
        }
    }
};
