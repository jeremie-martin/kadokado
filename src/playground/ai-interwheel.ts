import { mount, type InterwheelGame } from '../games/interwheel/index';
import { noopGameHost } from '../games/types';
import { DEFAULT_PLANNER_POLICY, InterwheelPlanner, type PlannerPolicy, type PlanResult } from './interwheel-planner';
import { TrajectoryOverlay } from './trajectory-overlay';

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
  const next: PlannerPolicy = { ...DEFAULT_PLANNER_POLICY };
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

function recordPlanResult(result: PlanResult): void {
  lastPlanMs = result.stats.planMs;
  lastSegmentCount = result.segments.length;
  lastEdges = result.stats.edgesEvaluated;
  lastNodes = result.stats.stableNodesExpanded;
  lastPerceived = `${result.stats.perceivedWheels}w/${result.stats.perceivedPastilles}p`;
  overlay?.draw(result.segments);
  refreshOverlayStats();
}

function schedulePolicyPreview(): void {
  if (previewFrame !== null) return;
  previewFrame = window.requestAnimationFrame(() => {
    previewFrame = null;
    if (!game || !planner || game.ended || game.ending) return;
    const { result } = planner.step();
    if (result) recordPlanResult(result);
    refreshStats();
  });
}

function refreshOverlayStats(): void {
  const drawn = overlay?.lastDrawnStats();
  lastShownSegments = drawn?.segments ?? 0;
  lastShownEdges = drawn?.edges ?? 0;
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
    statItem('Overlay', overlay?.getMode() ?? 'off'),
    statItem('Height', `${heightMeters}m`),
    statItem('Score', String(game.score)),
    statItem('Last plan', `${lastPlanMs.toFixed(1)}ms`),
    statItem('Candidates', `${lastSegmentCount} seg`),
    statItem('Search', `${lastEdges} edges`),
    statItem('Tree', `${lastNodes} nodes`),
    statItem('Visible', lastPerceived),
    statItem('Shown', `${lastShownSegments} seg / ${lastShownEdges} edges`),
  );
}

function attachAI(g: InterwheelGame): void {
  planner = new InterwheelPlanner(g.sim, { policy });
  overlay = new TrajectoryOverlay(g.world);
  (window as unknown as { __planner__: InterwheelPlanner }).__planner__ = planner;

  const originalUpdate = g.update.bind(g);
  let wasEnded = g.ended || g.ending;
  g.update = (() => {
    if (aiActive && !g.ended && !g.ending && planner) {
      const { press, result } = planner.step();
      if (result) recordPlanResult(result);
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
    refreshStats();
  }) as typeof g.update;
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyA') {
    aiActive = !aiActive;
    if (!aiActive) {
      overlay?.draw([]);
      refreshOverlayStats();
    }
    refreshStats();
  } else if (e.code === 'KeyD') {
    overlay?.toggle();
    overlay?.draw(planner?.lastSegments() ?? []);
    refreshOverlayStats();
    refreshStats();
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
    refreshStats();
  },
}).catch((err) => {
  console.error('Failed to mount Interwheel:', err);
});
