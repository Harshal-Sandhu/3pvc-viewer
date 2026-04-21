const GitHubConfig = {
    repo: 'Harshal-Sandhu/3pvc-viewer',
    branch: 'main',
    token: '',
    filePath: 'sites.json',

    async getToken() {
        const saved = localStorage.getItem('githubToken');
        if (saved) return saved;
        
        const token = prompt('Enter your GitHub token (needs repo access):');
        if (token) {
            localStorage.setItem('githubToken', token);
        }
        return token;
    },

    async fetchSites() {
        try {
            const token = await this.getToken();
            if (!token) return null;
            
            const response = await fetch(`https://api.github.com/repos/${this.repo}/contents/${this.filePath}?ref=${this.branch}`, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (!response.ok) throw new Error('Failed to fetch');
            
            const data = await response.json();
            const content = atob(data.content);
            return JSON.parse(content);
        } catch (error) {
            console.error('Error fetching sites:', error);
            return null;
        }
    },

    async saveSites(sites) {
        try {
            const token = await this.getToken();
            if (!token) return false;
            
            const getResponse = await fetch(`https://api.github.com/repos/${this.repo}/contents/${this.filePath}?ref=${this.branch}`, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (!getResponse.ok) throw new Error('Failed to get file');

            const fileData = await getResponse.json();
            const content = JSON.stringify(sites, null, 2);
            const encoded = btoa(content);

            const updateResponse = await fetch(`https://api.github.com/repos/${this.repo}/contents/${this.filePath}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: 'Update sites configuration',
                    content: encoded,
                    sha: fileData.sha,
                    branch: this.branch
                })
            });

            if (!updateResponse.ok) throw new Error('Failed to update');
            return true;
        } catch (error) {
            console.error('Error saving sites:', error);
            return false;
        }
    }
};
