import { createServerApp } from './app.mjs';

const port = Number(process.env.PORT || 8787);
const { app, close } = createServerApp();

const server = app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
