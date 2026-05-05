import './style.css';
import type { GameHost, GameInstance, GameMetric, GameModule, GameResult } from './games/types';
import { GAMES, findGame } from './games/registry';
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
  currentLanguage,
  formatLocalizedNumber,
  initI18n,
  metricLabel,
  onLanguageChanged,
  setLanguage,
  t,
} from './i18n';

const rootEl = document.querySelector<HTMLDivElement>('#app');
if (!rootEl) {
  throw new Error('Missing #app mount point');
}
const root = rootEl;
const BESTS_STORAGE_KEY = 'motiontwin-ports:v1:bests';
const PSEUDONYM_STORAGE_KEY = 'motiontwin-ports:v1:pseudonym';
const SITE_ASSET_BASE = '/assets/site/kadokado';
const MAX_PSEUDONYM_LENGTH = 24;

const MENU_ITEMS = [
  { labelKey: 'nav.play', href: '#', exact: true },
  { labelKey: 'nav.scores', href: '#scores', exact: false },
  { labelKey: 'nav.about', href: '#about', exact: false },
];

const LEGACY_THUMBNAILS: Record<string, string> = {
  interwheel: `${SITE_ASSET_BASE}/games/30.gif`,
  pioupiou: `${SITE_ASSET_BASE}/games/8.gif`,
  manda: `${SITE_ASSET_BASE}/games/7.gif`,
  killbulle: `${SITE_ASSET_BASE}/games/13.gif`,
  kslash: `${SITE_ASSET_BASE}/games/22.gif`,
  'iron-chouquette': `${SITE_ASSET_BASE}/games/35.gif`,
  linea: '/assets/linea/start.png',
  alphabounce: '/assets/alphabounce/title.png',
};

let active: GameInstance | null = null;
let renderId = 0;
let refreshCurrentView: (() => void) | null = null;

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

const API_ERROR_KEYS: Record<string, string> = {
  'Pseudonym is required.': 'errors.pseudonymRequired',
  'Pseudonym contains unsupported characters.': 'errors.pseudonymUnsupported',
  'Pseudonym must be 24 characters or fewer.': 'errors.pseudonymTooLong',
  'Score must be a non-negative integer.': 'errors.invalidScore',
  'Too many score submissions. Try again later.': 'errors.rateLimited',
  'Cross-origin score submissions are not accepted.': 'errors.crossOrigin',
  'Request body must be a JSON object.': 'errors.invalidBody',
  'Request body must be valid JSON.': 'errors.invalidJson',
  'Unknown game.': 'errors.unknownGame',
  'Internal server error.': 'errors.internalServer',
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
    throw new Error(response.ok ? t('errors.invalidJson') : response.statusText);
  }
}

function apiErrorMessage(payload: unknown, fallbackKey: string): string {
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error) {
    const key = API_ERROR_KEYS[payload.error];
    return key ? t(key) : payload.error;
  }
  return t(fallbackKey);
}

function getErrorMessage(err: unknown, fallbackKey: string): string {
  return err instanceof Error && err.message ? err.message : t(fallbackKey);
}

async function fetchLeaderboard(gameId: string, limit = 10): Promise<LeaderboardEntry[]> {
  const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/leaderboard?limit=${encodeURIComponent(String(limit))}`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await readApiJson(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, 'errors.loadLeaderboard'));
  }
  if (!isRecord(payload) || !Array.isArray(payload.entries)) {
    throw new Error(t('errors.invalidLeaderboard'));
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
    throw new Error(apiErrorMessage(payload, 'errors.saveScore'));
  }
  if (!isRecord(payload)) {
    throw new Error(t('errors.invalidScoreResponse'));
  }
  const entry = normalizeLeaderboardEntry(payload.entry);
  if (!entry || !Array.isArray(payload.leaderboard)) {
    throw new Error(t('errors.invalidScoreResponse'));
  }
  const leaderboard = payload.leaderboard.map(normalizeLeaderboardEntry).filter((item): item is LeaderboardEntry => Boolean(item));
  return { entry, leaderboard };
}

function formatNumber(value: number): string {
  return formatLocalizedNumber(value);
}

function formatMetric(metric: GameMetric): string {
  const value = formatNumber(metric.value);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function recordText(score: number | undefined): string {
  return score === undefined ? t('record.empty') : t('record.value', { score: formatNumber(score) });
}

function localBestScore(gameId: string): number | undefined {
  return readBests()[gameId]?.score;
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
  refreshCurrentView = null;
  root.replaceChildren();
}

function gameTitle(entry: { meta: { id: string; title: string } }): string {
  return t(`games.${entry.meta.id}.title`, { defaultValue: entry.meta.title });
}

function gameDescription(entry: { meta: { id: string; description: string } }): string {
  return t(`games.${entry.meta.id}.description`, { defaultValue: entry.meta.description });
}

function gameHelp(entry: { meta: { id: string; description: string } }): string {
  return t(`games.${entry.meta.id}.help`, { defaultValue: entry.meta.description });
}

function localizedMetricLabel(metric: GameMetric): string {
  return metricLabel(metric.key, metric.label);
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function countGraphemes(value: string): number {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
      ) => { segment(value: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value)).length;
  }
  return Array.from(value).length;
}

function normalizedPseudonym(value: string): string {
  return normalizeWhitespace(value.normalize('NFKC'));
}

function validatePseudonym(value: string): string {
  if (value === '') {
    return 'errors.pseudonymRequired';
  }
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    return 'errors.pseudonymUnsupported';
  }
  if (countGraphemes(value) > MAX_PSEUDONYM_LENGTH) {
    return 'errors.pseudonymTooLong';
  }
  return '';
}

function createPaneBox(title: string, content: Node[], href?: string): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'paneBox';

  const header = document.createElement('div');
  header.className = 'paneBoxHeader';
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = title;
    header.appendChild(link);
  } else {
    header.textContent = title;
  }

  const body = document.createElement('div');
  body.className = 'paneBoxContent';
  body.append(...content);

  const footer = document.createElement('div');
  footer.className = 'paneBoxFooter';
  box.append(header, body, footer);
  return box;
}

function createMenuBox(): HTMLDivElement {
  const menu = document.createElement('div');
  menu.className = 'menuBox';
  for (const item of MENU_ITEMS) {
    const link = document.createElement('a');
    link.href = item.href;
    link.textContent = t(item.labelKey);
    const currentHash = window.location.hash || '#';
    if ((item.exact && currentHash === '#') || (!item.exact && currentHash === item.href)) {
      link.className = 'active';
    }
    menu.appendChild(link);
  }
  return menu;
}

function createLeftPane(): HTMLDivElement {
  const pane = document.createElement('div');
  pane.id = 'leftPane';
  const content = document.createElement('div');
  content.id = 'leftContent';

  const buildInfo = document.createElement('div');
  buildInfo.className = 'sideText';
  const gameCount = document.createElement('p');
  gameCount.textContent = t('site.gamesOnline', { count: GAMES.length });
  const noAccount = document.createElement('p');
  noAccount.textContent = t('site.noAccount');
  buildInfo.append(gameCount, noAccount);

  content.append(createMenuBox(), createPaneBox(t('site.buildTitle'), [buildInfo]));
  pane.appendChild(content);
  return pane;
}

function createRightPane(): HTMLDivElement {
  const pane = document.createElement('div');
  pane.id = 'rightPane';
  const content = document.createElement('div');
  content.id = 'rightContent';

  const status = document.createElement('div');
  status.className = 'sideText';
  const statusLine = document.createElement('p');
  statusLine.textContent = t('site.portsPlayable');
  const statusLink = document.createElement('a');
  statusLink.href = '#about';
  statusLink.textContent = t('site.aboutProject');
  status.append(statusLine, statusLink);

  const scores = document.createElement('div');
  scores.className = 'sideText';
  const scoreLine = document.createElement('p');
  scoreLine.textContent = t('site.recordsUseScores');
  const scoreLink = document.createElement('a');
  scoreLink.href = '#scores';
  scoreLink.textContent = t('site.viewScores');
  scores.append(scoreLine, scoreLink);

  content.append(createPaneBox(t('site.statusTitle'), [status]), createPaneBox(t('site.scoresTitle'), [scores]));
  pane.appendChild(content);
  return pane;
}

function createInfoBar(): HTMLDivElement {
  const bar = document.createElement('div');
  bar.id = 'mainBarInfo';
  const label = document.createElement('span');
  label.textContent = t('site.topBar');

  const languageSwitch = document.createElement('span');
  languageSwitch.className = 'languageSwitch';
  languageSwitch.setAttribute('aria-label', t('language.label'));

  SUPPORTED_LANGUAGES.forEach((language) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t(`language.${language}`);
    button.setAttribute('aria-pressed', String(currentLanguage() === language));
    if (currentLanguage() === language) {
      button.className = 'active';
    }
    button.addEventListener('click', () => {
      void setLanguage(language as SupportedLanguage);
    });
    languageSwitch.appendChild(button);
  });

  bar.append(label, languageSwitch);
  return bar;
}

function createPortalShell(content: HTMLElement): HTMLDivElement {
  const page = document.createElement('div');
  page.className = 'basicBg';

  const logo = document.createElement('div');
  logo.id = 'mainLogo';
  const logoLink = document.createElement('a');
  logoLink.href = '#';
  const logoImage = document.createElement('img');
  logoImage.src = `${SITE_ASSET_BASE}/1_logo.gif`;
  logoImage.alt = 'KadoKado';
  logoLink.appendChild(logoImage);
  logo.appendChild(logoLink);

  const container = document.createElement('div');
  container.id = 'container';
  const contentPane = document.createElement('div');
  contentPane.id = 'contentPane';
  const contentLarge = document.createElement('div');
  contentLarge.id = 'contentLarge';
  contentLarge.appendChild(content);
  contentPane.appendChild(contentLarge);

  const corporateLinks = document.createElement('div');
  corporateLinks.id = 'corporateLinks';
  const links = [
    { label: t('nav.about').toLowerCase(), href: '#about' },
    { label: t('nav.scores').toLowerCase(), href: '#scores' },
  ];
  links.forEach((item, index) => {
    const link = document.createElement('a');
    link.href = item.href;
    link.textContent = item.label;
    corporateLinks.appendChild(link);
    if (index < links.length - 1) {
      corporateLinks.append(' - ');
    }
  });

  const footer = document.createElement('div');
  footer.id = 'footer';
  const footerText = document.createElement('p');
  footerText.textContent = t('site.footer');
  footer.appendChild(footerText);

  container.append(createInfoBar(), createLeftPane(), createRightPane(), contentPane, corporateLinks, footer);
  page.append(logo, container);
  return page;
}

function createGameRow(entry: (typeof GAMES)[number], index: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = `gameBox ${index === 0 ? 'boxNewOpen' : 'boxOpen'}`;

  const record = document.createElement('div');
  record.className = 'recordBadge';
  record.dataset.gameRecord = entry.meta.id;
  record.textContent = recordText(localBestScore(entry.meta.id));

  const caption = document.createElement('div');
  caption.className = 'gameCaption';
  const imageLink = document.createElement('a');
  imageLink.href = `#${entry.meta.id}`;
  imageLink.title = t('actions.play');
  const image = document.createElement('img');
  image.src = LEGACY_THUMBNAILS[entry.meta.id] ?? '';
  image.alt = gameTitle(entry);
  imageLink.appendChild(image);
  caption.appendChild(imageLink);

  const desc = document.createElement('div');
  desc.className = 'gameDesc';
  const title = document.createElement('h3');
  title.textContent = gameTitle(entry);
  const text = document.createElement('p');
  text.textContent = gameDescription(entry);
  desc.append(title, text);

  const play = document.createElement('div');
  play.className = 'playLink';
  const playLink = document.createElement('a');
  playLink.href = `#${entry.meta.id}`;
  playLink.textContent = t('actions.play');
  play.appendChild(playLink);

  const help = document.createElement('div');
  help.className = 'helpLink';
  const helpLink = document.createElement('a');
  helpLink.href = `#help-${entry.meta.id}`;
  helpLink.textContent = t('actions.help');
  help.appendChild(helpLink);

  const helpBox = document.createElement('div');
  helpBox.className = 'helpBox';
  helpBox.id = `help-${entry.meta.id}`;
  helpBox.hidden = true;
  const helpContent = document.createElement('div');
  helpContent.className = 'help';
  helpContent.textContent = gameHelp(entry);
  helpBox.appendChild(helpContent);

  helpLink.addEventListener('click', (event) => {
    event.preventDefault();
    helpBox.hidden = !helpBox.hidden;
  });

  row.append(record, caption, desc, play, help);
  fragment.append(row, helpBox);
  return fragment;
}

async function refreshLandingRecords(pageRenderId: number): Promise<void> {
  await Promise.all(
    GAMES.map(async (entry) => {
      try {
        const [top] = await fetchLeaderboard(entry.meta.id, 1);
        if (pageRenderId !== renderId || !top) return;
        const node = root.querySelector<HTMLElement>(`[data-game-record="${entry.meta.id}"]`);
        if (node) {
          node.textContent = recordText(top.score);
        }
      } catch {
        // Keep the local best already rendered when the shared leaderboard is unavailable.
      }
    }),
  );
}

function renderLanding(): void {
  clear();
  refreshCurrentView = renderLanding;
  const myId = renderId;
  const games = document.createElement('div');
  games.className = 'gameList';

  const notice = document.createElement('p');
  notice.className = 'error';
  notice.textContent = t('landing.notice');
  games.appendChild(notice);

  GAMES.forEach((entry, index) => {
    games.appendChild(createGameRow(entry, index));
  });
  root.appendChild(createPortalShell(games));
  void refreshLandingRecords(myId);
}

function createTextPage(title: string): HTMLDivElement {
  const page = document.createElement('div');
  page.className = 'textPage';
  const heading = document.createElement('h1');
  heading.textContent = title;
  page.appendChild(heading);
  return page;
}

function renderAbout(): void {
  clear();
  refreshCurrentView = renderAbout;
  const page = createTextPage(t('pages.aboutTitle'));
  const intro = document.createElement('p');
  intro.textContent = t('pages.aboutIntro');
  const scope = document.createElement('p');
  scope.textContent = t('pages.aboutScope');
  page.append(intro, scope);
  root.appendChild(createPortalShell(page));
}

function renderScores(): void {
  clear();
  refreshCurrentView = renderScores;
  const myId = renderId;
  const page = createTextPage(t('pages.scoresTitle'));
  const list = document.createElement('div');
  list.className = 'scoresPage';

  for (const entry of GAMES) {
    const box = document.createElement('section');
    box.className = 'scoreBox';
    const heading = document.createElement('h2');
    heading.textContent = gameTitle(entry);
    const rows = document.createElement('ol');
    rows.className = 'scoreRows';
    const message = document.createElement('p');
    message.className = 'scoreMessage';
    message.textContent = t('pages.loadingScores');
    box.append(heading, message, rows);
    list.appendChild(box);

    void fetchLeaderboard(entry.meta.id, 5)
      .then((entries) => {
        if (myId !== renderId) return;
        rows.replaceChildren();
        if (entries.length === 0) {
          message.textContent = t('pages.noScores');
          return;
        }
        message.hidden = true;
        for (const leaderboardEntry of entries) {
          const item = document.createElement('li');
          const name = document.createElement('span');
          name.textContent = leaderboardEntry.pseudonym;
          const score = document.createElement('strong');
          score.textContent = formatNumber(leaderboardEntry.score);
          item.append(name, score);
          rows.appendChild(item);
        }
      })
      .catch((err) => {
        if (myId !== renderId) return;
        message.textContent = getErrorMessage(err, 'errors.scoresUnavailable');
      });
  }

  page.appendChild(list);
  root.appendChild(createPortalShell(page));
}

async function renderGame(id: string): Promise<void> {
  const entry = findGame(id);
  if (!entry) {
    renderLanding();
    return;
  }
  const gameEntry = entry;
  const gameId = gameEntry.meta.id;

  clear();
  const myId = renderId;
  let currentScore = 0;
  let currentSecondary: GameMetric | undefined;
  let ended = false;
  let best: StoredBest | null = readBests()[gameId] ?? null;
  let runId = 0;
  let mod: GameModule | null = null;
  let busy = false;
  let busyStatusKey = 'player.status.loading';
  let saveCandidate: GameResult | null = null;
  let submitBusy = false;
  let submitError = '';
  let submitErrorKey = '';
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
  back.textContent = t('player.back');
  back.addEventListener('click', () => {
    window.location.hash = '';
  });

  const layout = document.createElement('div');
  layout.className = 'player-layout';

  const stage = document.createElement('div');
  stage.className = 'player-stage';
  stage.style.width = `${gameEntry.meta.width}px`;
  stage.style.height = `${gameEntry.meta.height}px`;

  const panel = document.createElement('aside');
  panel.className = 'player-panel';

  const title = document.createElement('h1');
  title.className = 'player-title';
  title.textContent = gameTitle(gameEntry);

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
  currentLabel.textContent = t('player.score');
  currentRow.append(currentLabel, currentValue);

  const bestRow = document.createElement('div');
  bestRow.className = 'player-stat';
  const bestLabel = document.createElement('span');
  bestLabel.textContent = t('player.best');
  bestRow.append(bestLabel, bestValue);

  const restart = document.createElement('button');
  restart.className = 'player-action';
  restart.type = 'button';

  const submitForm = document.createElement('form');
  submitForm.className = 'player-submit';
  submitForm.hidden = true;
  const submitTitle = document.createElement('h2');
  submitTitle.textContent = t('player.saveScore');
  const pseudonymLabel = document.createElement('label');
  const pseudonymInputId = `pseudonym-${myId}`;
  pseudonymLabel.htmlFor = pseudonymInputId;
  pseudonymLabel.textContent = t('player.pseudonym');
  const submitControls = document.createElement('div');
  submitControls.className = 'player-submit-controls';
  const pseudonymInput = document.createElement('input');
  pseudonymInput.id = pseudonymInputId;
  pseudonymInput.name = 'pseudonym';
  pseudonymInput.type = 'text';
  pseudonymInput.setAttribute('autocomplete', 'nickname');
  pseudonymInput.placeholder = t('player.pseudonymPlaceholder');
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.textContent = t('player.save');
  const submitMessage = document.createElement('p');
  submitMessage.className = 'player-submit-message';
  submitControls.append(pseudonymInput, submitButton);
  submitForm.append(submitTitle, pseudonymLabel, submitControls, submitMessage);

  const leaderboardSection = document.createElement('section');
  leaderboardSection.className = 'player-leaderboard';
  const leaderboardTitle = document.createElement('h2');
  leaderboardTitle.textContent = t('player.leaderboard');
  const leaderboardList = document.createElement('ol');
  leaderboardList.className = 'player-leaderboard-list';
  const leaderboardMessage = document.createElement('p');
  leaderboardMessage.className = 'player-leaderboard-message';
  leaderboardSection.append(leaderboardTitle, leaderboardMessage, leaderboardList);

  panel.append(title, status, currentRow, bestRow, secondaryRow, restart, back, submitForm, leaderboardSection);
  layout.append(stage, panel);
  player.appendChild(layout);
  root.appendChild(createPortalShell(player));

  function refreshGameText(): void {
    title.textContent = gameTitle(gameEntry);
    currentLabel.textContent = t('player.score');
    bestLabel.textContent = t('player.best');
    submitTitle.textContent = t('player.saveScore');
    pseudonymLabel.textContent = t('player.pseudonym');
    pseudonymInput.placeholder = t('player.pseudonymPlaceholder');
    submitButton.textContent = t('player.save');
    leaderboardTitle.textContent = t('player.leaderboard');
    back.textContent = t('player.back');
    renderPanel();
    renderLeaderboard();
  }

  refreshCurrentView = () => {
    refreshGameText();
    root.replaceChildren(createPortalShell(player));
    if (leaderboardError) {
      void refreshLeaderboard();
    }
  };

  function renderPanel(): void {
    currentValue.textContent = formatNumber(currentScore);
    bestValue.textContent = best ? formatNumber(best.score) : '-';
    status.textContent = busy
      ? t(busyStatusKey)
      : submitBusy
        ? t('player.status.saving')
        : saveCandidate
          ? t('player.status.newBest')
          : scoreSaved
            ? t('player.status.saved')
            : ended
              ? t('player.status.ended')
              : t('player.status.playing');
    restart.textContent = ended ? t('player.playAgain') : t('player.restart');
    restart.disabled = busy || submitBusy;

    if (currentSecondary) {
      secondaryLabel.textContent = localizedMetricLabel(currentSecondary);
      secondaryValue.textContent = formatMetric(currentSecondary);
      secondaryRow.hidden = false;
    } else if (best?.secondary) {
      secondaryLabel.textContent = t('player.bestMetric', { label: localizedMetricLabel(best.secondary).toLowerCase() });
      secondaryValue.textContent = formatMetric(best.secondary);
      secondaryRow.hidden = false;
    } else {
      secondaryRow.hidden = true;
    }

    submitForm.hidden = !saveCandidate;
    pseudonymInput.disabled = submitBusy;
    submitButton.disabled = submitBusy;
    const submitErrorText = submitErrorKey ? t(submitErrorKey) : submitError;
    submitMessage.textContent = submitErrorText;
    submitMessage.hidden = submitErrorText === '';
  }

  function renderLeaderboard(): void {
    leaderboardList.replaceChildren();
    leaderboardMessage.hidden = false;

    if (leaderboardLoading) {
      leaderboardMessage.textContent = t('player.loadingLeaderboard');
      return;
    }
    if (leaderboardError) {
      leaderboardMessage.textContent = leaderboardError;
      return;
    }
    if (leaderboardEntries.length === 0) {
      leaderboardMessage.textContent = t('player.noScores');
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
        secondary.textContent = `${localizedMetricLabel(leaderboardEntry.secondary)}: ${formatMetric(leaderboardEntry.secondary)}`;
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
      leaderboardError = getErrorMessage(err, 'errors.leaderboardUnavailable');
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
    status.textContent = t('player.status.unableToStart');
    restart.textContent = t('player.retry');
    restart.disabled = false;
  }

  async function submitCandidate(): Promise<void> {
    if (!saveCandidate || submitBusy) return;
    const candidate = saveCandidate;
    const submitRunId = runId;
    const pseudonym = normalizedPseudonym(pseudonymInput.value);
    const validationError = validatePseudonym(pseudonym);
    if (validationError) {
      pseudonymInput.value = pseudonym;
      submitError = '';
      submitErrorKey = validationError;
      scoreSaved = false;
      renderPanel();
      return;
    }

    pseudonymInput.value = pseudonym;
    submitBusy = true;
    submitError = '';
    submitErrorKey = '';
    scoreSaved = false;
    renderPanel();

    try {
      const saved = await submitScore(gameId, pseudonym, candidate);
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
      submitErrorKey = '';
      submitError = getErrorMessage(err, 'errors.saveScore');
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
    submitErrorKey = '';
    scoreSaved = false;
    busy = true;
    busyStatusKey = 'player.status.starting';
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
          submitErrorKey = '';
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
      showError(t('errors.startGame'));
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
  busyStatusKey = 'player.status.loading';
  renderPanel();

  try {
    mod = await gameEntry.load();
  } catch (err) {
    if (myId !== renderId) return;
    console.error(`[launcher] failed to load module for ${id}`, err);
    showError(t('errors.loadGame'));
    return;
  }
  if (myId !== renderId) return;
  await mountRun();
}

function route(): void {
  const id = window.location.hash.replace(/^#/, '');
  if (id === 'scores') {
    renderScores();
  } else if (id === 'about') {
    renderAbout();
  } else if (id) {
    void renderGame(id);
  } else {
    renderLanding();
  }
}

async function start(): Promise<void> {
  await initI18n();
  onLanguageChanged(() => {
    refreshCurrentView?.();
  });
  window.addEventListener('hashchange', route);
  route();
}

void start();
