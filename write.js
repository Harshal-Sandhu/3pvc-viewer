const WriteTab = {
    currentVendor: 'quicktron',

    init() {
        this.bindEvents();
        this.loadDatabases();
        this.loadSiteDropdowns();
    },

    loadSiteDropdowns() {
        const siteConfig = ConfigUtils.getSiteConfig();
        const dropdowns = document.querySelectorAll('.site-dropdown');
        
        dropdowns.forEach(select => {
            const currentValue = select.value;
            select.innerHTML = '<option value="">Select site...</option>';
            
            Object.values(siteConfig).forEach(site => {
                const option = document.createElement('option');
                option.value = site.name;
                option.textContent = site.name;
                select.appendChild(option);
            });
            
            if (currentValue) {
                select.value = currentValue;
            }
        });
    },

    bindEvents() {
        document.getElementById('writeDatabase').addEventListener('change', (e) => {
            this.onDatabaseChange(e.target.value);
        });

        document.getElementById('writeMeasurement').addEventListener('change', () => {
            this.updatePreview();
        });

        // Vendor tab switching
        document.querySelectorAll('.vendor-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchVendor(btn.dataset.vendor);
            });
        });

        // Tag input listeners (both input and select)
        document.querySelectorAll('.vendor-tag').forEach(el => {
            el.addEventListener('input', () => this.updatePreview());
            el.addEventListener('change', () => this.updatePreview());
        });

        // Custom tag buttons
        document.getElementById('qt-add-custom-tag').addEventListener('click', () => {
            this.addCustomTag('qt');
        });

        document.getElementById('hai-add-custom-tag').addEventListener('click', () => {
            this.addCustomTag('hai');
        });

        document.getElementById('addFieldBtn').addEventListener('click', () => {
            this.addFieldEntry();
        });

        document.getElementById('fieldEntries').addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-remove-field')) {
                this.removeFieldEntry(e.target);
            }
        });

        document.getElementById('fieldEntries').addEventListener('input', () => {
            this.updatePreview();
        });

        document.querySelectorAll('input[name="timestampOption"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.getElementById('customTimestamp').classList.toggle('hidden', e.target.value !== 'custom');
                this.updatePreview();
            });
        });

        document.getElementById('customTimestamp').addEventListener('change', () => {
            this.updatePreview();
        });

        document.getElementById('writeData').addEventListener('click', () => {
            this.writeData();
        });
    },

    addCustomTag(prefix) {
        const nameInput = document.getElementById(`${prefix}-new-tag-name`);
        const valueInput = document.getElementById(`${prefix}-new-tag-value`);
        const tagName = nameInput.value.trim();
        const tagValue = valueInput.value.trim();

        if (!tagName || !tagValue) {
            UIUtils.showError('Please enter both tag name and value');
            return;
        }

        const container = document.getElementById(`${prefix}-custom-tags`);
        const entry = document.createElement('div');
        entry.className = 'custom-tag-entry';
        entry.innerHTML = `
            <input type="text" class="form-input custom-tag-name" value="${tagName}" readonly>
            <input type="text" class="form-input custom-tag-value" value="${tagValue}">
            <button class="btn btn-icon btn-remove-custom-tag" title="Remove">×</button>
        `;
        container.appendChild(entry);

        // Clear inputs
        nameInput.value = '';
        valueInput.value = '';

        // Add event listeners
        entry.querySelector('.custom-tag-value').addEventListener('input', () => this.updatePreview());
        entry.querySelector('.btn-remove-custom-tag').addEventListener('click', () => {
            entry.remove();
            this.updatePreview();
        });

        this.updatePreview();
    },

    switchVendor(vendor) {
        this.currentVendor = vendor;

        // Update tab buttons
        document.querySelectorAll('.vendor-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.vendor === vendor);
        });

        // Show/hide tag panels
        document.getElementById('quicktron-tags').classList.toggle('active', vendor === 'quicktron');
        document.getElementById('quicktron-tags').classList.toggle('hidden', vendor !== 'quicktron');
        document.getElementById('hai-tags').classList.toggle('active', vendor === 'hai');
        document.getElementById('hai-tags').classList.toggle('hidden', vendor !== 'hai');

        this.updatePreview();
    },

    loadDatabases() {
        const databases = ConfigUtils.getEnabledDatabases();
        const select = document.getElementById('writeDatabase');
        UIUtils.populateSelect(select, databases.map(db => db.name), 'Select database...');
    },

    onDatabaseChange(dbName) {
        const measurementSelect = document.getElementById('writeMeasurement');
        
        if (!dbName) {
            measurementSelect.disabled = true;
            measurementSelect.innerHTML = '<option value="">Select measurement...</option>';
            return;
        }

        const measurements = ConfigUtils.getMeasurementsForDatabase(dbName);
        UIUtils.populateSelect(measurementSelect, measurements, 'Select measurement...');
        measurementSelect.disabled = false;
        this.updatePreview();
    },

    addFieldEntry() {
        const container = document.getElementById('fieldEntries');
        const entry = document.createElement('div');
        entry.className = 'field-entry';
        entry.innerHTML = `
            <input type="text" class="form-input field-key" placeholder="Field name">
            <select class="form-select field-type">
                <option value="float">Float</option>
                <option value="int">Integer</option>
                <option value="string">String</option>
                <option value="bool">Boolean</option>
            </select>
            <input type="text" class="form-input field-value" placeholder="Value">
            <button class="btn btn-icon btn-remove-field" title="Remove">×</button>
        `;
        container.appendChild(entry);

        entry.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('input', () => this.updatePreview());
            el.addEventListener('change', () => this.updatePreview());
        });
    },

    removeFieldEntry(button) {
        const entries = document.querySelectorAll('.field-entry');
        if (entries.length > 1) {
            button.closest('.field-entry').remove();
            this.updatePreview();
        } else {
            UIUtils.showError('At least one field is required');
        }
    },

    collectTags() {
        const tags = { vendor: this.currentVendor };
        const prefix = this.currentVendor === 'quicktron' ? 'qt' : 'hai';
        
        // Get the active vendor panel
        const activePanel = document.getElementById(`${this.currentVendor}-tags`);
        
        // Collect all filled tag inputs from the active panel
        activePanel.querySelectorAll('.vendor-tag').forEach(input => {
            const tagName = input.dataset.tag;
            const value = input.value.trim();
            if (tagName && value) {
                tags[tagName] = value;
            }
        });

        // Collect custom tags
        const customTagsContainer = document.getElementById(`${prefix}-custom-tags`);
        customTagsContainer.querySelectorAll('.custom-tag-entry').forEach(entry => {
            const tagName = entry.querySelector('.custom-tag-name').value.trim();
            const tagValue = entry.querySelector('.custom-tag-value').value.trim();
            if (tagName && tagValue) {
                tags[tagName] = tagValue;
            }
        });

        return tags;
    },

    collectFields() {
        const fields = {};
        
        document.querySelectorAll('.field-entry').forEach(entry => {
            const key = entry.querySelector('.field-key').value.trim();
            const type = entry.querySelector('.field-type').value;
            const value = entry.querySelector('.field-value').value.trim();
            
            if (key && value) {
                fields[key] = { value, type };
            }
        });

        return fields;
    },

    getTimestamp() {
        const option = document.querySelector('input[name="timestampOption"]:checked').value;
        
        if (option === 'custom') {
            const customTime = document.getElementById('customTimestamp').value;
            if (customTime) {
                return new Date(customTime).getTime() * 1000000;
            }
        }
        
        return null;
    },

    updatePreview() {
        const preview = document.getElementById('lineProtocolPreview');
        
        const measurement = document.getElementById('writeMeasurement').value;
        if (!measurement) {
            preview.textContent = 'Select a measurement to see preview...';
            return;
        }

        const tags = this.collectTags();
        let fields = this.collectFields();

        // Show default field if none provided
        if (Object.keys(fields).length === 0) {
            fields['logged'] = { value: 'true', type: 'bool' };
        }

        try {
            const timestamp = this.getTimestamp();
            const lineProtocol = InfluxUtils.buildLineProtocol(measurement, tags, fields, timestamp);
            preview.textContent = lineProtocol;
        } catch (error) {
            preview.textContent = `Error: ${error.message}`;
        }
    },

    async writeData() {
        const database = document.getElementById('writeDatabase').value;
        const measurement = document.getElementById('writeMeasurement').value;

        if (!database) {
            UIUtils.showError('Please select a database');
            return;
        }

        if (!measurement) {
            UIUtils.showError('Please select a measurement');
            return;
        }

        const tags = this.collectTags();
        let fields = this.collectFields();

        // Auto-add default field if none provided
        if (Object.keys(fields).length === 0) {
            fields['logged'] = { value: 'true', type: 'bool' };
        }

        // Confirmation popup
        if (!confirm('Are you sure you want to write this data?')) {
            return;
        }

        try {
            const timestamp = this.getTimestamp();
            const lineProtocol = InfluxUtils.buildLineProtocol(measurement, tags, fields, timestamp);

            UIUtils.showInfo('Writing data...');
            await InfluxUtils.write(database, lineProtocol);
            
            this.showWriteResponse(true, 'Data written successfully!');
            UIUtils.showSuccess('Data written successfully');

        } catch (error) {
            this.showWriteResponse(false, error.message);
            UIUtils.showError(error.message);
        }
    },

    showWriteResponse(success, message) {
        const responsePanel = document.getElementById('writeResponse');
        responsePanel.classList.remove('hidden', 'success', 'error');
        responsePanel.classList.add(success ? 'success' : 'error');
        responsePanel.querySelector('.response-content').textContent = message;
    },

    refresh() {
        this.loadDatabases();
        this.loadSiteDropdowns();
    }
};
