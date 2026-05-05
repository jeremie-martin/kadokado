import fs from 'node:fs';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

const e2eDir = path.resolve('.tmp/e2e');
const dbPath = path.join(e2eDir, 'leaderboard.sqlite');
const port = 4197;
const baseURL = `http://127.0.0.1:${port}`;

fs.rmSync(e2eDir, { recursive: true, force: true });
fs.mkdirSync(e2eDir, { recursive: true });

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: {
    baseURL,
  },
  webServer: {
    command: 'npm run build && npm start',
    env: {
      ...process.env,
      IP_HASH_SECRET: 'e2e-secret',
      LEADERBOARD_DB_PATH: dbPath,
      NODE_ENV: 'production',
      PORT: String(port),
    },
    url: `${baseURL}/api/health`,
  },
});
