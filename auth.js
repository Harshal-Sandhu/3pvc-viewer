const Auth = {
    DEFAULT_USERNAME: 'admin',
    DEFAULT_PASSWORD: 'admin123',

    async hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    getCredentials() {
        const creds = localStorage.getItem('adminCredentials');
        return creds ? JSON.parse(creds) : null;
    },

    async initializeDefaultCredentials() {
        const existing = this.getCredentials();
        if (!existing) {
            const hashedPassword = await this.hashPassword(this.DEFAULT_PASSWORD);
            localStorage.setItem('adminCredentials', JSON.stringify({
                username: this.DEFAULT_USERNAME,
                passwordHash: hashedPassword,
                isDefault: true
            }));
        }
    },

    async login(username, password) {
        const creds = this.getCredentials();
        if (!creds) {
            await this.initializeDefaultCredentials();
            return this.login(username, password);
        }

        const hashedPassword = await this.hashPassword(password);
        
        if (username === creds.username && hashedPassword === creds.passwordHash) {
            sessionStorage.setItem('adminLoggedIn', 'true');
            return { success: true, isDefault: creds.isDefault };
        }

        return { success: false, error: 'Invalid username or password' };
    },

    logout() {
        sessionStorage.removeItem('adminLoggedIn');
    },

    isLoggedIn() {
        return sessionStorage.getItem('adminLoggedIn') === 'true';
    },

    async updateCredentials(currentPassword, newUsername, newPassword) {
        const creds = this.getCredentials();
        if (!creds) {
            return { success: false, error: 'No credentials found' };
        }

        const currentHash = await this.hashPassword(currentPassword);
        if (currentHash !== creds.passwordHash) {
            return { success: false, error: 'Current password is incorrect' };
        }

        const newHash = await this.hashPassword(newPassword);
        localStorage.setItem('adminCredentials', JSON.stringify({
            username: newUsername,
            passwordHash: newHash,
            isDefault: false
        }));

        return { success: true };
    },

    isUsingDefaultCredentials() {
        const creds = this.getCredentials();
        return creds ? creds.isDefault : true;
    }
};

Auth.initializeDefaultCredentials();
