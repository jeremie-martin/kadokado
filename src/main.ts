import './style.css';
import type { GameHost, GameInstance, GameMetric, GameModule, GameResult } from './games/types';
import { GAMES, findGame } from './games/registry';

const rootEl = document.querySelector<HTMLDivElement>('#app');
if (!rootEl) {
  throw new Error('Missing #app mount point');
}
const root = rootEl;
const BESTS_STORAGE_KEY = 'motiontwin-ports:v1:bests';
const PSEUDONYM_STORAGE_KEY = 'motiontwin-ports:v1:pseudonym';

let active: GameInstance | null = null;
let renderId = 0;

type StoredBest = {
  score: number;
  secondary?: GameMetric;
  updatedAt: string;
};

type StoredBests = Record<string, StoredBest>;

type LeaderboardEntry = {
  id: number;
  gameId: string;
  pseudonym: string;
  score: number;
  submittedAt: string;
  secondary?: GameMetric;
};

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

function normalizeLeaderboardEntry(value: unknown): LeaderboardEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const gameId = value.gameId;
  const pseudonym = value.pseudonym;
  const score = value.score;
  const submittedAt = value.submittedAt;
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    typeof gameId !== 'string' ||
    typeof pseudonym !== 'string' ||
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    typeof submittedAt !== 'string'
  ) {
    return undefined;
  }
  const secondary = normalizeMetric(value.secondary);
  return secondary === undefined ? { id, gameId, pseudonym, score, submittedAt } : { id, gameId, pseudonym, score, submittedAt, secondary };
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

function readPseudonym(): string {
  try {
    return window.localStorage.getItem(PSEUDONYM_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writePseudonym(pseudonym: string): void {
  try {
    window.localStorage.setItem(PSEUDONYM_STORAGE_KEY, pseudonym);
  } catch {
    // Private browsing / quota failures should not block score submission.
  }
}

function saveBest(gameId: string, result: GameResult): { best: StoredBest; isNew: boolean } {
  const bests = readBests();
  const previous = bests[gameId];
  if (previous && previous.score >= result.score) {
    return { best: previous, isNew: false };
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
  return { best: next, isNew: true };
}

async function readApiJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(response.ok ? 'The server returned invalid JSON.' : response.statusText);
  }
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error) {
    return payload.error;
  }
  return fallback;
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

async function fetchLeaderboard(gameId: string): Promise<LeaderboardEntry[]> {
  const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/leaderboard?limit=10`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await readApiJson(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, 'Could not load leaderboard.'));
  }
  if (!isRecord(payload) || !Array.isArray(payload.entries)) {
    throw new Error('The server returned an invalid leaderboard.');
  }
  return payload.entries.map(normalizeLeaderboardEntry).filter((entry): entry is LeaderboardEntry => Boolean(entry));
}

async function submitScore(gameId: string, pseudonym: string, result: GameResult): Promise<{ entry: LeaderboardEntry; leaderboard: LeaderboardEntry[] }> {
  const body: { pseudonym: string; score: number; secondary?: GameMetric } = {
    pseudonym,
    score: result.score,
  };
  if (result.secondary) {
    body.secondary = result.secondary;
  }

  const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/scores`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await readApiJson(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, 'Could not save score.'));
  }
  if (!isRecord(payload)) {
    throw new Error('The server returned an invalid score response.');
  }
  const entry = normalizeLeaderboardEntry(payload.entry);
  if (!entry || !Array.isArray(payload.leaderboard)) {
    throw new Error('The server returned an invalid score response.');
  }
  const leaderboard = payload.leaderboard.map(normalizeLeaderboardEntry).filter((item): item is LeaderboardEntry => Boolean(item));
  return { entry, leaderboard };
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
  let saveCandidate: GameResult | null = null;
  let submitBusy = false;
  let submitError = '';
  let scoreSaved = false;
  let leaderboardEntries: LeaderboardEntry[] = [];
  let leaderboardLoading = false;
  let leaderboardError = '';
  let leaderboardRequestId = 0;

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

  const submitForm = document.createElement('form');
  submitForm.className = 'player-submit';
  submitForm.hidden = true;
  const submitTitle = document.createElement('h2');
  submitTitle.textContent = 'Save score';
  const pseudonymLabel = document.createElement('label');
  const pseudonymInputId = `pseudonym-${myId}`;
  pseudonymLabel.htmlFor = pseudonymInputId;
  pseudonymLabel.textContent = 'Pseudonym';
  const submitControls = document.createElement('div');
  submitControls.className = 'player-submit-controls';
  const pseudonymInput = document.createElement('input');
  pseudonymInput.id = pseudonymInputId;
  pseudonymInput.name = 'pseudonym';
  pseudonymInput.type = 'text';
  pseudonymInput.setAttribute('autocomplete', 'nickname');
  pseudonymInput.maxLength = 64;
  pseudonymInput.placeholder = 'Name';
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.textContent = 'Save';
  const submitMessage = document.createElement('p');
  submitMessage.className = 'player-submit-message';
  submitControls.append(pseudonymInput, submitButton);
  submitForm.append(submitTitle, pseudonymLabel, submitControls, submitMessage);

  const leaderboardSection = document.createElement('section');
  leaderboardSection.className = 'player-leaderboard';
  const leaderboardTitle = document.createElement('h2');
  leaderboardTitle.textContent = 'Leaderboard';
  const leaderboardList = document.createElement('ol');
  leaderboardList.className = 'player-leaderboard-list';
  const leaderboardMessage = document.createElement('p');
  leaderboardMessage.className = 'player-leaderboard-message';
  leaderboardSection.append(leaderboardTitle, leaderboardMessage, leaderboardList);

  panel.append(title, status, currentRow, bestRow, secondaryRow, restart, submitForm, leaderboardSection);
  layout.append(stage, panel);
  player.append(back, layout);
  root.appendChild(player);

  function renderPanel(): void {
    currentValue.textContent = formatNumber(currentScore);
    bestValue.textContent = best ? formatNumber(best.score) : '-';
    status.textContent = busy
      ? busyStatus
      : submitBusy
        ? 'Saving score'
        : saveCandidate
          ? 'New best'
          : scoreSaved
            ? 'Score saved'
            : ended
              ? 'Run ended'
              : 'Playing';
    restart.textContent = ended ? 'Play again' : 'Restart';
    restart.disabled = busy || submitBusy;

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

    submitForm.hidden = !saveCandidate;
    pseudonymInput.disabled = submitBusy;
    submitButton.disabled = submitBusy;
    submitMessage.textContent = submitError;
    submitMessage.hidden = submitError === '';
  }

  function renderLeaderboard(): void {
    leaderboardList.replaceChildren();
    leaderboardMessage.hidden = false;

    if (leaderboardLoading) {
      leaderboardMessage.textContent = 'Loading leaderboard';
      return;
    }
    if (leaderboardError) {
      leaderboardMessage.textContent = leaderboardError;
      return;
    }
    if (leaderboardEntries.length === 0) {
      leaderboardMessage.textContent = 'No scores yet';
      return;
    }

    leaderboardMessage.hidden = true;
    leaderboardMessage.textContent = '';
    leaderboardEntries.forEach((leaderboardEntry, index) => {
      const item = document.createElement('li');
      item.className = 'player-leaderboard-row';

      const rank = document.createElement('span');
      rank.className = 'player-leaderboard-rank';
      rank.textContent = String(index + 1);

      const name = document.createElement('span');
      name.className = 'player-leaderboard-name';
      name.textContent = leaderboardEntry.pseudonym;

      const score = document.createElement('strong');
      score.className = 'player-leaderboard-score';
      score.textContent = formatNumber(leaderboardEntry.score);

      item.append(rank, name, score);
      if (leaderboardEntry.secondary) {
        const secondary = document.createElement('span');
        secondary.className = 'player-leaderboard-secondary';
        secondary.textContent = `${leaderboardEntry.secondary.label}: ${formatMetric(leaderboardEntry.secondary)}`;
        item.appendChild(secondary);
      }
      leaderboardList.appendChild(item);
    });
  }

  async function refreshLeaderboard(): Promise<void> {
    const requestId = ++leaderboardRequestId;
    leaderboardLoading = true;
    leaderboardError = '';
    renderLeaderboard();

    try {
      const entries = await fetchLeaderboard(gameId);
      if (myId !== renderId || requestId !== leaderboardRequestId) return;
      leaderboardEntries = entries;
    } catch (err) {
      if (myId !== renderId || requestId !== leaderboardRequestId) return;
      leaderboardError = getErrorMessage(err, 'Leaderboard unavailable.');
    } finally {
      if (myId === renderId && requestId === leaderboardRequestId) {
        leaderboardLoading = false;
        renderLeaderboard();
      }
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

  async function submitCandidate(): Promise<void> {
    if (!saveCandidate || submitBusy) return;
    const candidate = saveCandidate;
    const submitRunId = runId;
    submitBusy = true;
    submitError = '';
    scoreSaved = false;
    renderPanel();

    try {
      const saved = await submitScore(gameId, pseudonymInput.value, candidate);
      if (myId !== renderId || submitRunId !== runId) return;
      leaderboardRequestId += 1;
      writePseudonym(saved.entry.pseudonym);
      saveCandidate = null;
      scoreSaved = true;
      leaderboardEntries = saved.leaderboard;
      leaderboardError = '';
      leaderboardLoading = false;
      renderLeaderboard();
    } catch (err) {
      if (myId !== renderId || submitRunId !== runId) return;
      submitError = getErrorMessage(err, 'Could not save score.');
    } finally {
      if (myId === renderId && submitRunId === runId) {
        submitBusy = false;
        renderPanel();
      }
    }
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
    saveCandidate = null;
    submitError = '';
    scoreSaved = false;
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

        const finalResult: GameResult = currentSecondary ? { score: currentScore, secondary: currentSecondary } : { score: currentScore };
        const saved = saveBest(gameId, finalResult);
        best = saved.best;
        if (saved.isNew) {
          saveCandidate = finalResult;
          pseudonymInput.value = readPseudonym();
          submitError = '';
          scoreSaved = false;
        }
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

  submitForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCandidate();
  });

  renderPanel();
  renderLeaderboard();
  void refreshLeaderboard();
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
