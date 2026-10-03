import { Router, type Request } from 'express';
import { sqlite } from '../db/client.js';
import { sseHub } from '../sse/sseHub.js';
import {
  runStartAll,
  runStartOne,
  runRestartAll,
  runStopAll,
  runRestartOne,
  runStopOne,
  runScan,
  submitDecision,
  acceptStep,
  isAcceptable,
  RefusedError,
} from '../orchestrator/sequenceRunner.js';
import { JobDecisionSchema } from '@healthcheck/shared';
import { asyncHandler } from '../utils/asyncHandler.js';

export const jobsRouter = Router();

// Starts a job. A request the conditions (or a running job) rule out comes back as 409 with the reason,
// worded for the operator; the page shows it as is.
function startsJob(begin: (req: Request) => Promise<{ id: number }>) {
  return asyncHandler(async (req, res) => {
    try {
      const job = await begin(req);
      res.status(202).json({ jobId: job.id });
    } catch (err: any) {
      if (err instanceof RefusedError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });
}

const groupOf = (req: Request) => Number(req.params.groupId);
const pairOf = (req: Request): [number, number] => [Number(req.params.serverId), Number(req.params.softwareId)];

jobsRouter.post('/groups/:groupId/start-all', startsJob((req) => runStartAll(groupOf(req))));
jobsRouter.post('/groups/:groupId/restart-all', startsJob((req) => runRestartAll(groupOf(req))));
jobsRouter.post('/groups/:groupId/stop-all', startsJob((req) => runStopAll(groupOf(req))));
jobsRouter.post('/groups/:groupId/scan', startsJob((req) => runScan(groupOf(req))));
jobsRouter.post('/servers/:serverId/software/:softwareId/start', startsJob((req) => runStartOne(...pairOf(req))));
jobsRouter.post('/servers/:serverId/software/:softwareId/restart', startsJob((req) => runRestartOne(...pairOf(req))));
jobsRouter.post('/servers/:serverId/software/:softwareId/stop', startsJob((req) => runStopOne(...pairOf(req))));

jobsRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const groupId = req.query.groupId ? Number(req.query.groupId) : undefined;
    // ?limit=N returns just the latest N (the overview page's activity list)
    const limit = Math.min(Math.max(Number(req.query.limit) || 0, 0), 500);
    const tail = limit > 0 ? ` LIMIT ${limit}` : '';
    const rows = groupId
      ? sqlite.prepare(`SELECT * FROM job_runs WHERE group_id = ? ORDER BY id DESC${tail}`).all(groupId)
      : sqlite.prepare(`SELECT * FROM job_runs ORDER BY id DESC${tail}`).all();
    res.json(rows);
  })
);

jobsRouter.get(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const job = sqlite.prepare('SELECT * FROM job_runs WHERE id = ?').get(id) as any;
    if (!job) return res.status(404).json({ error: 'Not found' });
    const steps = sqlite
      .prepare(
        `SELECT js.*, sv.name AS server_name, sd.name AS software_name FROM job_steps js
         LEFT JOIN servers sv ON sv.id = js.server_id
         LEFT JOIN software_definitions sd ON sd.id = js.software_id
         WHERE js.job_run_id = ? ORDER BY js.id`
      )
      .all(id);
    res.json({
      ...job,
      awaiting: job.awaiting ? JSON.parse(job.awaiting) : null,
      // reports shown as a popup without pausing the run (Artemis's queues and memory after a start)
      notices: job.notices ? JSON.parse(job.notices) : [],
      // acceptable: the unit runs but its log has not shown the success line - the operator may vouch for it
      steps: (steps as any[]).map((step) => ({ ...step, acceptable: step.status === 'running' && isAcceptable(id, step.id) })),
    });
  })
);

// The operator's answer to a paused run's question (retry / skip / stop the run).
jobsRouter.post(
  '/jobs/:id/decision',
  asyncHandler(async (req, res) => {
    const { choice } = JobDecisionSchema.parse(req.body);
    if (!submitDecision(Number(req.params.id), choice)) {
      return res.status(409).json({ error: 'This job is not waiting for an answer.' });
    }
    res.status(204).end();
  })
);

// "Mark as started": carry on as if this component had become healthy.
jobsRouter.post(
  '/jobs/:id/steps/:stepId/accept',
  asyncHandler(async (req, res) => {
    if (!acceptStep(Number(req.params.id), Number(req.params.stepId))) {
      return res.status(409).json({ error: 'This component is not waiting to be marked as started.' });
    }
    res.status(204).end();
  })
);

jobsRouter.get('/jobs/:id/stream', (req, res) => {
  const id = Number(req.params.id);
  sseHub.subscribe(id, res);
});
