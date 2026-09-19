import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
const { app, service } = createRuntime(config);

service.recover(); // задачи и события лежат в SQLite и переживают перезапуск

const shutdown = async () => {
  await app.close();
  await service.drain();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen({ port: config.port, host: '0.0.0.0' }).then(
  () => console.log(`AMS managed-actions listening on :${config.port} (planner=${config.planner})`),
  (e: unknown) => {
    console.error('Failed to start:', e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
