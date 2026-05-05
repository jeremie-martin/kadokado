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
const SITE_ASSET_BASE = '/assets/site/kadokado';

const MENU_ITEMS = [
  { label: 'Jouer', href: '#', exact: true },
  { label: 'Scores', href: '#scores', exact: false },
  { label: 'Fidelity', href: '#fidelity', exact: false },
  { label: 'About', href: '#about', exact: false },
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

const LEGACY_DESCRIPTIONS: Record<string, string> = {
  interwheel:
    "Au secours c'est l'inondation, aidez krakra la petite tache de crasse a s'evader de la salle de bain du temple azteque Tenochtitlan, attention aux mines ancestrales du grand Quetzal !",
  pioupiou:
    "Aidez le pauvre Piou-Piou tombe dans cet affreux piege digne des plus machiaveliques ecraseurs de poussins.",
  manda: 'Tortillez-vous pour ramasser les fruits et les bonus, tentez de survivre longtemps et surtout evitez les murs ! Un grand classique.',
  killbulle:
    "Retrouvez Kanji le Ninja dans une nouvelle aventure ! Utilisez le grapin de facon a detruire les bulles bondissantes et gagnez ainsi un max de points.",
  linea: "Tracez les lignes les plus longues possible, composez les bonus et tentez de garder le rythme jusqu'au dernier point lumineux.",
  alphabounce: "Rebondissez dans l'espace, cassez les blocs et survivez aux evenements qui transforment chaque niveau en pluie de lettres.",
  kslash:
    "Kanji est en infiltration au pays des bambous ! Debarassez vous de ses encombrantes tortues belliqueuses grace a vos shuriken et votre sabre.",
  'iron-chouquette':
    "La patrouille des lapins-robots a kidnappe chouquette ! Retrouvez-la avant qu'il ne soit trop tard dans le tournoi interstellaire d'andromede.",
};

const LEGACY_TITLES: Record<string, string> = {
  killbulle: 'Kill Bulle',
  kslash: 'K-Slash !',
};

const HELP_TEXT: Record<string, string> = {
  interwheel: 'Use one button to jump from wheel to wheel. Avoid mines and rising water while climbing as high as possible.',
  pioupiou: 'Move with the arrow keys. Climb falling blocks, collect coins, and avoid getting crushed.',
  manda: 'Steer with left and right, accelerate with up, collect fruit and bonuses, and avoid the walls and your tail.',
  killbulle: 'Move with the arrow keys. Fire the grappling hook with space to split bubbles before they touch Kanji.',
  linea: 'Draw paths through matching dots. Longer lines and multipliers are the key to a strong score.',
  alphabounce: 'Control the paddle, break letter blocks, catch useful bonuses, and survive each event wave.',
  kslash: 'Move, jump, slash, and throw kunai to clear enemies while pushing through the bamboo stages.',
  'iron-chouquette': 'Dodge bullet patterns, collect bonuses, and push through the boss rush without losing control of the arena.',
};

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

async function fetchLeaderboard(gameId: string, limit = 10): Promise<LeaderboardEntry[]> {
  const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/leaderboard?limit=${encodeURIComponent(String(limit))}`, {
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

function recordText(score: number | undefined): string {
  return score === undefined ? 'Record: -' : `Record: ${formatNumber(score)}`;
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
  root.replaceChildren();
}

function legacyTitle(entry: { meta: { id: string; title: string } }): string {
  return LEGACY_TITLES[entry.meta.id] ?? entry.meta.title;
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
    link.textContent = item.label;
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
  gameCount.textContent = `${GAMES.length} games online`;
  const noAccount = document.createElement('p');
  noAccount.textContent = 'No account required';
  buildInfo.append(gameCount, noAccount);

  content.append(createMenuBox(), createPaneBox('Build', [buildInfo]));
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
  statusLine.textContent = 'Ports playable';
  const statusLink = document.createElement('a');
  statusLink.href = '#fidelity';
  statusLink.textContent = 'Fidelity notes';
  status.append(statusLine, statusLink);

  const scores = document.createElement('div');
  scores.className = 'sideText';
  const scoreLine = document.createElement('p');
  scoreLine.textContent = 'Records use saved scores';
  const scoreLink = document.createElement('a');
  scoreLink.href = '#scores';
  scoreLink.textContent = 'View scores';
  scores.append(scoreLine, scoreLink);

  content.append(createPaneBox('Status', [status]), createPaneBox('Scores', [scores]));
  pane.appendChild(content);
  return pane;
}

function createInfoBar(): HTMLDivElement {
  const bar = document.createElement('div');
  bar.id = 'mainBarInfo';
  bar.textContent = 'Fan preservation project - play instantly';
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
    { label: 'about', href: '#about' },
    { label: 'fidelity', href: '#fidelity' },
    { label: 'scores', href: '#scores' },
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
  footerText.textContent = 'Fan preservation project - original games by Motion Twin';
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
  imageLink.title = 'jouer';
  const image = document.createElement('img');
  image.src = LEGACY_THUMBNAILS[entry.meta.id] ?? '';
  image.alt = 'image';
  imageLink.appendChild(image);
  caption.appendChild(imageLink);

  const desc = document.createElement('div');
  desc.className = 'gameDesc';
  const title = document.createElement('h3');
  title.textContent = legacyTitle(entry);
  const text = document.createElement('p');
  text.textContent = LEGACY_DESCRIPTIONS[entry.meta.id] ?? entry.meta.description;
  desc.append(title, text);

  const play = document.createElement('div');
  play.className = 'playLink';
  const playLink = document.createElement('a');
  playLink.href = `#${entry.meta.id}`;
  playLink.textContent = 'jouer';
  play.appendChild(playLink);

  const help = document.createElement('div');
  help.className = 'helpLink';
  const helpLink = document.createElement('a');
  helpLink.href = `#help-${entry.meta.id}`;
  helpLink.textContent = 'aide';
  help.appendChild(helpLink);

  const helpBox = document.createElement('div');
  helpBox.className = 'helpBox';
  helpBox.id = `help-${entry.meta.id}`;
  helpBox.hidden = true;
  const helpContent = document.createElement('div');
  helpContent.className = 'help';
  helpContent.textContent = HELP_TEXT[entry.meta.id] ?? entry.meta.description;
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
  const myId = renderId;
  const games = document.createElement('div');
  games.className = 'gameList';

  const notice = document.createElement('p');
  notice.className = 'error';
  notice.textContent = 'Playable ports, rebuilt with original assets where available';
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
  const page = createTextPage('About');
  const intro = document.createElement('p');
  intro.textContent =
    'This is a fan preservation project for playable Motion Twin and KadoKado-era browser games. The ports use TypeScript and PixiJS, with original extracted assets where available.';
  const scope = document.createElement('p');
  scope.textContent =
    'The website keeps the 2005-2006 portal aesthetic, but avoids fake accounts, prizes, forums, clans, ads, and platform features that are not implemented.';
  page.append(intro, scope);
  root.appendChild(createPortalShell(page));
}

function renderFidelity(): void {
  clear();
  const page = createTextPage('Fidelity');
  const list = document.createElement('ul');
  for (const item of [
    'source-backed: confirmed from original source or SWF metadata',
    'capture-backed: confirmed against archived or runtime captures',
    'asset-backed: confirmed from extracted image and font assets',
    'inferred: temporary best guess waiting for stronger evidence',
  ]) {
    const row = document.createElement('li');
    row.textContent = item;
    list.appendChild(row);
  }
  const docs = document.createElement('p');
  docs.textContent = 'The current canonical notes live in docs/FIDELITY.md and docs/porting/.';
  page.append(list, docs);
  root.appendChild(createPortalShell(page));
}

function renderScores(): void {
  clear();
  const myId = renderId;
  const page = createTextPage('Scores');
  const list = document.createElement('div');
  list.className = 'scoresPage';

  for (const entry of GAMES) {
    const box = document.createElement('section');
    box.className = 'scoreBox';
    const heading = document.createElement('h2');
    heading.textContent = legacyTitle(entry);
    const rows = document.createElement('ol');
    rows.className = 'scoreRows';
    const message = document.createElement('p');
    message.className = 'scoreMessage';
    message.textContent = 'Loading scores';
    box.append(heading, message, rows);
    list.appendChild(box);

    void fetchLeaderboard(entry.meta.id, 5)
      .then((entries) => {
        if (myId !== renderId) return;
        rows.replaceChildren();
        if (entries.length === 0) {
          message.textContent = 'No scores yet';
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
        message.textContent = getErrorMessage(err, 'Scores unavailable.');
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
  back.textContent = 'Retour aux jeux';
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
  title.textContent = legacyTitle(entry);

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

  panel.append(title, status, currentRow, bestRow, secondaryRow, restart, back, submitForm, leaderboardSection);
  layout.append(stage, panel);
  player.appendChild(layout);
  root.appendChild(createPortalShell(player));

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
  if (id === 'scores') {
    renderScores();
  } else if (id === 'about') {
    renderAbout();
  } else if (id === 'fidelity') {
    renderFidelity();
  } else if (id) {
    void renderGame(id);
  } else {
    renderLanding();
  }
}

window.addEventListener('hashchange', route);
route();
