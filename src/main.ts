import './style.css';
import type { GameHost, GameInstance, GameMetric, GameModule, GameResult } from './games/types';
import { GAMES, findGame } from './games/registry';

const rootEl = document.querySelector<HTMLDivElement>('#app');
if (!rootEl) {
  throw new Error('Missing #app mount point');
}
const root = rootEl;
const BESTS_STORAGE_KEY = 'motiontwin-ports:v1:bests';

let active: GameInstance | null = null;
let renderId = 0;

type StoredBest = {
  score: number;
  secondary?: GameMetric;
  updatedAt: string;
};

type StoredBests = Record<string, StoredBest>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMetric(value: unknown): GameMetric | undefined {
  if (!isRecord(value)) return undefined;
  const key = value.key;
  const label = value.label;
  const metricValue = value.value;
  const unit = value.unit;
  if (typeof key !== 'string' || typeof label !== 'string' || typeof metricValue !== 'number' || !Number.isFinite(metricValue)) {
    return undefined;
  }
  if (unit !== undefined && typeof unit !== 'string') {
    return undefined;
  }
  return unit === undefined ? { key, label, value: metricValue } : { key, label, value: metricValue, unit };
}

function readBests(): StoredBests {
  try {
    const raw = window.localStorage.getItem(BESTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const bests: StoredBests = {};
    for (const [gameId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const score = value.score;
      const updatedAt = value.updatedAt;
      if (typeof score !== 'number' || !Number.isFinite(score) || typeof updatedAt !== 'string') continue;
      const secondary = normalizeMetric(value.secondary);
      bests[gameId] = secondary === undefined ? { score, updatedAt } : { score, secondary, updatedAt };
    }
    return bests;
  } catch {
    return {};
  }
}

function writeBests(bests: StoredBests): void {
  try {
    window.localStorage.setItem(BESTS_STORAGE_KEY, JSON.stringify(bests));
  } catch {
    // Private browsing / quota failures should not block play.
  }
}

function saveBest(gameId: string, result: GameResult): StoredBest | null {
  const bests = readBests();
  const previous = bests[gameId];
  if (previous && previous.score >= result.score) {
    return previous;
  }

  const next: StoredBest = {
    score: result.score,
    updatedAt: new Date().toISOString(),
  };
  if (result.secondary) {
    next.secondary = result.secondary;
  }
  bests[gameId] = next;
  writeBests(bests);
  return next;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
}

function formatMetric(metric: GameMetric): string {
  const value = formatNumber(metric.value);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function destroyActive(): void {
  if (active) {
    try {
      active.destroy();
    } catch (err) {
      console.error('[launcher] destroy() threw', err);
    }
    active = null;
  }
}

function clear(): void {
  renderId += 1;
  destroyActive();
  root.replaceChildren();
}

function renderLanding(): void {
  clear();
  const shell = document.createElement('div');
  shell.className = 'shell';

  const title = document.createElement('h1');
  title.textContent = 'MotionTwin Ports';
  const lead = document.createElement('p');
  lead.className = 'lead';
  lead.textContent = 'TypeScript / PixiJS ports of MotionTwin Flash games.';
  shell.append(title, lead);

  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  for (const entry of GAMES) {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.type = 'button';
    const heading = document.createElement('h2');
    heading.textContent = entry.meta.title;
    const desc = document.createElement('p');
    desc.textContent = entry.meta.description;
    tile.append(heading, desc);
    tile.addEventListener('click', () => {
      window.location.hash = entry.meta.id;
    });
    tiles.appendChild(tile);
  }
  shell.appendChild(tiles);
  root.appendChild(shell);
}

async function renderGame(id: string): Promise<void> {
  const entry = findGame(id);
  if (!entry) {
    renderLanding();
    return;
  }
  const gameId = entry.meta.id;

  clear();
  const myId = renderId;
  let currentScore = 0;
  let currentSecondary: GameMetric | undefined;
  let ended = false;
  let best: StoredBest | null = readBests()[gameId] ?? null;
  let runId = 0;
  let mod: GameModule | null = null;
  let busy = false;
  let busyStatus = 'Loading';

  const player = document.createElement('div');
  player.className = 'player';

  const back = document.createElement('button');
  back.className = 'player-back';
  back.type = 'button';
  back.textContent = 'Back';
  back.addEventListener('click', () => {
    window.location.hash = '';
  });

  const layout = document.createElement('div');
  layout.className = 'player-layout';

  const stage = document.createElement('div');
  stage.className = 'player-stage';
  stage.style.width = `${entry.meta.width}px`;
  stage.style.height = `${entry.meta.height}px`;

  const panel = document.createElement('aside');
  panel.className = 'player-panel';

  const title = document.createElement('h1');
  title.className = 'player-title';
  title.textContent = entry.meta.title;

  const status = document.createElement('p');
  status.className = 'player-status';
  status.setAttribute('aria-live', 'polite');

  const currentValue = document.createElement('strong');
  const bestValue = document.createElement('strong');
  const secondaryRow = document.createElement('div');
  secondaryRow.className = 'player-stat player-stat-secondary';
  const secondaryLabel = document.createElement('span');
  const secondaryValue = document.createElement('strong');
  secondaryRow.append(secondaryLabel, secondaryValue);

  const currentRow = document.createElement('div');
  currentRow.className = 'player-stat';
  const currentLabel = document.createElement('span');
  currentLabel.textContent = 'Score';
  currentRow.append(currentLabel, currentValue);

  const bestRow = document.createElement('div');
  bestRow.className = 'player-stat';
  const bestLabel = document.createElement('span');
  bestLabel.textContent = 'Best';
  bestRow.append(bestLabel, bestValue);

  const restart = document.createElement('button');
  restart.className = 'player-action';
  restart.type = 'button';

  panel.append(title, status, currentRow, bestRow, secondaryRow, restart);
  layout.append(stage, panel);
  player.append(back, layout);
  root.appendChild(player);

  function renderPanel(): void {
    currentValue.textContent = formatNumber(currentScore);
    bestValue.textContent = best ? formatNumber(best.score) : '-';
    status.textContent = busy ? busyStatus : ended ? 'Run ended' : 'Playing';
    restart.textContent = ended ? 'Play again' : 'Restart';
    restart.disabled = busy;

    if (currentSecondary) {
      secondaryLabel.textContent = currentSecondary.label;
      secondaryValue.textContent = formatMetric(currentSecondary);
      secondaryRow.hidden = false;
    } else if (best?.secondary) {
      secondaryLabel.textContent = `Best ${best.secondary.label.toLowerCase()}`;
      secondaryValue.textContent = formatMetric(best.secondary);
      secondaryRow.hidden = false;
    } else {
      secondaryRow.hidden = true;
    }
  }

  function showError(message: string): void {
    stage.replaceChildren();
    const error = document.createElement('div');
    error.className = 'player-error';
    error.textContent = message;
    stage.appendChild(error);
    busy = false;
    status.textContent = 'Unable to start';
    restart.textContent = 'Retry';
    restart.disabled = false;
  }

  async function mountRun(): Promise<void> {
    if (!mod || myId !== renderId) return;

    runId += 1;
    const myRunId = runId;
    destroyActive();
    stage.replaceChildren();
    currentScore = 0;
    currentSecondary = undefined;
    ended = false;
    busy = true;
    busyStatus = 'Starting';
    renderPanel();

    const host: GameHost = {
      updateScore(score) {
        if (ended || myId !== renderId || myRunId !== runId || !Number.isFinite(score)) return;
        currentScore = score;
        renderPanel();
      },
      updateMetric(metric) {
        if (ended || myId !== renderId || myRunId !== runId) return;
        const normalized = normalizeMetric(metric);
        if (!normalized) return;
        currentSecondary = normalized;
        renderPanel();
      },
      endRun(result) {
        if (ended || myId !== renderId || myRunId !== runId) return;
        if (typeof result?.score === 'number' && Number.isFinite(result.score)) {
          currentScore = result.score;
        }
        const resultMetric = normalizeMetric(result?.secondary);
        if (resultMetric) {
          currentSecondary = resultMetric;
        }
        ended = true;
        best = saveBest(gameId, { score: currentScore, secondary: currentSecondary });
        renderPanel();
      },
    };

    try {
      const instance = await mod.mount(stage, { host });
      if (myId !== renderId || myRunId !== runId) {
        instance.destroy();
        return;
      }
      active = instance;
      busy = false;
      renderPanel();
    } catch (err) {
      if (myId !== renderId || myRunId !== runId) return;
      console.error(`[launcher] mount() threw for ${id}`, err);
      showError('Could not start this game.');
    }
  }

  restart.addEventListener('click', () => {
    if (mod) {
      void mountRun();
      return;
    }
    void renderGame(id);
  });

  renderPanel();
  busy = true;
  busyStatus = 'Loading';
  renderPanel();

  try {
    mod = await entry.load();
  } catch (err) {
    if (myId !== renderId) return;
    console.error(`[launcher] failed to load module for ${id}`, err);
    showError('Could not load this game.');
    return;
  }
  if (myId !== renderId) return;
  await mountRun();
}

function route(): void {
  const id = window.location.hash.replace(/^#/, '');
  if (id) {
    void renderGame(id);
  } else {
    renderLanding();
  }
}

window.addEventListener('hashchange', route);
route();
