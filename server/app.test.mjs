import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServerApp } from './app.mjs';

async function withServer(run, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motiontwin-leaderboard-'));
  const { app, close } = createServerApp({
    dbPath: path.join(tmpDir, 'leaderboard.sqlite'),
    serveStatic: false,
    ipHashSecret: 'test-secret',
    rateLimit: { max: 1000 },
    ...options,
  });
  const server = app.listen(0);

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

async function postScore(baseUrl, gameId, body) {
  return requestJson(baseUrl, `/api/games/${gameId}/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('empty leaderboard returns no entries', async () => {
  await withServer(async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/games/linea/leaderboard');

    assert.equal(response.status, 200);
    assert.deepEqual(body, { entries: [] });
  });
});

test('health check reports database availability', async () => {
  await withServer(async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/health');

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, database: 'ok' });
  });
});

test('health check reports database failures', async () => {
  await withServer(
    async (baseUrl) => {
      const originalConsoleError = console.error;
      console.error = () => {};
      let result;
      try {
        result = await requestJson(baseUrl, '/api/health');
      } finally {
        console.error = originalConsoleError;
      }
      const { response, body } = result;

      assert.equal(response.status, 503);
      assert.deepEqual(body, { ok: false, database: 'error' });
    },
    {
      store: {
        checkHealth() {
          throw new Error('database unavailable');
        },
        close() {},
      },
    },
  );
});

test('valid score submission appears on that game leaderboard', async () => {
  await withServer(async (baseUrl) => {
    const submitted = await postScore(baseUrl, 'interwheel', {
      pseudonym: ' Zoë ',
      score: 1234,
      secondary: { key: 'height', label: 'Height', value: 42, unit: 'm' },
    });

    assert.equal(submitted.response.status, 201);
    assert.equal(submitted.body.entry.pseudonym, 'Zoë');
    assert.equal(submitted.body.entry.score, 1234);
    assert.deepEqual(submitted.body.entry.secondary, { key: 'height', label: 'Height', value: 42, unit: 'm' });

    const leaderboard = await requestJson(baseUrl, '/api/games/interwheel/leaderboard');
    assert.equal(leaderboard.response.status, 200);
    assert.equal(leaderboard.body.entries.length, 1);
    assert.equal(leaderboard.body.entries[0].pseudonym, 'Zoë');
  });
});

test('invalid submissions are rejected', async () => {
  await withServer(async (baseUrl) => {
    const unknown = await postScore(baseUrl, 'missing', { pseudonym: 'Ada', score: 10 });
    assert.equal(unknown.response.status, 404);

    const badScore = await postScore(baseUrl, 'linea', { pseudonym: 'Ada', score: 10.5 });
    assert.equal(badScore.response.status, 400);

    const blankName = await postScore(baseUrl, 'linea', { pseudonym: '   ', score: 10 });
    assert.equal(blankName.response.status, 400);

    const controlName = await postScore(baseUrl, 'linea', { pseudonym: 'Ada\u0000Lovelace', score: 10 });
    assert.equal(controlName.response.status, 400);

    const longName = await postScore(baseUrl, 'linea', { pseudonym: 'a'.repeat(25), score: 10 });
    assert.equal(longName.response.status, 400);
  });
});

test('leaderboard keeps one best entry per normalized pseudonym', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await postScore(baseUrl, 'linea', { pseudonym: ' Ada ', score: 100 })).response.status, 201);
    assert.equal((await postScore(baseUrl, 'linea', { pseudonym: 'ada', score: 80 })).response.status, 201);
    assert.equal((await postScore(baseUrl, 'linea', { pseudonym: 'Grace', score: 90 })).response.status, 201);

    const leaderboard = await requestJson(baseUrl, '/api/games/linea/leaderboard');
    assert.equal(leaderboard.response.status, 200);
    assert.deepEqual(
      leaderboard.body.entries.map((entry) => [entry.pseudonym, entry.score]),
      [
        ['Ada', 100],
        ['Grace', 90],
      ],
    );
  });
});

test('scores are isolated by game id', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await postScore(baseUrl, 'linea', { pseudonym: 'Ada', score: 100 })).response.status, 201);
    assert.equal((await postScore(baseUrl, 'manda', { pseudonym: 'Ada', score: 300 })).response.status, 201);

    const linea = await requestJson(baseUrl, '/api/games/linea/leaderboard');
    const manda = await requestJson(baseUrl, '/api/games/manda/leaderboard');

    assert.deepEqual(linea.body.entries.map((entry) => entry.score), [100]);
    assert.deepEqual(manda.body.entries.map((entry) => entry.score), [300]);
  });
});

test('same-origin validation honors trusted forwarded host and protocol', async () => {
  await withServer(
    async (baseUrl) => {
      const accepted = await requestJson(baseUrl, '/api/games/linea/scores', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://games.example',
          'X-Forwarded-Host': 'games.example',
          'X-Forwarded-Proto': 'https',
        },
        body: JSON.stringify({ pseudonym: 'Proxy Player', score: 77 }),
      });
      assert.equal(accepted.response.status, 201);

      const rejected = await requestJson(baseUrl, '/api/games/linea/scores', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://other.example',
          'X-Forwarded-Host': 'games.example',
          'X-Forwarded-Proto': 'https',
        },
        body: JSON.stringify({ pseudonym: 'Proxy Player', score: 88 }),
      });
      assert.equal(rejected.response.status, 403);
    },
    { trustProxy: 1 },
  );
});
