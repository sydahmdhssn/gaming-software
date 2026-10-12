import express from 'express';
import { AppError } from './util.js';

export function createApi(venue) {
  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));

  const handle = (fn) => (req, res, next) => {
    try {
      const result = fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };

  const auth = (req, res, next) => {
    const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const admin = venue.authenticate(token);
    if (!admin) return next(new AppError(401, 'Please sign in'));
    req.admin = admin;
    req.token = token;
    next();
  };

  // ---- public ----
  api.get('/status', handle(() => ({ needsSetup: venue.needsSetup(), venueName: venue.getSettings().venueName })));

  api.post('/setup', handle((req) => {
    if (!venue.needsSetup()) throw new AppError(409, 'Setup is already complete');
    venue.createAdmin(req.body ?? {});
    return venue.login(req.body);
  }));

  api.post('/login', handle((req) => venue.login(req.body ?? {})));

  // ---- staff only ----
  api.use(auth);

  api.post('/logout', handle((req) => venue.logout(req.token)));
  api.get('/me', handle((req) => req.admin));
  api.post('/admins', handle((req) => venue.createAdmin(req.body ?? {})));

  api.get('/snapshot', handle(() => venue.snapshot()));
  api.get('/settings', handle(() => venue.getSettings()));
  api.put('/settings', handle((req) => venue.updateSettings(req.body ?? {})));

  api.get('/zones', handle(() => venue.listZones()));
  api.post('/zones', handle((req) => venue.createZone(req.body ?? {})));
  api.put('/zones/:id', handle((req) => venue.updateZone(req.params.id, req.body ?? {})));
  api.delete('/zones/:id', handle((req) => venue.deleteZone(req.params.id)));

  api.get('/stations', handle(() => venue.listStations()));
  api.post('/stations', handle((req) => venue.createStation(req.body ?? {})));
  api.put('/stations/:id', handle((req) => venue.updateStation(req.params.id, req.body ?? {})));
  api.delete('/stations/:id', handle((req) => venue.deleteStation(req.params.id)));
  api.post('/stations/:id/token', handle((req) => venue.regenerateToken(req.params.id)));

  api.post('/stations/:id/session', handle((req) => venue.startSession(req.params.id, req.body ?? {}, req.admin.id)));
  api.get('/stations/:id/quote', handle((req) => venue.quote(req.params.id)));
  api.post('/stations/:id/add-time', handle((req) => venue.addTime(req.params.id, req.body ?? {}, req.admin.id)));
  api.post('/stations/:id/pause', handle((req) => venue.pause(req.params.id)));
  api.post('/stations/:id/resume', handle((req) => venue.resume(req.params.id)));
  api.post('/stations/:id/end', handle((req) =>
    venue.endSession(req.params.id, { reason: 'staff', method: req.body?.method ?? 'cash' }, req.admin.id)));
  api.post('/stations/:id/command', handle((req) => venue.command(req.params.id, req.body ?? {})));

  api.get('/customers', handle(() => venue.listCustomers()));
  api.post('/customers', handle((req) => venue.createCustomer(req.body ?? {})));
  api.put('/customers/:id', handle((req) => venue.updateCustomer(req.params.id, req.body ?? {})));
  api.post('/customers/:id/topup', handle((req) => venue.topUp(req.params.id, req.body ?? {}, req.admin.id)));

  api.get('/reports/summary', handle((req) => venue.report(req.query)));
  api.get('/transactions', handle((req) => venue.transactions(req.query)));

  api.use((req, res, next) => next(new AppError(404, 'Not found')));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return api;
}
