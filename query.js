const QueryTab = {
    chart: null,
    currentResult: null,

    init() {
        this.bindEvents();
        this.loadDatabases();
        this.initChart();
    },

    bindEvents() {
        document.getElementById('queryDatabase').addEventListener('change', (e) => {
            this.onDatabaseChange(e.target.value);
        });

        document.getElementById('queryMeasurement').addEventListener('change', (e) => {
            this.onMeasurementChange(e.target.value);
        });

        document.querySelectorAll('#query-tab .mode-btn').forEach(btn => {
            btn.addEventListener('click', () => this.switchMode(btn.dataset.mode));
        });

        document.getElementById('timeRange').addEventListener('change', (e) => {
            const customRange = document.getElementById('customTimeRange');
            customRange.classList.toggle('hidden', e.target.value !== 'custom');
        });

        document.getElementById('executeQuery').addEventListener('click', () => {
            this.executeQuery();
        });

        document.querySelectorAll('.snippet-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const textarea = document.getElementById('rawQuery');
                const measurement = document.getElementById('queryMeasurement').value;
                let snippet = btn.dataset.snippet;
                if (snippet.includes('FROM') && measurement) {
                    snippet = snippet.replace('FROM', `FROM "${measurement}"`);
                }
                textarea.value = snippet;
            });
        });

        document.getElementById('toggleJson').addEventListener('click', () => {
            this.toggleJsonView();
        });

        document.getElementById('exportCsv').addEventListener('click', () => {
            this.exportCsv();
        });
    },

    loadDatabases() {
        const databases = ConfigUtils.getEnabledDatabases();
        const select = document.getElementById('queryDatabase');
        UIUtils.populateSelect(select, databases.map(db => db.name), 'Select database...');
    },

    onDatabaseChange(dbName) {
        const measurementSelect = document.getElementById('queryMeasurement');
        
        if (!dbName) {
            measurementSelect.disabled = true;
            measurementSelect.innerHTML = '<option value="">Select measurement...</option>';
            return;
        }

        const measurements = ConfigUtils.getMeasurementsForDatabase(dbName);
        UIUtils.populateSelect(measurementSelect, measurements, 'Select measurement...');
        measurementSelect.disabled = false;
    },

    async onMeasurementChange(measurement) {
        const fieldSelector = document.getElementById('fieldSelector');
        
        if (!measurement) {
            fieldSelector.innerHTML = '<span class="placeholder-text">Select a measurement to load fields...</span>';
            return;
        }

        const database = document.getElementById('queryDatabase').value;
        
        try {
            const fields = await InfluxUtils.getFieldKeys(database, measurement);
            this.renderFieldSelector(fields);
        } catch (error) {
            fieldSelector.innerHTML = '<span class="placeholder-text">Could not load fields. You can still use advanced mode.</span>';
        }
    },

    renderFieldSelector(fields) {
        const container = document.getElementById('fieldSelector');
        
        if (fields.length === 0) {
            container.innerHTML = '<span class="placeholder-text">No fields found</span>';
            return;
        }

        container.innerHTML = fields.map(field => `
            <label class="field-checkbox">
                <input type="checkbox" value="${field.name}" checked>
                <span>${field.name} (${field.type})</span>
            </label>
        `).join('');
    },

    switchMode(mode) {
        document.querySelectorAll('#query-tab .mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        document.getElementById('simpleMode').classList.toggle('active', mode === 'simple');
        document.getElementById('simpleMode').classList.toggle('hidden', mode !== 'simple');
        document.getElementById('advancedMode').classList.toggle('active', mode === 'advanced');
        document.getElementById('advancedMode').classList.toggle('hidden', mode !== 'advanced');
    },

    buildSimpleQuery() {
        const database = document.getElementById('queryDatabase').value;
        const measurement = document.getElementById('queryMeasurement').value;

        if (!database || !measurement) {
            throw new Error('Please select a database and measurement');
        }

        const selectedFields = Array.from(
            document.querySelectorAll('#fieldSelector input:checked')
        ).map(cb => cb.value);

        const fields = selectedFields.length > 0 ? selectedFields.join(', ') : '*';
        const timeRange = document.getElementById('timeRange').value;
        const startTime = document.getElementById('startTime').value;
        const endTime = document.getElementById('endTime').value;

        const whereClause = InfluxUtils.getTimeRangeQuery(timeRange, startTime, endTime);

        return `SELECT ${fields} FROM "${measurement}" WHERE ${whereClause}`;
    },

    async executeQuery() {
        const database = document.getElementById('queryDatabase').value;
        
        if (!database) {
            UIUtils.showError('Please select a database');
            return;
        }

        let query;
        const isSimpleMode = document.getElementById('simpleMode').classList.contains('active');

        try {
            if (isSimpleMode) {
                query = this.buildSimpleQuery();
            } else {
                query = document.getElementById('rawQuery').value.trim();
                if (!query) {
                    UIUtils.showError('Please enter a query');
                    return;
                }
            }

            UIUtils.showInfo('Executing query...');
            const result = await InfluxUtils.query(database, query);
            this.currentResult = result;
            this.displayResults(result);
            UIUtils.showSuccess('Query executed successfully');

        } catch (error) {
            UIUtils.showError(error.message);
            document.getElementById('resultsTable').innerHTML = 
                `<p class="placeholder-text" style="color: var(--danger);">Error: ${error.message}</p>`;
        }
    },

    displayResults(result) {
        const parsed = InfluxUtils.parseQueryResult(result);
        
        if (parsed.error) {
            document.getElementById('resultsTable').innerHTML = 
                `<p class="placeholder-text" style="color: var(--danger);">Error: ${parsed.error}</p>`;
            return;
        }

        UIUtils.renderTable(parsed.columns, parsed.rows, 'resultsTable');
        
        document.getElementById('resultsJson').querySelector('pre').textContent = 
            JSON.stringify(result, null, 2);

        this.updateChart(parsed);
    },

    toggleJsonView() {
        const tableEl = document.getElementById('resultsTable');
        const jsonEl = document.getElementById('resultsJson');
        const btn = document.getElementById('toggleJson');

        if (jsonEl.classList.contains('hidden')) {
            tableEl.classList.add('hidden');
            jsonEl.classList.remove('hidden');
            btn.textContent = 'Show Table';
        } else {
            jsonEl.classList.add('hidden');
            tableEl.classList.remove('hidden');
            btn.textContent = 'Show JSON';
        }
    },

    exportCsv() {
        if (!this.currentResult) {
            UIUtils.showError('No data to export');
            return;
        }

        const parsed = InfluxUtils.parseQueryResult(this.currentResult);
        if (parsed.columns.length === 0) {
            UIUtils.showError('No data to export');
            return;
        }

        const measurement = document.getElementById('queryMeasurement').value || 'export';
        UIUtils.exportToCsv(parsed.columns, parsed.rows, `${measurement}_${Date.now()}.csv`);
        UIUtils.showSuccess('CSV exported successfully');
    },

    initChart() {
        const ctx = document.getElementById('queryChart').getContext('2d');
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
            return new Date(time).toLocaleTimeString();
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
    }
};
