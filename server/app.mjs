import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, '.data', 'leaderboard.sqlite');
const DEFAULT_DIST_DIR = path.join(PROJECT_ROOT, 'dist');

const KNOWN_GAME_IDS = new Set([
  'interwheel',
  'pioupiou',
  'manda',
  'killbulle',
  'linea',
  'alphabounce',
  'kslash',
  'iron-chouquette',
]);

const MAX_SCORE = Number.MAX_SAFE_INTEGER;
const MAX_PSEUDONYM_LENGTH = 24;
const MAX_BODY_SIZE = '8kb';
const SUBMISSION_WINDOW_MS = 60_000;
const SUBMISSION_LIMIT = 12;

function isKnownGameId(gameId) {
  return typeof gameId === 'string' && KNOWN_GAME_IDS.has(gameId);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeWhitespace(value) {
  return value.trim().replace(/\s+/gu, ' ');
}

function countGraphemes(value) {
  if (typeof Intl.Segmenter !== 'undefined') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value)).length;
  }
  return Array.from(value).length;
}

function truncateGraphemes(value, maxLength) {
  if (countGraphemes(value) <= maxLength) return value;
  if (typeof Intl.Segmenter !== 'undefined') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), (segment) => segment.segment).slice(0, maxLength).join('');
  }
  return Array.from(value).slice(0, maxLength).join('');
}

function hasControlOrFormatCharacters(value) {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}

export function normalizePseudonym(value) {
  if (typeof value !== 'string') {
    throw new ValidationError('Pseudonym is required.');
  }

  const display = normalizeWhitespace(value.normalize('NFKC'));
  if (!display) {
    throw new ValidationError('Pseudonym is required.');
  }
  if (hasControlOrFormatCharacters(display)) {
    throw new ValidationError('Pseudonym contains unsupported characters.');
  }
  if (countGraphemes(display) > MAX_PSEUDONYM_LENGTH) {
    throw new ValidationError(`Pseudonym must be ${MAX_PSEUDONYM_LENGTH} characters or fewer.`);
  }

  return {
    display,
    normalized: display.toLocaleLowerCase(),
  };
}

function normalizeScore(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SCORE) {
    throw new ValidationError('Score must be a non-negative integer.');
  }
  return value;
}

function normalizeShortText(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} is invalid.`);
  }
  const normalized = normalizeWhitespace(value.normalize('NFKC'));
  if (!normalized || hasControlOrFormatCharacters(normalized) || countGraphemes(normalized) > maxLength) {
    throw new ValidationError(`${field} is invalid.`);
  }
  return normalized;
}

function normalizeMetadataText(value, maxLength) {
  const raw = typeof value === 'string' ? value : 'unknown';
  const normalized = normalizeWhitespace(raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ''));
  return truncateGraphemes(normalized || 'unknown', maxLength);
}

function normalizeSecondary(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new ValidationError('Secondary metric is invalid.');
  }

  const key = normalizeShortText(value.key, 'Secondary metric key', 40);
  if (!/^[a-z0-9_-]+$/i.test(key)) {
    throw new ValidationError('Secondary metric key is invalid.');
  }

  const label = normalizeShortText(value.label, 'Secondary metric label', 40);
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
    throw new ValidationError('Secondary metric value is invalid.');
  }

  let unit = null;
  if (value.unit !== undefined) {
    unit = normalizeShortText(value.unit, 'Secondary metric unit', 12);
  }

  return {
    key,
    label,
    value: value.value,
    unit,
  };
}

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function hashIp(ip, secret) {
  return crypto.createHmac('sha256', secret).update(ip).digest('hex');
}

function serializeRow(row) {
  const entry = {
    id: row.id,
    gameId: row.game_id,
    pseudonym: row.pseudonym,
    score: row.score,
    submittedAt: row.created_at,
  };

  if (row.secondary_key && row.secondary_label && typeof row.secondary_value === 'number') {
    entry.secondary = {
      key: row.secondary_key,
      label: row.secondary_label,
      value: row.secondary_value,
    };
    if (row.secondary_unit) {
      entry.secondary.unit = row.secondary_unit;
    }
  }

  return entry;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

export class LeaderboardStore {
  constructor(dbPath = DEFAULT_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.prepareStatements();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS score_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        pseudonym TEXT NOT NULL,
        pseudonym_norm TEXT NOT NULL,
        score INTEGER NOT NULL,
        secondary_key TEXT,
        secondary_label TEXT,
        secondary_value REAL,
        secondary_unit TEXT,
        ip_hash TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_score_submissions_game_score
        ON score_submissions (game_id, score DESC, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_score_submissions_game_pseudonym
        ON score_submissions (game_id, pseudonym_norm, score DESC, created_at ASC);
    `);
  }

  prepareStatements() {
    this.insertSubmission = this.db.prepare(`
      INSERT INTO score_submissions (
        game_id,
        pseudonym,
        pseudonym_norm,
        score,
        secondary_key,
        secondary_label,
        secondary_value,
        secondary_unit,
        ip_hash,
        user_agent,
        created_at
      )
      VALUES (
        @gameId,
        @pseudonym,
        @pseudonymNorm,
        @score,
        @secondaryKey,
        @secondaryLabel,
        @secondaryValue,
        @secondaryUnit,
        @ipHash,
        @userAgent,
        @createdAt
      )
    `);

    this.selectById = this.db.prepare(`
      SELECT
        id,
        game_id,
        pseudonym,
        score,
        secondary_key,
        secondary_label,
        secondary_value,
        secondary_unit,
        created_at
      FROM score_submissions
      WHERE id = ?
    `);

    this.selectLeaderboard = this.db.prepare(`
      WITH ranked AS (
        SELECT
          id,
          game_id,
          pseudonym,
          score,
          secondary_key,
          secondary_label,
          secondary_value,
          secondary_unit,
          created_at,
          ROW_NUMBER() OVER (
            PARTITION BY game_id, pseudonym_norm
            ORDER BY score DESC, created_at ASC, id ASC
          ) AS pseudonym_rank
        FROM score_submissions
        WHERE game_id = ?
      )
      SELECT
        id,
        game_id,
        pseudonym,
        score,
        secondary_key,
        secondary_label,
        secondary_value,
        secondary_unit,
        created_at
      FROM ranked
      WHERE pseudonym_rank = 1
      ORDER BY score DESC, created_at ASC, id ASC
      LIMIT ?
    `);
  }

  checkHealth() {
    this.db.prepare('SELECT 1 AS ok').get();
  }

  addSubmission(submission) {
    const info = this.insertSubmission.run(submission);
    const row = this.selectById.get(info.lastInsertRowid);
    return serializeRow(row);
  }

  getLeaderboard(gameId, limit = 10) {
    if (!isKnownGameId(gameId)) {
      throw new NotFoundError('Unknown game.');
    }
    const boundedLimit = Math.max(1, Math.min(50, Number.isSafeInteger(limit) ? limit : 10));
    return this.selectLeaderboard.all(gameId, boundedLimit).map(serializeRow);
  }

  close() {
    this.db.close();
  }
}

function parseLimit(value) {
  if (value === undefined) return 10;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new ValidationError('Limit must be an integer from 1 to 50.');
  }
  return parsed;
}

function createSubmissionRateLimiter({
  windowMs = SUBMISSION_WINDOW_MS,
  max = SUBMISSION_LIMIT,
  pruneIntervalMs = Math.min(windowMs, 60_000),
  now = () => Date.now(),
} = {}) {
  const buckets = new Map();
  let nextPruneAt = now() + pruneIntervalMs;

  function pruneExpired(currentTime) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) {
        buckets.delete(key);
      }
    }
  }

  return function rateLimit(req, res, next) {
    const currentTime = now();
    if (currentTime >= nextPruneAt) {
      pruneExpired(currentTime);
      nextPruneAt = currentTime + pruneIntervalMs;
    }

    const key = getClientIp(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= currentTime) {
      buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
      next();
      return;
    }

    if (bucket.count >= max) {
      res.status(429).json({ error: 'Too many score submissions. Try again later.' });
      return;
    }

    bucket.count += 1;
    next();
  };
}

function firstHeaderValue(value) {
  if (!value) return undefined;
  return value.split(',')[0]?.trim() || undefined;
}

function getExpectedOrigins(req) {
  const origins = new Set();
  const host = firstHeaderValue(req.get('host'));
  if (host) {
    origins.add(`${req.protocol}://${host}`);
  }

  if (req.app.get('trust proxy')) {
    const forwardedHost = firstHeaderValue(req.get('x-forwarded-host'));
    if (forwardedHost) {
      const forwardedProto = firstHeaderValue(req.get('x-forwarded-proto')) || req.protocol;
      origins.add(`${forwardedProto}://${forwardedHost}`);
    }
  }

  return origins;
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }

  try {
    const originUrl = new URL(origin);
    if (getExpectedOrigins(req).has(originUrl.origin)) {
      next();
      return;
    }
  } catch {
    // Fall through to rejection.
  }

  res.status(403).json({ error: 'Cross-origin score submissions are not accepted.' });
}

function notFound(res, message = 'Not found.') {
  res.status(404).json({ error: message });
}

function sendError(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Request body must be valid JSON.' });
    return;
  }

  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) {
    console.error('[server] request failed', err);
  }
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : err.message });
}

export function createServerApp(options = {}) {
  const dbPath = options.dbPath ?? process.env.LEADERBOARD_DB_PATH ?? DEFAULT_DB_PATH;
  const distDir = options.distDir ?? DEFAULT_DIST_DIR;
  const serveStatic = options.serveStatic ?? process.env.SERVE_STATIC !== 'false';
  const ipHashSecret = options.ipHashSecret ?? process.env.IP_HASH_SECRET ?? 'development-secret';
  const store = options.store ?? new LeaderboardStore(dbPath);
  const trustProxy = options.trustProxy ?? (process.env.TRUST_PROXY === '1' ? 1 : false);
  const app = express();

  if (process.env.NODE_ENV === 'production' && !process.env.IP_HASH_SECRET && !options.ipHashSecret) {
    console.warn('[server] IP_HASH_SECRET is not set; using the development fallback secret.');
  }

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/health', (req, res) => {
    try {
      store.checkHealth();
      res.json({ ok: true, database: 'ok' });
    } catch (err) {
      console.error('[server] health check failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ ok: false, database: 'error' });
    }
  });

  app.get('/api/games/:gameId/leaderboard', (req, res, next) => {
    try {
      const { gameId } = req.params;
      if (!isKnownGameId(gameId)) {
        notFound(res, 'Unknown game.');
        return;
      }
      const limit = parseLimit(req.query.limit);
      res.json({ entries: store.getLeaderboard(gameId, limit) });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/games/:gameId/scores',
    requireSameOrigin,
    createSubmissionRateLimiter(options.rateLimit),
    express.json({ limit: MAX_BODY_SIZE, type: 'application/json' }),
    (req, res, next) => {
      try {
        const { gameId } = req.params;
        if (!isKnownGameId(gameId)) {
          notFound(res, 'Unknown game.');
          return;
        }
        if (!isRecord(req.body)) {
          throw new ValidationError('Request body must be a JSON object.');
        }

        const pseudonym = normalizePseudonym(req.body.pseudonym);
        const score = normalizeScore(req.body.score);
        const secondary = normalizeSecondary(req.body.secondary);
        const userAgent = normalizeMetadataText(req.get('user-agent'), 300);
        const entry = store.addSubmission({
          gameId,
          pseudonym: pseudonym.display,
          pseudonymNorm: pseudonym.normalized,
          score,
          secondaryKey: secondary?.key ?? null,
          secondaryLabel: secondary?.label ?? null,
          secondaryValue: secondary?.value ?? null,
          secondaryUnit: secondary?.unit ?? null,
          ipHash: hashIp(getClientIp(req), ipHashSecret),
          userAgent,
          createdAt: new Date().toISOString(),
        });

        res.status(201).json({
          entry,
          leaderboard: store.getLeaderboard(gameId, 10),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.use('/api', (req, res) => {
    notFound(res);
  });

  if (serveStatic) {
    const indexPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      app.use(express.static(distDir, { index: false }));
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }
        res.sendFile(indexPath);
      });
    } else {
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }
        res.status(503).type('text/plain').send('Frontend build not found. Run `npm run build` first.');
      });
    }
  }

  app.use(sendError);

  return {
    app,
    store,
    close() {
      store.close();
    },
  };
}
