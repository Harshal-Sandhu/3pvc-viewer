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
                version: "1.0.0",
                date: "2024-01-01",
                title: "Initial Release",
                description: "Initial firmware release",
                notes: "Base firmware for Owen bot"
            }
        ],
        "walmartpot_staging": [
            {
                version: "1.0.0",
                date: "2024-01-01",
                title: "Initial Release",
                description: "Initial firmware release",
                notes: "Base firmware for Walmart staging bot"
            }
        ],
        "Apotek_inc_server": [
            {
                version: "1.0.0",
                date: "2024-01-01",
                title: "Initial Release",
                description: "Initial firmware release",
                notes: "Base firmware for Apotek bot"
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