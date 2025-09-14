import http from 'http';
import dotenv from 'dotenv';
import app from './app';
import { initDB } from './lib/db';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  await initDB();
  const server = http.createServer(app);
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`🚀 Evently Analytics listening on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\nReceived ${signal}. Shutting down...`);
    server.close(() => {
      // eslint-disable-next-line no-console
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  ['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig as NodeJS.Signals, () => shutdown(sig)));
}

start().catch(err => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server', err);
  process.exit(1);
});
