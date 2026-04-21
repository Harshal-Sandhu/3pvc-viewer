const App = {
    currentTab: 'query',

    init() {
        this.bindTabEvents();
        this.initModules();
        this.checkInitialSetup();
    },

    bindTabEvents() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabId = btn.dataset.tab;
                this.switchTab(tabId);
            });
        });
    },

    switchTab(tabId) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === `${tabId}-tab`);
        });

        this.currentTab = tabId;

        if (tabId === 'admin') {
            AdminTab.checkLoginStatus();
        }

        if (tabId === 'compliance') {
            ComplianceTab.refresh();
        }
    },

    initModules() {
        QueryTab.init();
        WriteTab.init();
        ComplianceTab.init();
        AdminTab.init();
    },

    checkInitialSetup() {
        const config = ConfigUtils.getInfluxConfig();
        const hasConfig = Object.keys(config.databases).length > 0;

        if (!hasConfig) {
            UIUtils.showInfo('Welcome! Please configure the connection in the Admin tab first.');
        }

        this.checkConnection();
    },

    async checkConnection() {
        const result = await InfluxUtils.testConnection();
        AdminTab.updateConnectionStatus(result.success);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
