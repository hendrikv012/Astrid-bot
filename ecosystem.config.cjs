// pm2 process file: keeps Astrid running in the background, restarts it after
// a crash, and (after `npx pm2 startup` + `npm run pm2:save`) after a reboot.
// Needs pm2 installed globally: npm install -g pm2
// Usage: npm run start:pm2 — see README "Running in the background".
module.exports = {
    apps: [
        {
            name: 'astrid',
            script: 'dist/index.js',
            cwd: __dirname,
            // One process only: two would fight over the same WhatsApp login.
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            // Back off when it keeps crashing (e.g. Ollama down) instead of looping.
            exp_backoff_restart_delay: 2000,
            max_restarts: 50,
            min_uptime: '30s',
            // Give the bot time to finish a reply and close the DB on shutdown.
            kill_timeout: 15000,
            max_memory_restart: '1G',
            time: true,
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
