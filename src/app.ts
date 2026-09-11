import { resolve } from 'node:path';
import express, { type ErrorRequestHandler, type Response } from 'express';
import type { AppConfig } from './config.js';
import { OrchestrationError, Orchestrator } from './orchestrator.js';

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new OrchestrationError(400, `${name} must be a boolean`);
  return value;
}

export function createApp(config: AppConfig, orchestrator: Orchestrator) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb', strict: true }));

  app.get('/api/preflight', async (_req, res, next) => {
    try { res.json(await orchestrator.preflight()); } catch (error) { next(error); }
  });

  app.post('/api/paired-runs', async (req, res, next) => {
    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      const executionMode = req.body?.executionMode;
      const report = await orchestrator.start({
        prompt,
        failFirstFraud: boolean(req.body?.failFirstFraud, 'failFirstFraud'),
        executionMode,
        ...(typeof req.body?.reportId === 'string' ? { reportId: req.body.reportId } : {})
      });
      res.status(202).json({ pairedRunId: report.id, state: report.state, eventsUrl: `/api/paired-runs/${report.id}/events` });
    } catch (error) { next(error); }
  });

  app.get('/api/paired-runs/:id/events', (req, res, next) => {
    const report = orchestrator.get(req.params.id);
    if (!report) { next(new OrchestrationError(404, 'Paired run not found')); return; }
    const lastEventId = Number.parseInt(req.get('last-event-id') || String(req.query.lastEventId || '0'), 10) || 0;
    res.status(200).set({
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no'
    });
    res.flushHeaders();
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const close = () => { if (heartbeat) clearInterval(heartbeat); unsubscribe?.(); res.end(); };
    const send = (event: typeof report.events[number]) => {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'run.terminal' || event.type === 'conversation.terminal') setImmediate(close);
    };
    report.events.filter(event => event.id > lastEventId).forEach(send);
    if (report.events.some(event => event.id > lastEventId && (event.type === 'run.terminal' || event.type === 'conversation.terminal'))) return;
    unsubscribe = orchestrator.subscribe(report.id, send);
    heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => { if (heartbeat) clearInterval(heartbeat); unsubscribe?.(); });
  });

  app.get('/api/paired-runs/:id', async (req, res, next) => {
    try {
      const report = orchestrator.get(req.params.id) || await orchestrator.reports.get(req.params.id);
      if (!report) throw new OrchestrationError(404, 'Paired run not found');
      res.json(report);
    } catch (error) { next(error); }
  });

  app.post('/api/paired-runs/:id/cancel', (req, res, next) => {
    try { res.status(202).json(orchestrator.cancel(req.params.id)); } catch (error) { next(error); }
  });

  app.post('/api/paired-runs/:id/messages', async (req, res, next) => {
    try {
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      const target = req.body?.target;
      const previousEventId = orchestrator.get(req.params.id)?.events.at(-1)?.id || 0;
      const report = await orchestrator.followUp(req.params.id, { message, target });
      res.status(202).json({
        pairedRunId: report.id,
        state: report.state,
        eventsUrl: `/api/paired-runs/${report.id}/events?lastEventId=${previousEventId}`,
        comparisonIntegrity: report.comparisonIntegrity
      });
    } catch (error) { next(error); }
  });

  app.get('/api/reports', async (_req, res, next) => {
    try { res.json({ reports: await orchestrator.reports.list() }); } catch (error) { next(error); }
  });

  app.get('/api/reports/:id/download', async (req, res, next) => {
    try {
      const report = await orchestrator.reports.get(req.params.id);
      if (!report) throw new OrchestrationError(404, 'Report not found');
      res.set('content-disposition', `attachment; filename="fabric-comparison-${report.id}.json"`).json(report);
    } catch (error) { next(error); }
  });

  const sendUiFile = (res: Response, name: string) => {
    res.set({ 'cache-control': 'no-store, max-age=0', pragma: 'no-cache', expires: '0' });
    res.sendFile(resolve(process.cwd(), name));
  };
  app.get('/', (_req, res) => sendUiFile(res, 'index.html'));
  app.get('/app.js', (_req, res) => sendUiFile(res, 'app.js'));
  app.get('/styles.css', (_req, res) => sendUiFile(res, 'styles.css'));

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof OrchestrationError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    res.status(status).json({ error: { code: error instanceof Error ? error.name : 'Error', message } });
  };
  app.use(errorHandler);
  return app;
}
