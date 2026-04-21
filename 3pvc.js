const ViewerApp = {
    chart: null,
    currentResult: null,
    parsedData: null,
    complianceData: null,
    sites: {},
    activeFilters: {},
    distinctValues: {},
    currentFilterColumn: null,
    comparisonResults: { total: 0, matched: 0, mismatched: [], botsData: {} },

    async init() {
        this.bindEvents();
        this.loadSites();
        this.initChart();
        setTimeout(() => {
            if (Object.keys(this.sites).length > 0) {
                this.autoLoadData();
            }
        }, 500);
    },

    bindEvents() {
        document.getElementById('siteSelect').addEventListener('change', (e) => {
            this.onSiteChange(e.target.value);
        });

        document.getElementById('loadData').addEventListener('click', () => {
            this.loadAllData();
        });

        document.getElementById('timeFilter').addEventListener('change', () => {
            if (this.getCurrentSiteConfig()) {
                this.activeFilters = {};
                this.loadAllData();
            }
        });

        document.getElementById('exportCsv').addEventListener('click', () => {
            this.exportCsv();
        });

        document.getElementById('exportComplianceCsv').addEventListener('click', () => {
            this.exportComplianceCsv();
        });

        document.getElementById('clearAllFilters').addEventListener('click', () => {
            this.clearAllFilters();
        });

        document.getElementById('filterDropdownClose').addEventListener('click', () => {
            this.hideFilterDropdown();
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('th') || !e.target.closest('th').classList.contains('filter-header')) {
                this.hideFilterDropdown();
            }
        });

        document.querySelectorAll('.btn-group .btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchView(btn.dataset.view);
            });
        });

        document.getElementById('mismatchedStat').addEventListener('click', () => {
            this.showMismatchList('version_mismatch');
        });

        document.getElementById('noComplianceStat').addEventListener('click', () => {
            this.showMismatchList('no_compliance');
        });

        document.getElementById('matchedStat').addEventListener('click', () => {
            this.showMismatchList('matched');
        });

        document.getElementById('closeMismatchPanel').addEventListener('click', () => {
            document.getElementById('mismatchPanel').style.display = 'none';
        });
    },

    loadSites() {
        const saved = localStorage.getItem('3pvcSites');
        this.sites = saved ? JSON.parse(saved) : {};
        this.renderSiteSelect();
    },

    renderSiteSelect() {
        const select = document.getElementById('siteSelect');
        select.innerHTML = '<option value="">Select site...</option>';
        Object.keys(this.sites).forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
    },

    onSiteChange(siteName) {
        if (siteName && this.sites[siteName]) {
            this.activeFilters = {};
            this.loadAllData();
        }
    },

    getCurrentSiteConfig() {
        const siteName = document.getElementById('siteSelect').value;
        if (!siteName || !this.sites[siteName]) {
            return null;
        }
        return this.sites[siteName];
    },

    async autoLoadData() {
        const siteNames = Object.keys(this.sites);
        if (siteNames.length === 1) {
            document.getElementById('siteSelect').value = siteNames[0];
            await this.loadAllData();
        }
    },

    async loadAllData() {
        await this.loadData();
        await this.loadComplianceData();
    },

    buildFilterClause() {
        const filters = Object.entries(this.activeFilters);
        if (filters.length === 0) return '';

        let clause = '';
        filters.forEach(([column, value]) => {
            if (value && value !== '') {
                clause += ` AND "${column}" = '${this.escapeValue(value)}'`;
            }
        });
        return clause;
    },

    escapeValue(value) {
        return String(value).replace(/'/g, "\\'");
    },

    async loadData() {
        const site = this.getCurrentSiteConfig();
        if (!site) {
            UIUtils.showError('Please select a site');
            return;
        }

        const timeRange = document.getElementById('timeFilter').value;
        const measurement = site.measurement || 'bot_firmware_details';
        const database = site.db || 'GreyOrange';
        const filterClause = this.buildFilterClause();

        UIUtils.showInfo('Loading data...');

        try {
            const serverConfig = { server: site.ip, port: parseInt(site.port) || 8086 };
            const query = `SELECT * FROM "${measurement}" WHERE time > now() - ${timeRange}${filterClause} ORDER BY time DESC LIMIT 10000`;
            const result = await InfluxUtils.queryServer(serverConfig, database, query);
            
            this.currentResult = result;
            this.parsedData = InfluxUtils.parseQueryResult(result);
            
            if (this.parsedData.error) {
                UIUtils.showError(this.parsedData.error);
                return;
            }

            this.computeDistinctValues();
            this.displayResults();
            this.updateActiveFiltersUI();
            
            const filterInfo = Object.keys(this.activeFilters).length > 0 
                ? ` (${Object.keys(this.activeFilters).length} filter(s))` 
                : '';
            UIUtils.showSuccess(`Loaded ${this.parsedData.rows.length} records from ${document.getElementById('siteSelect').value}${filterInfo}`);

        } catch (error) {
            UIUtils.showError(error.message);
        }
    },

    async loadComplianceData() {
        const site = this.getCurrentSiteConfig();
        if (!site) return;

        const timeRange = document.getElementById('timeFilter').value;
        const database = site.db || 'GreyOrange';

        try {
            const serverConfig = { server: site.ip, port: parseInt(site.port) || 8086 };
            const query = `SELECT * FROM "compliance_details" WHERE time > now() - ${timeRange} ORDER BY time DESC LIMIT 10000`;
            const result = await InfluxUtils.queryServer(serverConfig, database, query);
            
            this.complianceData = InfluxUtils.parseQueryResult(result);
            this.displayComplianceResults();
            document.getElementById('complianceWidget').style.display = 'none';
            document.getElementById('mismatchPanel').style.display = 'none';

        } catch (error) {
            console.error('Error loading compliance data:', error);
            document.getElementById('complianceTable').innerHTML = `
                <div class="no-data-message">
                    <div class="icon">⚠️</div>
                    <p>Error loading compliance data: ${error.message}</p>
                </div>
            `;
        }
    },

    displayComplianceResults() {
        const parsed = this.complianceData;
        const container = document.getElementById('complianceTable');
        
        if (!parsed.columns.length || parsed.rows.length === 0) {
            container.innerHTML = `
                <div class="no-data-message">
                    <div class="icon">📋</div>
                    <p>No compliance data found for the selected time range</p>
                </div>
            `;
            return;
        }

        this.renderTable(parsed.columns, parsed.rows, container);
    },

    runComplianceComparison() {
        const botData = this.parsedData;
        const complianceData = this.complianceData;
        
        document.getElementById('complianceWidget').style.display = 'none';
        document.getElementById('mismatchPanel').style.display = 'none';
        
        if (!complianceData || !complianceData.columns.length || !complianceData.rows.length) {
            return;
        }

        const compBotIdIdx = complianceData.columns.indexOf('bot_id');
        const compIpIdx = complianceData.columns.indexOf('ip');
        
        if (compBotIdIdx === -1) {
            console.warn('bot_id column not found in compliance_details');
            return;
        }

        const botIdIdx = botData ? botData.columns.indexOf('bot_id') : -1;
        const botIpIdx = botData ? botData.columns.indexOf('ip') : -1;

        const uniqueComplianceBotIds = [...new Set(complianceData.rows.map(r => r[compBotIdIdx]))].filter(b => b);
        
        const botByBotId = {};
        if (botData && botData.rows.length && botIdIdx !== -1) {
            botData.rows.forEach(row => {
                const botId = row[botIdIdx];
                if (botId) {
                    if (!botByBotId[botId] || new Date(row[0]) > new Date(botByBotId[botId].time)) {
                        botByBotId[botId] = { row, time: row[0] };
                    }
                }
            });
        }

        const comparisonFields = [
            'api_version', 'app_agent_assistant', 'app_audio_package', 'app_audio_proxy',
            'app_camera_server_ipu', 'app_error_mapper', 'app_flashholdmc', 'app_fusion_server',
            'app_h100_driver', 'app_laser_scan_image_saver', 'app_log_extractor', 'app_mcu_logger',
            'app_metrics_monitor', 'app_msg_broker', 'app_nav_client', 'app_nav_process',
            'app_ntpdate', 'app_obstacle_detection_all_sensors', 'app_obstacle_detection_driver',
            'app_openresty', 'app_params_server', 'app_qrlocation_net', 'app_robot_ops_agent',
            'app_route_check', 'app_sick_safetyscanners', 'app_vector', 'app_victoria_metrics',
            'vda_version'
        ];

        const matched = [];
        const mismatched = [];
        const noBotData = [];
        const botsData = {};

        uniqueComplianceBotIds.forEach(botId => {
            const compRows = complianceData.rows.filter(r => r[compBotIdIdx] === botId);
            if (compRows.length === 0) return;
            
            const latestCompRow = compRows[0];
            const compIp = compIpIdx !== -1 ? latestCompRow[compIpIdx] : '';
            
            const botRowData = botByBotId[botId];
            
            if (!botRowData) {
                noBotData.push({
                    bot_id: botId,
                    ip: compIp,
                    compRow: latestCompRow
                });
                botsData[botId] = {
                    latestBotRow: null,
                    compRow: latestCompRow,
                    status: 'no_bot_data'
                };
                return;
            }

            const mismatchedFields = [];
            const fieldValues = {};

            comparisonFields.forEach(field => {
                const botFieldIdx = botData.columns.indexOf(field);
                const compFieldIdx = complianceData.columns.indexOf(field);

                if (botFieldIdx !== -1 && compFieldIdx !== -1) {
                    const botValue = botRowData.row[botFieldIdx];
                    const compValue = latestCompRow[compFieldIdx];

                    const botStr = botValue ? String(botValue).trim() : '';
                    const compStr = compValue ? String(compValue).trim() : '';

                    if (botStr && compStr && botStr !== compStr) {
                        mismatchedFields.push(field);
                        fieldValues[field] = { bot: botStr, compliance: compStr };
                    }
                }
            });

            if (mismatchedFields.length > 0) {
                mismatched.push({
                    bot_id: botId,
                    ip: compIp,
                    mismatched_fields: mismatchedFields,
                    field_values: fieldValues
                });
                botsData[botId] = {
                    latestBotRow: botRowData.row,
                    compRow: latestCompRow,
                    status: 'mismatched',
                    mismatched_fields: mismatchedFields,
                    field_values: fieldValues
                };
            } else {
                matched.push({
                    bot_id: botId,
                    ip: compIp
                });
                botsData[botId] = {
                    latestBotRow: botRowData.row,
                    compRow: latestCompRow,
                    status: 'matched'
                };
            }
        });

        this.comparisonResults = {
            total: uniqueComplianceBotIds.length,
            matched: matched,
            mismatched: mismatched,
            noComplianceData: noBotData,
            botsData: botsData
        };

        this.updateComparisonWidget();
    },

    updateComparisonWidget() {
        const widget = document.getElementById('complianceWidget');
        const results = this.comparisonResults;

        if (results.total === 0) {
            widget.style.display = 'none';
            return;
        }

        document.getElementById('totalBotsCount').textContent = results.total;
        document.getElementById('matchedCount').textContent = results.matched.length;
        document.getElementById('versionMismatchCount').textContent = results.mismatched.length;
        document.getElementById('mismatchedCount').textContent = results.noComplianceData.length;

        widget.style.display = 'block';
    },

    showMismatchList(type) {
        const panel = document.getElementById('mismatchPanel');
        const list = document.getElementById('mismatchList');
        const results = this.comparisonResults;
        const botData = this.parsedData;

        let title = '';
        let items = [];

        switch(type) {
            case 'matched':
                title = 'Compliant Bots - All versions match';
                items = results.matched;
                break;
            case 'version_mismatch':
                title = 'Version Mismatch - Bots with different versions';
                items = results.mismatched;
                break;
            case 'no_compliance':
                title = 'Bots NOT in Bot Firmware - Have compliance but no bot record';
                items = results.noComplianceData;
                break;
        }

        const header = panel.querySelector('h3');
        if (header) header.textContent = title;

        if (items.length === 0) {
            list.innerHTML = '<p class="placeholder-text">No bots found</p>';
        } else if (type === 'version_mismatch') {
            list.innerHTML = items.map(item => `
                <div class="mismatch-item">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 8px; background: #1a1a3e; border-radius: 4px;">
                        <div>
                            <strong style="color: #4facfe; font-size: 1rem;">Bot ID: ${item.bot_id}</strong>
                        </div>
                        <div style="color: #888;">
                            IP: ${item.ip || 'N/A'}
                        </div>
                    </div>
                    <div class="mismatch-details">
                        <div style="color: #ff5252; margin-bottom: 8px; font-weight: 600;">Mismatched Fields:</div>
                        ${item.mismatched_fields.map(field => {
                            const values = item.field_values[field];
                            return `<div style="padding: 4px 0; border-bottom: 1px solid #2a2a4e;">
                                <strong>${field}:</strong> 
                                <span style="color: #4facfe;">Bot: ${values.bot}</span>
                                <span style="color: #888; margin: 0 8px;">≠</span>
                                <span style="color: #ff9800;">Compliance: ${values.compliance}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
            `).join('');
        } else if (type === 'no_compliance') {
            list.innerHTML = items.map(item => `
                <div class="mismatch-item">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: #1a1a3e; border-radius: 4px;">
                        <div>
                            <strong style="color: #4facfe; font-size: 1rem;">Bot ID: ${item.bot_id}</strong>
                        </div>
                        <div style="color: #888;">
                            IP: ${item.ip || 'N/A'}
                        </div>
                    </div>
                    <div style="color: #ff9800; margin-top: 8px;">⚠️ No bot_firmware_details record found</div>
                </div>
            `).join('');
        } else {
            list.innerHTML = items.map(item => `
                <div class="mismatch-item">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: #1a1a3e; border-radius: 4px;">
                        <div>
                            <strong style="color: #4facfe; font-size: 1rem;">Bot ID: ${item.bot_id}</strong>
                        </div>
                        <div style="color: #888;">
                            IP: ${item.ip || 'N/A'}
                        </div>
                    </div>
                    <div style="color: #00c853; margin-top: 8px;">✓ All versions match with compliance</div>
                </div>
            `).join('');
        }

        panel.style.display = 'block';
    },

    computeDistinctValues() {
        this.distinctValues = {};
        if (!this.parsedData.columns.length || !this.parsedData.rows.length) return;

        this.parsedData.columns.forEach((col, idx) => {
            if (col === 'time') return;
            
            const counts = {};
            this.parsedData.rows.forEach(row => {
                const val = row[idx];
                const key = val === null || val === undefined ? '(empty)' : String(val);
                counts[key] = (counts[key] || 0) + 1;
            });

            this.distinctValues[col] = Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ name, count }));
        });
    },

    displayResults() {
        const parsed = this.parsedData;
        const container = document.getElementById('resultsTable');
        
        if (!parsed.columns.length || parsed.rows.length === 0) {
            container.innerHTML = `
                <div class="no-data-message">
                    <div class="icon">📭</div>
                    <p>No data found for the selected time range</p>
                </div>
            `;
            this.updateChart({ columns: [], rows: [] });
            return;
        }

        this.renderTableWithFilters(parsed.columns, parsed.rows);
        this.updateChart(parsed);
    },

    renderTable(columns, rows, container) {
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

    renderTableWithFilters(columns, rows) {
        const container = document.getElementById('resultsTable');
        
        let html = '<table><thead><tr>';
        columns.forEach((col, idx) => {
            const isFilterActive = this.activeFilters[col] !== undefined && this.activeFilters[col] !== '';
            html += `<th class="filter-header ${isFilterActive ? 'filter-active' : ''}" data-column="${col}" data-index="${idx}">${col}</th>`;
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

        container.querySelectorAll('th.filter-header').forEach(th => {
            th.addEventListener('click', (e) => {
                e.stopPropagation();
                const column = th.dataset.column;
                this.showFilterDropdown(column, th);
            });
        });
    },

    showFilterDropdown(column, thElement) {
        if (!this.distinctValues[column] || this.distinctValues[column].length === 0) {
            UIUtils.showInfo('No values to filter');
            return;
        }

        this.currentFilterColumn = column;
        
        document.getElementById('filterColumnName').textContent = column;
        
        const optionsHtml = this.distinctValues[column].slice(0, 100).map(item => {
            const isSelected = this.activeFilters[column] === item.name;
            return `
                <div class="filter-option ${isSelected ? 'selected' : ''}" data-value="${item.name}">
                    <span class="filter-option-name">${item.name}</span>
                    <span class="filter-option-count">${item.count}</span>
                </div>
            `;
        }).join('');
        
        document.getElementById('filterOptions').innerHTML = optionsHtml + `
            <div class="filter-clear" id="clearFilter">Clear filter</div>
        `;

        document.querySelectorAll('.filter-option').forEach(opt => {
            opt.addEventListener('click', () => {
                const value = opt.dataset.value;
                if (value === '(empty)') {
                    delete this.activeFilters[column];
                } else {
                    this.activeFilters[column] = value;
                }
                this.hideFilterDropdown();
                this.loadData();
            });
        });

        document.getElementById('clearFilter').addEventListener('click', () => {
            delete this.activeFilters[column];
            this.hideFilterDropdown();
            this.loadData();
        });

        const dropdown = document.getElementById('filterDropdown');
        const rect = thElement.getBoundingClientRect();
        dropdown.style.left = rect.left + 'px';
        dropdown.style.top = (rect.bottom + 4) + 'px';
        dropdown.classList.add('show');
    },

    hideFilterDropdown() {
        document.getElementById('filterDropdown').classList.remove('show');
        this.currentFilterColumn = null;
    },

    updateActiveFiltersUI() {
        const container = document.getElementById('activeFilters');
        const tagsContainer = document.getElementById('activeFilterTags');
        
        const filterCount = Object.keys(this.activeFilters).filter(k => this.activeFilters[k]).length;
        
        if (filterCount === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        
        tagsContainer.innerHTML = Object.entries(this.activeFilters)
            .filter(([k, v]) => v)
            .map(([column, value]) => `
                <span style="background: var(--primary); color: white; padding: 4px 10px; border-radius: 4px; font-size: 0.8rem; display: flex; align-items: center; gap: 6px;">
                    ${column}: ${value}
                    <span style="cursor: pointer;" onclick="ViewerApp.clearFilter('${column}')">×</span>
                </span>
            `).join('');
    },

    clearFilter(column) {
        delete this.activeFilters[column];
        this.loadData();
    },

    clearAllFilters() {
        this.activeFilters = {};
        this.loadData();
    },

    switchView(view) {
        document.querySelectorAll('.btn-group .btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        document.getElementById('tableView').classList.toggle('hidden', view !== 'table');
        document.getElementById('chartView').classList.toggle('hidden', view !== 'chart');
    },

    initChart() {
        const ctx = document.getElementById('dataChart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: []
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { color: '#e8e8e8' }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#a0a0a0' },
                        grid: { color: '#2d3a4f' }
                    },
                    y: {
                        ticks: { color: '#a0a0a0' },
                        grid: { color: '#2d3a4f' }
                    }
                }
            }
        });
    },

    updateChart(parsed) {
        if (!parsed.columns.includes('time') || parsed.rows.length === 0) {
            this.chart.data.labels = [];
            this.chart.data.datasets = [];
            this.chart.update();
            return;
        }

        const timeIndex = parsed.columns.indexOf('time');
        const labels = parsed.rows.map(row => {
            const time = row[timeIndex];
            return new Date(time).toLocaleString();
        });

        const colors = [
            '#4facfe', '#00f2fe', '#00c853', '#ffc107', '#ff5252',
            '#9c27b0', '#ff9800', '#03a9f4', '#e91e63', '#8bc34a'
        ];

        const datasets = parsed.columns
            .filter((col, i) => col !== 'time' && i !== timeIndex)
            .map((col, i) => {
                const colIndex = parsed.columns.indexOf(col);
                return {
                    label: col,
                    data: parsed.rows.map(row => {
                        const val = row[colIndex];
                        return typeof val === 'number' ? val : parseFloat(val) || null;
                    }),
                    borderColor: colors[i % colors.length],
                    backgroundColor: colors[i % colors.length] + '20',
                    fill: true,
                    tension: 0.3
                };
            });

        this.chart.data.labels = labels;
        this.chart.data.datasets = datasets;
        this.chart.update();
    },

    exportCsv() {
        if (!this.parsedData || this.parsedData.rows.length === 0) {
            UIUtils.showError('No data to export');
            return;
        }

        const siteName = document.getElementById('siteSelect').value || 'export';
        const site = this.getCurrentSiteConfig();
        const measurement = site ? (site.measurement || 'bot_firmware_details') : 'bot_firmware_details';
        const timeFilter = document.getElementById('timeFilter').value;
        UIUtils.exportToCsv(
            this.parsedData.columns, 
            this.parsedData.rows, 
            `${siteName}_${measurement}_${timeFilter}_${Date.now()}.csv`
        );
        UIUtils.showSuccess('CSV exported successfully');
    },

    exportComplianceCsv() {
        if (!this.complianceData || this.complianceData.rows.length === 0) {
            UIUtils.showError('No compliance data to export');
            return;
        }

        const siteName = document.getElementById('siteSelect').value || 'export';
        const timeFilter = document.getElementById('timeFilter').value;
        UIUtils.exportToCsv(
            this.complianceData.columns, 
            this.complianceData.rows, 
            `${siteName}_compliance_details_${timeFilter}_${Date.now()}.csv`
        );
        UIUtils.showSuccess('Compliance CSV exported successfully');
    }
};

document.addEventListener('DOMContentLoaded', () => {
    ViewerApp.init();
});