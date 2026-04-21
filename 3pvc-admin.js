const AdminApp = {
    isLoggedIn: false,
    sites: {},
    complianceFields: [
        'api_version', 'app_agent_assistant', 'app_audio_package', 'app_audio_proxy',
        'app_camera_server_ipu', 'app_error_mapper', 'app_flashholdmc', 'app_fusion_server',
        'app_h100_driver', 'app_laser_scan_image_saver', 'app_log_extractor', 'app_mcu_logger',
        'app_metrics_monitor', 'app_msg_broker', 'app_nav_client', 'app_nav_process',
        'app_ntpdate', 'app_obstacle_detection_all_sensors', 'app_obstacle_detection_driver',
        'app_openresty', 'app_params_server', 'app_qrlocation_net', 'app_robot_ops_agent',
        'app_route_check', 'app_sick_safetyscanners', 'app_vector', 'app_victoria_metrics',
        'bot_id', 'bot_status', 'ip', 'master_version', 'vda_version'
    ],

    init() {
        this.bindEvents();
        this.loadSites();
    },

    bindEvents() {
        document.getElementById('loginBtn').addEventListener('click', () => {
            this.login();
        });

        document.getElementById('adminPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.login();
        });

        document.getElementById('addSiteBtn').addEventListener('click', () => {
            this.saveSite();
        });

        document.getElementById('logoutBtn').addEventListener('click', () => {
            this.logout();
        });

        document.getElementById('addComplianceDataBtn').addEventListener('click', () => {
            this.addComplianceData();
        });

        document.getElementById('exportSites').addEventListener('click', () => {
            this.exportSites();
        });

        document.getElementById('importSites').addEventListener('click', () => {
            document.getElementById('importSitesFile').click();
        });

        document.getElementById('importSitesFile').addEventListener('change', (e) => {
            this.importSites(e);
        });
    },

    login() {
        const username = document.getElementById('adminUsername').value;
        const password = document.getElementById('adminPassword').value;

        if (username === 'admin' && password === 'product_validation') {
            this.isLoggedIn = true;
            this.showAdminContent();
            UIUtils.showSuccess('Logged in successfully');
        } else {
            document.getElementById('loginError').classList.add('show');
            document.getElementById('adminPassword').value = '';
        }
    },

    logout() {
        this.isLoggedIn = false;
        document.getElementById('loginPanel').style.display = 'block';
        document.getElementById('adminContent').classList.remove('show');
        document.getElementById('logoutBtn').classList.add('hidden');
        document.getElementById('adminUsername').value = '';
        document.getElementById('adminPassword').value = '';
        document.getElementById('loginError').classList.remove('show');
    },

    showAdminContent() {
        document.getElementById('loginPanel').style.display = 'none';
        document.getElementById('adminContent').classList.add('show');
        document.getElementById('logoutBtn').classList.remove('hidden');
        this.renderComplianceSiteSelect();
        this.renderColumnSelector();
    },

    renderComplianceSiteSelect() {
        const select = document.getElementById('complianceSite');
        select.innerHTML = '<option value="">Select site...</option>';
        Object.keys(this.sites).forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
    },

    renderColumnSelector() {
        const container = document.getElementById('columnSelector');
        container.innerHTML = this.complianceFields.map(field => `
            <label class="column-checkbox selected" data-field="${field}">
                <input type="checkbox" checked data-field="${field}">
                <span>${field}</span>
            </label>
        `).join('');

        container.querySelectorAll('.column-checkbox').forEach(label => {
            label.addEventListener('click', (e) => {
                if (e.target.type !== 'checkbox') {
                    const checkbox = label.querySelector('input');
                    checkbox.checked = !checkbox.checked;
                }
                label.classList.toggle('selected', label.querySelector('input').checked);
            });
        });

        document.getElementById('selectAllColumns').addEventListener('change', (e) => {
            container.querySelectorAll('input').forEach(cb => {
                cb.checked = e.target.checked;
            });
            container.querySelectorAll('.column-checkbox').forEach(label => {
                label.classList.toggle('selected', e.target.checked);
            });
        });
    },

    loadSites() {
        const saved = localStorage.getItem('3pvcSites');
        this.sites = saved ? JSON.parse(saved) : {};
        
        GitHubConfig.fetchSites().then(githubSites => {
            if (githubSites && Object.keys(githubSites).length > 0) {
                this.sites = githubSites;
                localStorage.setItem('3pvcSites', JSON.stringify(githubSites));
            }
            this.renderSites();
            this.renderComplianceSiteSelect();
        });
        
        this.renderSites();
    },

    async saveSites() {
        localStorage.setItem('3pvcSites', JSON.stringify(this.sites));
        
        const success = await GitHubConfig.saveSites(this.sites);
        if (success) {
            UIUtils.showSuccess('Sites saved to cloud');
        }
    },

    renderSites() {
        const container = document.getElementById('siteList');
        const siteNames = Object.keys(this.sites);

        if (siteNames.length === 0) {
            container.innerHTML = '<p class="placeholder-text">No sites configured. Add a site below.</p>';
            return;
        }

        container.innerHTML = siteNames.map(name => {
            const site = this.sites[name];
            return `
                <div class="site-item" data-site="${name}">
                    <div class="site-item-info">
                        <div class="site-item-name">${name}</div>
                        <div class="site-item-ip">${site.ip}:${site.port} | DB: ${site.db} | M: ${site.measurement}</div>
                    </div>
                    <div class="site-item-actions">
                        <button class="btn btn-sm btn-delete-site" data-site="${name}">Delete</button>
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.btn-delete-site').forEach(btn => {
            btn.addEventListener('click', () => {
                this.deleteSite(btn.dataset.site);
            });
        });
    },

    saveSite() {
        const name = document.getElementById('siteName').value.trim();
        const ip = document.getElementById('siteIp').value.trim();
        const port = document.getElementById('sitePort').value.trim() || '8086';
        const db = document.getElementById('siteDb').value.trim() || 'GreyOrange';
        const measurement = document.getElementById('siteMeasurement').value.trim() || 'bot_firmware_details';

        if (!name || !ip) {
            UIUtils.showError('Site name and IP are required');
            return;
        }

        this.sites[name] = { ip, port, db, measurement };
        this.saveSites();
        this.renderSites();
        this.clearForm();

        UIUtils.showSuccess(`Site "${name}" saved`);
    },

    deleteSite(name) {
        if (confirm(`Delete site "${name}"?`)) {
            delete this.sites[name];
            this.saveSites();
            this.renderSites();
            UIUtils.showSuccess(`Site "${name}" deleted`);
        }
    },

    clearForm() {
        document.getElementById('siteName').value = '';
        document.getElementById('siteIp').value = '';
        document.getElementById('sitePort').value = '8086';
        document.getElementById('siteDb').value = 'GreyOrange';
        document.getElementById('siteMeasurement').value = 'bot_firmware_details';
    },

    async addComplianceData() {
        const siteName = document.getElementById('complianceSite').value;
        if (!siteName) {
            this.showComplianceResult('Please select a site', 'error');
            return;
        }

        const site = this.sites[siteName];
        const selectedFields = [];
        
        document.querySelectorAll('#columnSelector input:checked').forEach(cb => {
            selectedFields.push(cb.dataset.field);
        });

        if (selectedFields.length === 0) {
            this.showComplianceResult('Please select at least one column', 'error');
            return;
        }

        const fields = {};
        selectedFields.forEach(field => {
            const input = document.getElementById(`comp_${field}`);
            if (input && input.value.trim()) {
                fields[field] = input.value.trim();
            }
        });

        if (Object.keys(fields).length === 0) {
            this.showComplianceResult('Please fill at least one field value', 'error');
            return;
        }

        try {
            const serverConfig = { server: site.ip, port: parseInt(site.port) || 8086 };
            const database = site.db || 'GreyOrange';
            const measurement = 'compliance_details';
            
            const lineProtocol = this.buildLineProtocol(measurement, {}, fields);
            
            await this.writeToInflux(serverConfig, database, lineProtocol);
            
            this.showComplianceResult('Data added successfully!', 'success');
            this.clearComplianceForm();
            
        } catch (error) {
            this.showComplianceResult(`Error: ${error.message}`, 'error');
        }
    },

    buildLineProtocol(measurement, tags, fields) {
        let line = measurement;
        
        const fieldStr = Object.entries(fields)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
        
        if (!fieldStr) {
            throw new Error('At least one field is required');
        }
        
        line += ' ' + fieldStr;
        return line;
    },

    async writeToInflux(serverConfig, database, lineProtocol) {
        const url = `http://${serverConfig.server}:${serverConfig.port}/write?db=${encodeURIComponent(database)}`;
        
        const response = await fetch(url, {
            method: 'POST',
            body: lineProtocol
        });
        
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        }
        
        return true;
    },

    showComplianceResult(message, type) {
        const container = document.getElementById('complianceResult');
        container.className = `response-panel ${type}`;
        container.textContent = message;
        container.classList.remove('hidden');
        
        setTimeout(() => {
            container.classList.add('hidden');
        }, 5000);
    },

    clearComplianceForm() {
        this.complianceFields.forEach(field => {
            const input = document.getElementById(`comp_${field}`);
            if (input) input.value = '';
        });
    },

    exportSites() {
        const sites = localStorage.getItem('3pvcSites');
        if (!sites) {
            UIUtils.showError('No sites to export');
            return;
        }
        const blob = new Blob([sites], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '3pvc-sites.json';
        a.click();
        URL.revokeObjectURL(url);
        UIUtils.showSuccess('Sites exported successfully');
    },

    importSites(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const sites = JSON.parse(event.target.result);
                localStorage.setItem('3pvcSites', JSON.stringify(sites));
                this.sites = sites;
                this.renderSites();
                this.renderComplianceSiteSelect();
                UIUtils.showSuccess('Sites imported successfully');
            } catch (err) {
                UIUtils.showError('Invalid file format');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }
};

document.addEventListener('DOMContentLoaded', () => {
    AdminApp.init();
});