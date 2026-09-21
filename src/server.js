import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { router as heartbeatsRouter, availableBuckets, BUCKET_LABELS } from './routes/heartbeats.js';
import { router as maintenanceRouter } from './routes/maintenance.js';
import { startCollector } from './services/collector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await connectDb();

  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/buckets', (_req, res) =>
    res.json({
      intervalMs: config.intervalMs,
      timezone: config.timezone,
      weekStart: config.weekStart,
      buckets: availableBuckets().map(({ key, ms }) => ({ key, ms, label: BUCKET_LABELS[key] })),
    }),
  );
  app.use('/api/heartbeats', heartbeatsRouter);
  app.use('/api/maintenance', maintenanceRouter);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, _req, res, _next) => {
    console.error('[api]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(config.port, () => {
    console.log(`[api] dashboard on http://localhost:${config.port}`);
  });

  // In production with several API replicas, run the collector in ONE process only
  // (separate worker, or guard it with a Redis/Mongo lock). Set RUN_COLLECTOR=false on the others.
  const stopCollector = process.env.RUN_COLLECTOR === 'false' ? () => {} : startCollector();

  const shutdown = async () => {
    stopCollector();
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
