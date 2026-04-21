const InfluxUtils = {
    getConnection() {
        const conn = localStorage.getItem('influxConnection');
        return conn ? JSON.parse(conn) : { server: 'localhost', port: 8086 };
    },

    saveConnection(server, port) {
        localStorage.setItem('influxConnection', JSON.stringify({ server, port }));
    },

    getComplianceConnection() {
        const conn = localStorage.getItem('complianceConnection');
        return conn ? JSON.parse(conn) : { server: 'localhost', port: 8086 };
    },

    saveComplianceConnection(server, port) {
        localStorage.setItem('complianceConnection', JSON.stringify({ server, port }));
    },

    async queryServer(serverConfig, database, queryString) {
        const url = `http://${serverConfig.server}:${serverConfig.port}/query`;
        const params = new URLSearchParams({
            db: database,
            q: queryString
        });

        try {
            const response = await fetch(`${url}?${params}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            throw new Error(`Query failed: ${error.message}`);
        }
    },

    async queryServerNoDb(serverConfig, queryString) {
        const url = `http://${serverConfig.server}:${serverConfig.port}/query`;
        const params = new URLSearchParams({ q: queryString });

        try {
            const response = await fetch(`${url}?${params}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            throw new Error(`Query failed: ${error.message}`);
        }
    },

    async testServerConnection(serverConfig) {
        try {
            const result = await this.queryServerNoDb(serverConfig, 'SHOW DATABASES');
            return { success: true, databases: this.parseDatabases(result) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async query(database, queryString) {
        const conn = this.getConnection();
        const url = `http://${conn.server}:${conn.port}/query`;
        const params = new URLSearchParams({
            db: database,
            q: queryString
        });

        try {
            const response = await fetch(`${url}?${params}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            throw new Error(`Query failed: ${error.message}`);
        }
    },

    async queryNoDb(queryString) {
        const conn = this.getConnection();
        const url = `http://${conn.server}:${conn.port}/query`;
        const params = new URLSearchParams({ q: queryString });

        try {
            const response = await fetch(`${url}?${params}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            throw new Error(`Query failed: ${error.message}`);
        }
    },

    async write(database, lineProtocol) {
        const conn = this.getConnection();
        const url = `http://${conn.server}:${conn.port}/write?db=${encodeURIComponent(database)}`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                body: lineProtocol
            });
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
            }
            return true;
        } catch (error) {
            throw new Error(`Write failed: ${error.message}`);
        }
    },

    async testConnection() {
        try {
            const result = await this.queryNoDb('SHOW DATABASES');
            return { success: true, databases: this.parseDatabases(result) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async getDatabases() {
        const result = await this.queryNoDb('SHOW DATABASES');
        return this.parseDatabases(result);
    },

    async getMeasurements(database) {
        const result = await this.query(database, 'SHOW MEASUREMENTS');
        return this.parseMeasurements(result);
    },

    async getFieldKeys(database, measurement) {
        const result = await this.query(database, `SHOW FIELD KEYS FROM "${measurement}"`);
        return this.parseFieldKeys(result);
    },

    async getTagKeys(database, measurement) {
        const result = await this.query(database, `SHOW TAG KEYS FROM "${measurement}"`);
        return this.parseTagKeys(result);
    },

    parseDatabases(result) {
        if (!result.results || !result.results[0] || !result.results[0].series) {
            return [];
        }
        const series = result.results[0].series[0];
        if (!series || !series.values) return [];
        return series.values.map(v => v[0]).filter(db => db !== '_internal');
    },

    parseMeasurements(result) {
        if (!result.results || !result.results[0] || !result.results[0].series) {
            return [];
        }
        const series = result.results[0].series[0];
        if (!series || !series.values) return [];
        return series.values.map(v => v[0]);
    },

    parseFieldKeys(result) {
        if (!result.results || !result.results[0] || !result.results[0].series) {
            return [];
        }
        const series = result.results[0].series[0];
        if (!series || !series.values) return [];
        return series.values.map(v => ({ name: v[0], type: v[1] }));
    },

    parseTagKeys(result) {
        if (!result.results || !result.results[0] || !result.results[0].series) {
            return [];
        }
        const series = result.results[0].series[0];
        if (!series || !series.values) return [];
        return series.values.map(v => v[0]);
    },

    parseQueryResult(result) {
        if (!result.results || !result.results[0]) {
            return { columns: [], rows: [], error: null };
        }

        if (result.results[0].error) {
            return { columns: [], rows: [], error: result.results[0].error };
        }

        if (!result.results[0].series || !result.results[0].series[0]) {
            return { columns: [], rows: [], error: null };
        }

        const series = result.results[0].series[0];
        return {
            columns: series.columns || [],
            rows: series.values || [],
            name: series.name,
            tags: series.tags,
            error: null
        };
    },

    buildLineProtocol(measurement, tags, fields, timestamp) {
        let line = measurement;

        if (tags && Object.keys(tags).length > 0) {
            const tagStr = Object.entries(tags)
                .filter(([k, v]) => k && v)
                .map(([k, v]) => `${this.escapeTag(k)}=${this.escapeTag(v)}`)
                .join(',');
            if (tagStr) {
                line += ',' + tagStr;
            }
        }

        const fieldStr = Object.entries(fields)
            .filter(([k, v]) => k && v.value !== '')
            .map(([k, v]) => `${this.escapeField(k)}=${this.formatFieldValue(v.value, v.type)}`)
            .join(',');

        if (!fieldStr) {
            throw new Error('At least one field is required');
        }

        line += ' ' + fieldStr;

        if (timestamp) {
            line += ' ' + timestamp;
        }

        return line;
    },

    escapeTag(str) {
        return String(str).replace(/[,= ]/g, '\\$&');
    },

    escapeField(str) {
        return String(str).replace(/[,= ]/g, '\\$&');
    },

    formatFieldValue(value, type) {
        switch (type) {
            case 'int':
                return parseInt(value, 10) + 'i';
            case 'float':
                return parseFloat(value).toString();
            case 'string':
                return '"' + String(value).replace(/"/g, '\\"') + '"';
            case 'bool':
                return value === 'true' || value === true ? 'true' : 'false';
            default:
                return parseFloat(value).toString();
        }
    },

    getTimeRangeQuery(range, startTime, endTime) {
        if (range === 'custom') {
            const start = new Date(startTime).toISOString();
            const end = new Date(endTime).toISOString();
            return `time >= '${start}' AND time <= '${end}'`;
        }
        return `time > now() - ${range}`;
    },

    formatTimestamp(isoString) {
        const date = new Date(isoString);
        return date.toLocaleString();
    },

    formatNanoTimestamp(nanos) {
        const ms = nanos / 1000000;
        const date = new Date(ms);
        return date.toLocaleString();
    }
};

const ConfigUtils = {
    getInfluxConfig() {
        const config = localStorage.getItem('influxConfig');
        return config ? JSON.parse(config) : { databases: {} };
    },

    saveInfluxConfig(config) {
        localStorage.setItem('influxConfig', JSON.stringify(config));
    },

    getVendorConfig() {
        const config = localStorage.getItem('vendorConfig');
        if (config) {
            return JSON.parse(config);
        }
        return this.getDefaultVendorConfig();
    },

    saveVendorConfig(config) {
        localStorage.setItem('vendorConfig', JSON.stringify(config));
    },

    getDefaultVendorConfig() {
        return {
            quicktron: {
                name: 'Quicktron',
                inputType: 'text',
                tags: [
                    'agv_code',
                    'app_camera_server_ipu',
                    'app_fusion_server',
                    'app_low_computer',
                    'app_nginx',
                    'app_ota_bot',
                    'app_qs-hub-platform',
                    'app_quicktron_wrapper',
                    'app_ros_master',
                    'app_upper_computer',
                    'ip',
                    'model_state',
                    'site_name',
                    'state',
                    'status',
                    'version'
                ]
            },
            hai: {
                name: 'Hai',
                inputType: 'text',
                tags: [
                    'ip',
                    'is_successful_run',
                    'kubot_master_version',
                    'kubot_master_version_output_full',
                    'master_ssh_time_sec',
                    'model_state',
                    'site_name',
                    'state',
                    'status',
                    'vda_ssh_time_sec',
                    'vda_version',
                    'vda_version_output_full',
                    'version'
                ]
            }
        };
    },

    getEnabledDatabases() {
        const config = this.getInfluxConfig();
        return Object.entries(config.databases)
            .filter(([_, db]) => db.enabled)
            .map(([name, db]) => ({ name, measurements: db.measurements || [] }));
    },

    getMeasurementsForDatabase(dbName) {
        const config = this.getInfluxConfig();
        const db = config.databases[dbName];
        return db ? db.measurements || [] : [];
    },

    getSiteConfig() {
        const config = localStorage.getItem('siteConfig');
        return config ? JSON.parse(config) : {};
    },

    saveSiteConfig(config) {
        localStorage.setItem('siteConfig', JSON.stringify(config));
    },

    getSiteByName(siteName) {
        const siteConfig = this.getSiteConfig();
        return Object.values(siteConfig).find(site => 
            site.name.toLowerCase() === siteName.toLowerCase()
        );
    }
};

const UIUtils = {
    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },

    showSuccess(message) {
        this.showToast(message, 'success');
    },

    showError(message) {
        this.showToast(message, 'error');
    },

    showInfo(message) {
        this.showToast(message, 'info');
    },

    populateSelect(selectEl, options, placeholder = 'Select...') {
        selectEl.innerHTML = `<option value="">${placeholder}</option>`;
        options.forEach(opt => {
            const option = document.createElement('option');
            if (typeof opt === 'object') {
                option.value = opt.value || opt.name;
                option.textContent = opt.label || opt.name;
            } else {
                option.value = opt;
                option.textContent = opt;
            }
            selectEl.appendChild(option);
        });
    },

    renderTable(columns, rows, containerId) {
        const container = document.getElementById(containerId);
        
        if (!rows || rows.length === 0) {
            container.innerHTML = '<p class="placeholder-text">No data found</p>';
            return;
        }

        let html = '<table><thead><tr>';
        columns.forEach(col => {
            html += `<th>${col}</th>`;
        });
        html += '</tr></thead><tbody>';

        rows.forEach(row => {
            html += '<tr>';
            row.forEach((cell, i) => {
                let value = cell;
                if (columns[i] === 'time' && cell) {
                    value = new Date(cell).toLocaleString();
                }
                html += `<td>${value !== null ? value : ''}</td>`;
            });
            html += '</tr>';
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    },

    exportToCsv(columns, rows, filename = 'export.csv') {
        let csv = columns.join(',') + '\n';
        rows.forEach(row => {
            csv += row.map(cell => {
                if (cell === null || cell === undefined) return '';
                if (typeof cell === 'string' && (cell.includes(',') || cell.includes('"'))) {
                    return '"' + cell.replace(/"/g, '""') + '"';
                }
                return cell;
            }).join(',') + '\n';
        });

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }
};
