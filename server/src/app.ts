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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json());

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
