const SitesConfig = {
    sites: {
        "owen_n_minor": {
            ip: "172.28.102.27",
            port: "8086",
            db: "GreyOrange",
            measurement: "bot_firmware_version_details"
        },
        "walmartpot_staging": {
            ip: "172.28.48.195",
            port: "8086",
            db: "GreyOrange",
            measurement: "bot_firmware_version_details"
        },
        "Apotek_inc_server": {
            ip: "192.168.234.212",
            port: "8086",
            db: "GreyOrange",
            measurement: "bot_firmware_version_details"
        }
    },

    releaseNotes: {
        "owen_n_minor": [
            {
                version: "2.1.0",
                date: "2024-04-15",
                title: "Performance Improvements",
                description: "Optimized navigation and obstacle detection",
                notes: "- Improved path planning algorithm\n- Enhanced obstacle detection accuracy\n- Reduced false positives by 30%"
            },
            {
                version: "2.0.0",
                date: "2024-03-01",
                title: "New Features",
                description: "Added new firmware management features",
                notes: "- Auto-update capability\n- Remote diagnostics\n- Enhanced logging"
            },
            {
                version: "1.0.0",
                date: "2024-01-01",
                title: "Initial Release",
                description: "First production release",
                notes: "Base firmware for Owen bot operations"
            }
        ],
        "walmartpot_staging": [
            {
                version: "1.5.0",
                date: "2024-04-10",
                title: "Stability Updates",
                description: "Bug fixes and stability improvements",
                notes: "- Fixed connectivity issues\n- Improved battery management\n- Enhanced error handling"
            },
            {
                version: "1.0.0",
                date: "2024-02-01",
                title: "Initial Deployment",
                description: "First deployment to staging environment",
                notes: "Base firmware for Walmart staging bot testing"
            }
        ],
        "Apotek_inc_server": [
            {
                version: "3.0.0",
                date: "2024-04-20",
                title: "Major Update",
                description: "Complete firmware overhaul",
                notes: "- New architecture\n- Better performance\n- Enhanced security features\n- Improved reliability"
            },
            {
                version: "2.5.0",
                date: "2024-03-15",
                title: "Feature Update",
                description: "Added advanced features",
                notes: "- Machine learning integration\n- Predictive maintenance\n- Real-time monitoring"
            },
            {
                version: "1.0.0",
                date: "2024-01-15",
                title: "Initial Setup",
                description: "First deployment",
                notes: "Base firmware for Apotek bot operations"
            }
        ]
    },

    getSites() {
        return this.sites;
    },

    getSite(name) {
        return this.sites[name];
    },

    getSiteNames() {
        return Object.keys(this.sites);
    },

    getReleaseNotes(siteName) {
        return this.releaseNotes[siteName] || [];
    },

    addReleaseNote(siteName, note) {
        if (!this.releaseNotes[siteName]) {
            this.releaseNotes[siteName] = [];
        }
        this.releaseNotes[siteName].unshift(note);
    },

    setReleaseNotes(siteName, notes) {
        this.releaseNotes[siteName] = notes;
    }
};
