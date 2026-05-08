import { mount, type InterwheelGame } from '../games/interwheel/index';
import { noopGameHost } from '../games/types';
import {
  DEFAULT_PLANNER_POLICY,
  InterwheelPlanner,
  LINEAGE_DEFAULTS,
  OBJECTIVE_DEFAULTS,
  type ObjectiveFlags,
  type PlannerPolicy,
  type PlanResult,
} from './interwheel-planner';
import { OVERLAY_DEFAULTS, TrajectoryOverlay } from './trajectory-overlay';

const stage = document.getElementById('stage');
const stats = document.getElementById('stats');
if (!stage) throw new Error('missing #stage');

type PolicyKey = keyof PlannerPolicy;

const POLICY_KEYS: PolicyKey[] = ['climb', 'collectibles', 'wallRoutes', 'pace'];
const policyInputs = new Map<PolicyKey, HTMLInputElement>();
const policyOutputs = new Map<PolicyKey, HTMLOutputElement>();
const policyReset = document.getElementById('policy-reset') as HTMLButtonElement | null;
const focusInput = document.getElementById('policy-focus') as HTMLInputElement | null;
const focusOutput = document.getElementById('policy-focus-value') as HTMLOutputElement | null;
// Focus lerps climb and collectibles in opposite directions: focus=0 is pure
// climber (max climb, no collect), focus=1 is pure collector (min climb, max
// collect). Endpoints align with the existing slider ranges in playground.html.
const FOCUS_CLIMB_MAX = 1.6;
const FOCUS_CLIMB_MIN = 0.3;
const FOCUS_COLLECT_MAX = 3;

// Renderer params trigger a redraw of the cached segments; planner params
// (lineageGamma, lineageDecay) require a re-plan to recompute support.
const OVERLAY_PARAM_DEFAULTS = {
  lineageDecay: LINEAGE_DEFAULTS.decay,
  lineageGamma: LINEAGE_DEFAULTS.gamma,
  alphaGamma: OVERLAY_DEFAULTS.alphaGamma,
  minDrawAlpha: OVERLAY_DEFAULTS.minDrawAlpha,
  widthMin: OVERLAY_DEFAULTS.widthMin,
  widthMax: OVERLAY_DEFAULTS.widthMax,
};
type OverlayParamKey = keyof typeof OVERLAY_PARAM_DEFAULTS;
const OVERLAY_PARAM_KEYS = Object.keys(OVERLAY_PARAM_DEFAULTS) as OverlayParamKey[];
const OVERLAY_PARAM_PRECISION: Record<OverlayParamKey, number> = {
  lineageDecay: 2,
  lineageGamma: 1,
  alphaGamma: 1,
  minDrawAlpha: 2,
  widthMin: 2,
  widthMax: 1,
};
const overlayParamInputs = new Map<OverlayParamKey, HTMLInputElement>();
const overlayParamOutputs = new Map<OverlayParamKey, HTMLOutputElement>();
const overlayReset = document.getElementById('overlay-reset') as HTMLButtonElement | null;
const colorInput = document.getElementById('overlay-color') as HTMLInputElement | null;
const colorByGenerationInput = document.getElementById('overlay-colorByGeneration') as HTMLInputElement | null;
let overlayParams: Record<OverlayParamKey, number> = { ...OVERLAY_PARAM_DEFAULTS };
let overlayColor: number = OVERLAY_DEFAULTS.color;

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
let lastBuckets = '0/0/0';
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
  // Focus reflects collectibles position on the lerp; climb may drift off the
  // line if user adjusts it directly, that's OK — focus is a fast-path preset.
  if (focusInput || focusOutput) {
    const focus = Math.max(0, Math.min(1, policy.collectibles / FOCUS_COLLECT_MAX));
    if (focusInput) focusInput.value = String(focus);
    if (focusOutput) focusOutput.value = focus.toFixed(2);
  }
}

function policyFromFocus(focus: number, base: PlannerPolicy): PlannerPolicy {
  const f = Math.max(0, Math.min(1, focus));
  return {
    ...base,
    climb: FOCUS_CLIMB_MAX - (FOCUS_CLIMB_MAX - FOCUS_CLIMB_MIN) * f,
    collectibles: FOCUS_COLLECT_MAX * f,
  };
}

function readPolicyControls(): PlannerPolicy {
  // Start from current policy so keys without a UI input (e.g. climb,
  // collectibles when only the Focus slider is shown) retain their values.
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

  focusInput?.addEventListener('input', () => {
    const focus = Number(focusInput.value);
    if (!Number.isFinite(focus)) return;
    applyPolicy(policyFromFocus(focus, policy));
  });

  policyReset?.addEventListener('click', () => applyPolicy({ ...DEFAULT_PLANNER_POLICY }));
  syncPolicyControls();
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

function applyOverlayParam(key: OverlayParamKey, value: number): void {
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
    case 'alphaGamma':
      overlay?.setAlphaGamma(value);
      overlay?.draw(planner?.lastSegments() ?? []);
      refreshOverlayStats();
      break;
    case 'minDrawAlpha':
      overlay?.setMinDrawAlpha(value);
      overlay?.draw(planner?.lastSegments() ?? []);
      refreshOverlayStats();
      break;
    case 'widthMin':
      overlay?.setWidthMin(value);
      overlay?.draw(planner?.lastSegments() ?? []);
      refreshOverlayStats();
      break;
    case 'widthMax':
      overlay?.setWidthMax(value);
      overlay?.draw(planner?.lastSegments() ?? []);
      refreshOverlayStats();
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
  overlay?.draw(planner?.lastSegments() ?? []);
  refreshOverlayStats();
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
    overlay?.draw(planner?.lastSegments() ?? []);
    refreshOverlayStats();
    refreshStats();
  });

  overlayReset?.addEventListener('click', () => {
    for (const key of OVERLAY_PARAM_KEYS) {
      applyOverlayParam(key, OVERLAY_PARAM_DEFAULTS[key]);
    }
    applyOverlayColor(OVERLAY_DEFAULTS.color);
  });

  // Push current values into the planner/overlay so HTML defaults that
  // diverge from code defaults take effect immediately.
  for (const key of OVERLAY_PARAM_KEYS) {
    applyOverlayParam(key, overlayParams[key]);
  }
  applyOverlayColor(overlayColor);
  syncOverlayParamControls();
}

const OBJECTIVE_KEYS = Object.keys(OBJECTIVE_DEFAULTS) as (keyof ObjectiveFlags)[];
let objectiveFlags: ObjectiveFlags = { ...OBJECTIVE_DEFAULTS };

function isObjectiveKey(value: string): value is keyof ObjectiveFlags {
  return (OBJECTIVE_KEYS as string[]).includes(value);
}

function applyObjectiveFlag(key: keyof ObjectiveFlags, value: boolean): void {
  objectiveFlags = { ...objectiveFlags, [key]: value };
  planner?.setObjectiveFlags({ [key]: value });
  schedulePolicyPreview();
  refreshStats();
}

function setupObjectiveControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[data-objective-flag]').forEach((input) => {
    const rawKey = input.dataset.objectiveFlag;
    if (!rawKey || !isObjectiveKey(rawKey)) return;
    input.checked = objectiveFlags[rawKey];
    input.addEventListener('change', () => applyObjectiveFlag(rawKey, input.checked));
  });
  // Push current state into planner so toggles default to OFF coherently.
  planner?.setObjectiveFlags(objectiveFlags);
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
  if (drawn && drawn.edges > 0) {
    const { hi, mid, lo } = drawn.alphaBuckets;
    lastBuckets = `${hi}/${mid}/${lo}`;
    const span = drawn.bestSupport - drawn.worstSupport;
    lastSupportRange = `${drawn.bestSupport.toFixed(2)} (med ${drawn.medianSupport.toFixed(2)}, Δ ${span.toFixed(2)})`;
  } else {
    lastBuckets = '0/0/0';
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
    statItem('Shown', `${lastShownSegments} seg / ${lastShownEdges} edges`),
    statItem('α buckets', lastBuckets),
    statItem('Support', lastSupportRange),
  );
}

function attachAI(g: InterwheelGame): void {
  planner = new InterwheelPlanner(g.sim, { policy });
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

function setPaused(p: boolean): void {
  isPaused = p;
  if (pauseButton) pauseButton.textContent = isPaused ? 'Resume' : 'Pause';
  refreshStats();
}

pauseButton?.addEventListener('click', () => setPaused(!isPaused));

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

mount(stage as HTMLElement, {
  host: noopGameHost,
  onReady: (g) => {
    game = g as InterwheelGame;
    (window as unknown as { __game__: InterwheelGame }).__game__ = game;
    attachAI(game);
    setupPolicyControls();
    setupObjectiveControls();
    setupOverlayParamControls();
    refreshStats();
  },
}).catch((err) => {
  console.error('Failed to mount Interwheel:', err);
});
