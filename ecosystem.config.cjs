// PM2 process definition (production). From this folder:
//   pm2 start ecosystem.config.cjs && pm2 save
// Settings come from .env in this folder.
module.exports = {
  apps: [
    {
      name: 'central-user-service',
      cwd: __dirname,
      script: 'src/server.js',
      env: { NODE_ENV: 'production', TZ: 'Asia/Kolkata' },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
  ],
};
