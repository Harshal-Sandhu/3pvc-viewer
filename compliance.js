const ComplianceTab = {
    siteData: null,

    init() {
        this.renderSiteDropdown();
        this.bindEvents();
    },

    renderSiteDropdown() {
        const siteConfig = ConfigUtils.getSiteConfig();
        const select = document.getElementById('complianceSite');
        
        select.innerHTML = '<option value="">Select site...</option>';
        
        Object.values(siteConfig).forEach(site => {
            const option = document.createElement('option');
            option.value = site.name;
            option.textContent = site.name;
            select.appendChild(option);
        });
    },

    bindEvents() {
        document.getElementById('refreshCompliance').addEventListener('click', () => {
            this.fetchData();
        });

        document.getElementById('complianceSite').addEventListener('change', () => {
            this.clearResults();
        });
    },

    clearResults() {
        document.getElementById('siteDataTable').innerHTML = 
            '<p class="placeholder-text">Select a site, then click "Fetch Data"</p>';
        document.getElementById('complianceSummary').classList.add('hidden');
        document.getElementById('siteDetails').classList.add('hidden');
        this.siteData = null;
    },

    async fetchData() {
        const site = document.getElementById('complianceSite').value;

        if (!site) {
            UIUtils.showError('Please select a site');
            return;
        }

        UIUtils.showInfo('Fetching data...');

        try {
            await this.fetchSiteData(site);
            this.renderData();
            UIUtils.showSuccess('Data fetched successfully');
        } catch (error) {
            UIUtils.showError(error.message);
        }
    },

    async fetchSiteData(site) {
        const siteConfig = ConfigUtils.getSiteByName(site);
        
        if (!siteConfig || !siteConfig.host) {
            UIUtils.showError('Site not configured or missing host');
            this.siteData = [];
            return;
        }

        const siteConn = {
            server: siteConfig.host,
            port: siteConfig.port || 8086
        };
        
        // Always use fixed database and measurement for compliance
        const database = 'GreyOrange';
        const measurement = 'bot_compliance_details';
        
        // Update site details display
        document.getElementById('siteHost').textContent = `${siteConfig.host}:${siteConfig.port || 8086}`;
        document.getElementById('siteDatabase').textContent = database;
        document.getElementById('siteMeasurement').textContent = measurement;
        document.getElementById('siteDetails').classList.remove('hidden');
        
        // First, ensure database exists
        await this.ensureDatabaseExists(siteConn, database);
        
        const query = `SELECT * FROM "${measurement}" WHERE time > now() - 1d ORDER BY time DESC`;
        
        try {
            const result = await InfluxUtils.queryServer(siteConn, database, query);
            const parsed = InfluxUtils.parseQueryResult(result);
            
            if (parsed.rows.length > 0) {
                this.siteData = parsed.rows.map(row => this.rowToObject(parsed.columns, row));
            } else {
                this.siteData = [];
            }
        } catch (error) {
            console.warn('Could not fetch site data:', error.message);
            this.siteData = [];
            throw error;
        }
    },

    async ensureDatabaseExists(serverConfig, database) {
        try {
            // Create database if not exists
            const createDbQuery = `CREATE DATABASE IF NOT EXISTS "${database}"`;
            await InfluxUtils.queryServerNoDb(serverConfig, createDbQuery);
        } catch (error) {
            console.warn('Could not create database:', error.message);
        }
    },

    rowToObject(columns, row) {
        const obj = {};
        columns.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    },

    renderData() {
        const container = document.getElementById('siteDataTable');

        if (!this.siteData || this.siteData.length === 0) {
            container.innerHTML = '<p class="placeholder-text">No data found. Check if the server is configured correctly.</p>';
            document.getElementById('complianceSummary').classList.add('hidden');
            return;
        }

        const firstRow = this.siteData[0];
        const columns = Object.keys(firstRow).filter(key => key !== 'time');

        let html = '<table><thead><tr><th>Time</th>';
        columns.forEach(col => {
            html += `<th>${this.formatFieldName(col)}</th>`;
        });
        html += '</tr></thead><tbody>';

        this.siteData.forEach(row => {
            const time = row.time ? new Date(row.time).toLocaleString() : '-';
            html += `<tr><td>${time}</td>`;
            columns.forEach(col => {
                html += `<td>${row[col] || '-'}</td>`;
            });
            html += '</tr>';
        });

        html += '</tbody></table>';
        container.innerHTML = html;

        document.getElementById('totalRecordsCount').textContent = this.siteData.length;
        document.getElementById('complianceSummary').classList.remove('hidden');
    },

    formatFieldName(name) {
        return name.split('_').map(word => 
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
    },

    refresh() {
        this.renderSiteDropdown();
    }
};
