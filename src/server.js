// Central User Service — one login for Wockhardt field users (NSM / ZSM / RM / TM) across projects.
//   /api/auth/*            login (email OTP) → RS256 token for the calling app       (public, CORS per client)
//   /.well-known/jwks.json public key(s) for apps to verify tokens locally
//   /api/v1/*              server-to-server lookups for apps (X-Client-Id + X-Api-Key)
//   /api/admin/*, /admin   admin page: users, divisions, Infinity sync, client apps, login history
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const db = require('./db');
const { loadKeys } = require('./keys');
const { allowedOrigins } = require('./clients');
const { router: authRouter } = require('./routes/auth');

const app = express();
app.set('trust proxy', config.trustProxy); // behind Apache: real client IP for rate limits and login history
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '100kb' }));

// Browser apps may call the login API directly: allow each client's registered origins.
const loginCors = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / curl
    allowedOrigins()
      .then((set) => cb(null, set.has(origin) || config.corsOrigins.includes(origin)))
      .catch((err) => cb(err));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
});

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: err.message });
  }
});

app.get('/.well-known/jwks.json', loginCors, (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600').json(loadKeys().jwks);
});

app.use('/api/auth', loginCors, authRouter);
app.use('/api/v1', require('./routes/clientApi'));
app.use('/api/admin', require('./routes/admin'));

// Admin page (static, same origin as /api/admin).
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin'), { index: 'index.html' }));
app.get('/', (req, res) => res.redirect('/admin/'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Server error' : err.message });
});

loadKeys(); // generate the signing key on first start rather than on the first login
app.listen(config.port, (err) => {
  // Express 5 passes listen errors here (e.g. the port is already used by another instance).
  if (err) {
    console.error(`Could not start on port ${config.port}: ${err.code === 'EADDRINUSE' ? 'the port is already in use (is the service already running?)' : err.message}`);
    process.exit(1);
  }
  console.log(`Central User Service on http://localhost:${config.port}  (issuer ${config.issuer}, OTP delivery: ${config.otp.delivery})`);
});
