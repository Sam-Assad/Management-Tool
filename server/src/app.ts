import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorHandler } from './middleware/errorHandler.js';
import { groupsRouter } from './routes/groups.js';
import { serversRouter } from './routes/servers.js';
import { softwareRouter } from './routes/software.js';
import { groupSoftwareRouter } from './routes/groupSoftware.js';
import { jobsRouter } from './routes/jobs.js';
import { logsRouter } from './routes/logs.js';
import { heartbeatRouter } from './routes/heartbeat.js';
import { conditionsRouter } from './routes/conditions.js';
import { authRouter } from './routes/auth.js';
import { csrfGuard, loadUser, requireUser, permissionGate } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json());

  // Sign-in: every /api request is checked for the CSRF header and its session; only the sign-in endpoints
  // work without one. The web page itself (static files) loads without signing in, so it can show the form.
  app.use('/api', csrfGuard, loadUser);
  app.use('/api', authRouter);
  app.use('/api', requireUser, permissionGate);

  app.use('/api/groups', groupsRouter);
  app.use('/api', serversRouter);
  app.use('/api', softwareRouter);
  app.use('/api', groupSoftwareRouter);
  app.use('/api', jobsRouter);
  app.use('/api', logsRouter);
  app.use('/api', heartbeatRouter);
  app.use('/api', conditionsRouter);

  const webDist = path.resolve(__dirname, '../../web/dist');
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webDist, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use(errorHandler);
  return app;
}
