import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { directResponsesModel, fabricResponsesModel } from './openaiModel.js';
import { Orchestrator } from './orchestrator.js';
import { ReportStore } from './reportStore.js';

const config = loadConfig();
const models = { direct: directResponsesModel(config), fabric: fabricResponsesModel(config) };
const reports = new ReportStore(config.reportDir, config.maxReports);
const orchestrator = new Orchestrator(config, models, reports);
const server = createServer(createApp(config, orchestrator));

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Fabric Gateway Showcase listening on http://127.0.0.1:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
