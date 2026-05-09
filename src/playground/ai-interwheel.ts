import { mount, type InterwheelGame } from '../games/interwheel/index';
import { clamp } from '../games/interwheel/sim';
import { noopGameHost } from '../games/types';
import { makeSeededRng } from './interwheel-edge-validator';
import {
  DEFAULT_PLANNER_POLICY,
  InterwheelPlanner,
  LINEAGE_DEFAULTS,
  PLANNER_PERCEPTION_DEFAULTS,
  PLANNER_SEARCH_DEFAULTS,
  type PlannerPolicy,
  type PlanResult,
} from './interwheel-planner';
import { OVERLAY_DEFAULTS, TrajectoryOverlay } from './trajectory-overlay';

const stage = document.getElementById('stage');
const stats = document.getElementById('stats');
if (!stage) throw new Error('missing #stage');

type PolicyKey = keyof PlannerPolicy;

const POLICY_KEYS: PolicyKey[] = [
  'climb',
  'wall',
];
const policyInputs = new Map<PolicyKey, HTMLInputElement>();
const policyOutputs = new Map<PolicyKey, HTMLOutputElement>();
const policyReset = document.getElementById('policy-reset') as HTMLButtonElement | null;
const lookaheadInput = document.getElementById('planner-lookahead') as HTMLInputElement | null;
const lookaheadOutput = document.getElementById('planner-lookahead-value') as HTMLOutputElement | null;
const searchDepthInput = document.getElementById('planner-searchDepth') as HTMLInputElement | null;
const searchDepthOutput = document.getElementById('planner-searchDepth-value') as HTMLOutputElement | null;
const edgeBudgetInput = document.getElementById('planner-edgeBudget') as HTMLInputElement | null;
const edgeBudgetOutput = document.getElementById('planner-edgeBudget-value') as HTMLOutputElement | null;
const planBudgetInput = document.getElementById('planner-planBudgetMs') as HTMLInputElement | null;
const planBudgetOutput = document.getElementById('planner-planBudgetMs-value') as HTMLOutputElement | null;
// Renderer params trigger a redraw of the cached segments; lineage params
// require a re-plan to recompute support.
const OVERLAY_PARAM_DEFAULTS = {
  lineageDecay: LINEAGE_DEFAULTS.decay,
  lineageGamma: LINEAGE_DEFAULTS.gamma,
  minSupportRank: OVERLAY_DEFAULTS.minSupportRank,
  widthMin: OVERLAY_DEFAULTS.widthMin,
  widthMax: OVERLAY_DEFAULTS.widthMax,
  shareWidthScale: OVERLAY_DEFAULTS.shareWidthScale,
  generationWeight1: OVERLAY_DEFAULTS.generationWidthWeights[0],
  generationWeight2: OVERLAY_DEFAULTS.generationWidthWeights[1],
  generationWeight3: OVERLAY_DEFAULTS.generationWidthWeights[2],
  alphaMin: OVERLAY_DEFAULTS.alphaMin,
  alphaMax: OVERLAY_DEFAULTS.alphaMax,
  alphaGamma: OVERLAY_DEFAULTS.alphaGamma,
};
type OverlayParamKey = keyof typeof OVERLAY_PARAM_DEFAULTS;
const OVERLAY_PARAM_KEYS = Object.keys(OVERLAY_PARAM_DEFAULTS) as OverlayParamKey[];
const OVERLAY_PARAM_PRECISION: Record<OverlayParamKey, number> = {
  lineageDecay: 2,
  lineageGamma: 1,
  minSupportRank: 2,
  widthMin: 2,
  widthMax: 1,
  shareWidthScale: 1,
  generationWeight1: 2,
  generationWeight2: 2,
  generationWeight3: 2,
  alphaMin: 2,
  alphaMax: 2,
  alphaGamma: 1,
};
const overlayParamInputs = new Map<OverlayParamKey, HTMLInputElement>();
const overlayParamOutputs = new Map<OverlayParamKey, HTMLOutputElement>();
const overlayReset = document.getElementById('overlay-reset') as HTMLButtonElement | null;
const colorInput = document.getElementById('overlay-color') as HTMLInputElement | null;
const colorByGenerationInput = document.getElementById('overlay-colorByGeneration') as HTMLInputElement | null;
const highlightChosenInput = document.getElementById('overlay-highlightChosen') as HTMLInputElement | null;
let overlayParams: Record<OverlayParamKey, number> = { ...OVERLAY_PARAM_DEFAULTS };
let overlayColor: number = OVERLAY_DEFAULTS.color;
let lookaheadScreens = PLANNER_PERCEPTION_DEFAULTS.revealScreensAbove;
let searchLimits = { ...PLANNER_SEARCH_DEFAULTS };

let game: InterwheelGame | null = null;
let planner: InterwheelPlanner | null = null;
let overlay: TrajectoryOverlay | null = null;
let aiActive = true;
let policy: PlannerPolicy = { ...DEFAULT_PLANNER_POLICY };
let previewFrame: number | null = null;
let lastPlanMs = 0;
let lastSegmentCount = 0;
let lastEdges = 0;
let lastNodes = 0;
let lastPerceived = '0w/0p';
let lastShownSegments = 0;
let lastShownEdges = 0;
let lastCulledEdges = 0;
let lastSupportRange = '—';
let pendingPress: boolean | null = null;
let isPaused = false;

function isPolicyKey(value: string): value is PolicyKey {
  return (POLICY_KEYS as string[]).includes(value);
}

function formatPolicyValue(value: number): string {
  return value.toFixed(2);
}

function syncPolicyControls(): void {
  for (const key of POLICY_KEYS) {
    const input = policyInputs.get(key);
    const output = policyOutputs.get(key);
    if (input) input.value = String(policy[key]);
    if (output) output.value = formatPolicyValue(policy[key]);
  }
}

function readPolicyControls(): PlannerPolicy {
  // Start from current policy so keys without a UI input (e.g. climb,
  // collect when only the Focus slider is shown) retain their values.
  const next: PlannerPolicy = { ...policy };
  for (const key of POLICY_KEYS) {
    const input = policyInputs.get(key);
    if (!input) continue;
    const value = Number(input.value);
    next[key] = Number.isFinite(value) ? value : DEFAULT_PLANNER_POLICY[key];
  }
  return next;
}

function applyPolicy(next: PlannerPolicy): void {
  policy = { ...next };
  planner?.setPolicy(policy);
  syncPolicyControls();
  refreshStats();
  schedulePolicyPreview();
}

function setupPolicyControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[data-policy-key]').forEach((input) => {
    const rawKey = input.dataset.policyKey;
    if (!rawKey || !isPolicyKey(rawKey)) return;
    const output = document.getElementById(`${input.id}-value`) as HTMLOutputElement | null;
    policyInputs.set(rawKey, input);
    if (output) policyOutputs.set(rawKey, output);
    input.addEventListener('input', () => applyPolicy(readPolicyControls()));
  });

  policyReset?.addEventListener('click', () => applyPolicy({ ...DEFAULT_PLANNER_POLICY }));
  syncPolicyControls();
}

function syncPlannerExperimentControls(): void {
  if (lookaheadInput) lookaheadInput.value = String(lookaheadScreens);
  if (lookaheadOutput) lookaheadOutput.value = lookaheadScreens.toFixed(2);
  if (searchDepthInput) searchDepthInput.value = String(searchLimits.maxStableDepth);
  if (searchDepthOutput) searchDepthOutput.value = String(searchLimits.maxStableDepth);
  if (edgeBudgetInput) edgeBudgetInput.value = String(searchLimits.maxEdgeRollouts);
  if (edgeBudgetOutput) edgeBudgetOutput.value = String(searchLimits.maxEdgeRollouts);
  if (planBudgetInput) planBudgetInput.value = String(searchLimits.budgetMs);
  if (planBudgetOutput) planBudgetOutput.value = `${searchLimits.budgetMs.toFixed(0)}ms`;
}

function applyLookaheadScreens(value: number): void {
  if (!Number.isFinite(value)) return;
  lookaheadScreens = clamp(value, 0, 4);
  planner?.setRevealScreensAbove(lookaheadScreens);
  syncPlannerExperimentControls();
  schedulePolicyPreview();
  refreshStats();
}

function applySearchLimits(next: Partial<typeof PLANNER_SEARCH_DEFAULTS>): void {
  searchLimits = {
    budgetMs: next.budgetMs !== undefined ? clamp(next.budgetMs, 1, 50) : searchLimits.budgetMs,
    maxEdgeRollouts: next.maxEdgeRollouts !== undefined ? Math.round(clamp(next.maxEdgeRollouts, 16, 2_000)) : searchLimits.maxEdgeRollouts,
    maxStableDepth: next.maxStableDepth !== undefined ? Math.round(clamp(next.maxStableDepth, 1, 8)) : searchLimits.maxStableDepth,
  };
  planner?.setSearchLimits(searchLimits);
  syncPlannerExperimentControls();
  schedulePolicyPreview();
  refreshStats();
}

function setupPlannerExperimentControls(): void {
  lookaheadInput?.addEventListener('input', () => applyLookaheadScreens(Number(lookaheadInput.value)));
  searchDepthInput?.addEventListener('input', () => applySearchLimits({ maxStableDepth: Number(searchDepthInput.value) }));
  edgeBudgetInput?.addEventListener('input', () => applySearchLimits({ maxEdgeRollouts: Number(edgeBudgetInput.value) }));
  planBudgetInput?.addEventListener('input', () => applySearchLimits({ budgetMs: Number(planBudgetInput.value) }));
  syncPlannerExperimentControls();
}

function isOverlayParamKey(value: string): value is OverlayParamKey {
  return (OVERLAY_PARAM_KEYS as string[]).includes(value);
}

function syncOverlayParamControls(): void {
  for (const key of OVERLAY_PARAM_KEYS) {
    const input = overlayParamInputs.get(key);
    const output = overlayParamOutputs.get(key);
    if (input) input.value = String(overlayParams[key]);
    if (output) output.value = overlayParams[key].toFixed(OVERLAY_PARAM_PRECISION[key]);
  }
}

function redrawOverlayFromCache(): void {
  overlay?.draw(planner?.lastSegments() ?? []);
  refreshOverlayStats();
}

function generationWidthWeightsFromParams(): number[] {
  return [
    overlayParams.generationWeight1,
    overlayParams.generationWeight2,
    overlayParams.generationWeight3,
    0,
  ];
}

function applyGenerationWidthWeights(): void {
  overlay?.setGenerationWidthWeights(generationWidthWeightsFromParams());
  redrawOverlayFromCache();
}

function applyOverlayParam(key: OverlayParamKey, value: number): void {
  if (overlayParams[key] === value) return;
  overlayParams[key] = value;
  switch (key) {
    case 'lineageDecay':
      planner?.setLineage({ decay: value });
      schedulePolicyPreview();
      break;
    case 'lineageGamma':
      planner?.setLineage({ gamma: value });
      schedulePolicyPreview();
      break;
    case 'minSupportRank':
      overlay?.setMinSupportRank(value);
      redrawOverlayFromCache();
      break;
    case 'widthMin':
      overlay?.setWidthMin(value);
      redrawOverlayFromCache();
      break;
    case 'widthMax':
      overlay?.setWidthMax(value);
      redrawOverlayFromCache();
      break;
    case 'shareWidthScale':
      overlay?.setShareWidthScale(value);
      redrawOverlayFromCache();
      break;
    case 'generationWeight1':
    case 'generationWeight2':
    case 'generationWeight3':
      applyGenerationWidthWeights();
      break;
    case 'alphaMin':
      overlay?.setAlphaMin(value);
      redrawOverlayFromCache();
      break;
    case 'alphaMax':
      overlay?.setAlphaMax(value);
      redrawOverlayFromCache();
      break;
    case 'alphaGamma':
      overlay?.setAlphaGamma(value);
      redrawOverlayFromCache();
      break;
  }
  syncOverlayParamControls();
  refreshStats();
}

function colorToHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

function applyOverlayColor(color: number): void {
  overlayColor = color;
  overlay?.setColor(color);
  redrawOverlayFromCache();
  if (colorInput) colorInput.value = colorToHex(color);
  refreshStats();
}

function setupOverlayParamControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[data-overlay-key]').forEach((input) => {
    const rawKey = input.dataset.overlayKey;
    if (!rawKey || !isOverlayParamKey(rawKey)) return;
    const output = document.getElementById(`${input.id}-value`) as HTMLOutputElement | null;
    overlayParamInputs.set(rawKey, input);
    if (output) overlayParamOutputs.set(rawKey, output);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      applyOverlayParam(rawKey, value);
    });
  });

  colorInput?.addEventListener('input', () => {
    const raw = colorInput.value;
    if (!/^#[0-9a-f]{6}$/i.test(raw)) return;
    const num = parseInt(raw.slice(1), 16);
    if (Number.isFinite(num)) applyOverlayColor(num);
  });

  colorByGenerationInput?.addEventListener('change', () => {
    overlay?.setColorByGeneration(colorByGenerationInput.checked);
    redrawOverlayFromCache();
    refreshStats();
  });

  highlightChosenInput?.addEventListener('change', () => {
    overlay?.setHighlightChosenChain(highlightChosenInput.checked);
    redrawOverlayFromCache();
    refreshStats();
  });

  overlayReset?.addEventListener('click', () => {
    for (const key of OVERLAY_PARAM_KEYS) {
      applyOverlayParam(key, OVERLAY_PARAM_DEFAULTS[key]);
    }
    applyOverlayColor(OVERLAY_DEFAULTS.color);
    if (colorByGenerationInput) colorByGenerationInput.checked = false;
    overlay?.setColorByGeneration(false);
    if (highlightChosenInput) highlightChosenInput.checked = OVERLAY_DEFAULTS.highlightChosenChain;
    overlay?.setHighlightChosenChain(OVERLAY_DEFAULTS.highlightChosenChain);
    redrawOverlayFromCache();
    schedulePolicyPreview();
  });

  if (colorByGenerationInput) colorByGenerationInput.checked = false;
  overlay?.setColorByGeneration(false);
  if (highlightChosenInput) highlightChosenInput.checked = OVERLAY_DEFAULTS.highlightChosenChain;
  overlay?.setHighlightChosenChain(OVERLAY_DEFAULTS.highlightChosenChain);
  syncOverlayParamControls();
}

function recordPlanResult(result: PlanResult): void {
  lastPlanMs = result.stats.planMs;
  lastSegmentCount = result.segments.length;
  lastEdges = result.stats.edgesEvaluated;
  lastNodes = result.stats.stableNodesExpanded;
  lastPerceived = `${result.stats.perceivedWheels}w/${result.stats.perceivedPastilles}p`;
  overlay?.draw(result.segments);
  refreshOverlayStats();
}

function planAndRecordNextPress(): void {
  if (!planner) return;
  const { press, result } = planner.step();
  pendingPress = press;
  if (result) recordPlanResult(result);
}

function schedulePolicyPreview(): void {
  if (previewFrame !== null) return;
  previewFrame = window.requestAnimationFrame(() => {
    previewFrame = null;
    if (!game || !planner || game.ended || game.ending) return;
    planAndRecordNextPress();
    refreshStats();
  });
}

function refreshOverlayStats(): void {
  const drawn = overlay?.lastDrawnStats();
  lastShownSegments = drawn?.segments ?? 0;
  lastShownEdges = drawn?.edges ?? 0;
  lastCulledEdges = drawn?.culledEdges ?? 0;
  if (drawn && (drawn.edges > 0 || drawn.culledEdges > 0)) {
    const span = drawn.bestSupport - drawn.worstSupport;
    lastSupportRange = `${drawn.bestSupport.toFixed(2)} (med ${drawn.medianSupport.toFixed(2)}, Δ ${span.toFixed(2)})`;
  } else {
    lastSupportRange = '—';
  }
}

function statItem(label: string, value: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'stat';

  const labelEl = document.createElement('span');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'stat-value';
  valueEl.textContent = value;

  item.append(labelEl, valueEl);
  return item;
}

function refreshStats(): void {
  if (!stats || !game) return;
  const heightMeters = Math.floor(game.maxHeight * 0.2);
  stats.replaceChildren(
    statItem('AI', aiActive ? 'on' : 'off'),
    statItem('Game', isPaused ? 'paused' : 'running'),
    statItem('Overlay', overlay?.getMode() ?? 'off'),
    statItem('Height', `${heightMeters}m`),
    statItem('Score', String(game.score)),
    statItem('Last plan', `${lastPlanMs.toFixed(1)}ms`),
    statItem('Candidates', `${lastSegmentCount} seg`),
    statItem('Search', `${lastEdges} edges`),
    statItem('Tree', `${lastNodes} nodes`),
    statItem('Visible', lastPerceived),
    statItem('Lookahead', `${lookaheadScreens.toFixed(2)}x`),
    statItem('Depth', `${searchLimits.maxStableDepth} jumps`),
    statItem('Budget', `${searchLimits.maxEdgeRollouts}e/${searchLimits.budgetMs.toFixed(0)}ms`),
    statItem('Shown', `${lastShownSegments} seg / ${lastShownEdges} edges`),
    statItem('Culled', `${lastCulledEdges} edges`),
    statItem('Support', lastSupportRange),
  );
}

function attachAI(g: InterwheelGame): void {
  // Wrap reset so any reset (initial mount, death-respawn, manual reseed)
  // honors the current seed. Without this, the seeded RNG would only apply to
  // the first reset() call.
  const originalReset = g.reset.bind(g);
  g.reset = (() => {
    if (currentSeed === null) {
      originalReset();
      return;
    }
    const savedRandom = Math.random;
    Math.random = makeSeededRng(currentSeed);
    try {
      originalReset();
    } finally {
      Math.random = savedRandom;
    }
  }) as typeof g.reset;

  planner = new InterwheelPlanner(g.sim, {
    policy,
    revealScreensAbove: lookaheadScreens,
    budgetMs: searchLimits.budgetMs,
    maxEdgeRollouts: searchLimits.maxEdgeRollouts,
    maxStableDepth: searchLimits.maxStableDepth,
  });
  overlay = new TrajectoryOverlay(g.world);
  (window as unknown as { __planner__: InterwheelPlanner }).__planner__ = planner;
  (window as unknown as { __overlay__: TrajectoryOverlay }).__overlay__ = overlay;
  planAndRecordNextPress();

  const originalUpdate = g.update.bind(g);
  let wasEnded = g.ended || g.ending;
  g.update = (() => {
    if (isPaused && !g.ended && !g.ending) return;
    if (aiActive && !g.ended && !g.ending && planner) {
      const press = pendingPress ?? false;
      pendingPress = null;
      // Only set the flag — checkPress() consumes by resetting to false, and
      // we mustn't clobber a player tap when AI is off.
      if (press) g.spacePressed = true;
    }
    originalUpdate();
    const isEnded = g.ended || g.ending;
    if (isEnded && !wasEnded) {
      planner?.invalidate();
      planner?.setPolicy(policy);
      overlay?.draw([]);
      refreshOverlayStats();
    }
    wasEnded = isEnded;
    if (aiActive && !isEnded && planner) {
      planAndRecordNextPress();
    }
    refreshStats();
  }) as typeof g.update;
}

const pauseButton = document.getElementById('game-pause') as HTMLButtonElement | null;
const seedInput = document.getElementById('game-seed') as HTMLInputElement | null;
const reseedButton = document.getElementById('game-reseed') as HTMLButtonElement | null;
let currentSeed: number | null = null;

function setPaused(p: boolean): void {
  isPaused = p;
  if (pauseButton) pauseButton.textContent = isPaused ? 'Resume' : 'Pause';
  refreshStats();
}

pauseButton?.addEventListener('click', () => setPaused(!isPaused));

// Read ?seed=... from the URL on load so a particular scene URL is shareable.
function readSeedFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readSeedFromInput(): number | null {
  if (!seedInput) return null;
  const raw = seedInput.value.trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function reseedGame(): void {
  if (!game) return;
  currentSeed = readSeedFromInput();
  // Re-applying the seed counts as a fresh scene; clear planner memory.
  planner?.invalidate();
  game.reset();
  pendingPress = null;
  overlay?.draw([]);
  refreshOverlayStats();
  refreshStats();
}

reseedButton?.addEventListener('click', reseedGame);
seedInput?.addEventListener('change', () => { currentSeed = readSeedFromInput(); });

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyA') {
    aiActive = !aiActive;
    if (!aiActive) {
      pendingPress = null;
      overlay?.draw([]);
      refreshOverlayStats();
    }
    refreshStats();
  } else if (e.code === 'KeyD') {
    overlay?.toggle();
    overlay?.draw(planner?.lastSegments() ?? []);
    refreshOverlayStats();
    refreshStats();
  } else if (e.code === 'KeyP') {
    setPaused(!isPaused);
  } else if (e.code === 'KeyR') {
    location.reload();
  }
});

// Apply ?seed=... before mount so the very first scene (built in the game's
// constructor) is reproducible. Subsequent resets honor the input field via
// the wrapper installed in attachAI.
const urlSeed = readSeedFromUrl();
if (urlSeed !== null) {
  currentSeed = urlSeed;
  if (seedInput) seedInput.value = String(urlSeed);
}

const savedRandomForMount = Math.random;
if (currentSeed !== null) Math.random = makeSeededRng(currentSeed);

mount(stage as HTMLElement, {
  host: noopGameHost,
  onReady: (g) => {
    Math.random = savedRandomForMount;
    game = g as InterwheelGame;
    (window as unknown as { __game__: InterwheelGame }).__game__ = game;
    attachAI(game);
    setupPolicyControls();
    setupPlannerExperimentControls();
    setupOverlayParamControls();
    refreshStats();
  },
}).catch((err) => {
  console.error('Failed to mount Interwheel:', err);
});
