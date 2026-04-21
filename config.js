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

    getSites() {
        return this.sites;
    },

    getSite(name) {
        return this.sites[name];
    },

    getSiteNames() {
        return Object.keys(this.sites);
    }
};