import { mount, type InterwheelGame } from '../games/interwheel/index';
import { noopGameHost } from '../games/types';
import { InterwheelPlanner } from './interwheel-planner';
import { TrajectoryOverlay } from './trajectory-overlay';

const stage = document.getElementById('stage');
const stats = document.getElementById('stats');
if (!stage) throw new Error('missing #stage');

let game: InterwheelGame | null = null;
let planner: InterwheelPlanner | null = null;
let overlay: TrajectoryOverlay | null = null;
let aiActive = true;
let lastPlanMs = 0;
let lastSegmentCount = 0;

function refreshStats(): void {
  if (!stats || !game) return;
  const heightMeters = Math.floor(game.maxHeight * 0.2);
  stats.textContent = [
    `AI:        ${aiActive ? 'on ' : 'off'}    [A] toggle`,
    `Overlay:   ${overlay?.isVisible() ? 'on ' : 'off'}    [D] toggle`,
    `Height:    ${heightMeters}m`,
    `Score:     ${game.score}`,
    `Last plan: ${lastPlanMs.toFixed(1)}ms / ${lastSegmentCount} segments`,
  ].join('\n');
}

function attachAI(g: InterwheelGame): void {
  planner = new InterwheelPlanner(g.sim);
  overlay = new TrajectoryOverlay(g.world);

  // Wrap the game's update so we can inject AI presses on the same call —
  // this naturally lines up 1:1 with each game tick (the existing accumulator
  // ticker calls update() exactly once per game tick).
  const originalUpdate = g.update.bind(g);
  g.update = (() => {
    if (aiActive && !g.ended && !g.ending && planner) {
      const t0 = performance.now();
      const { press, result } = planner.step();
      if (result) {
        lastPlanMs = performance.now() - t0;
        lastSegmentCount = result.segments.length;
        overlay?.draw(result.segments);
      }
      // Only set the flag — checkPress() consumes by resetting to false, and
      // we mustn't clobber a player tap when AI is off.
      if (press) g.spacePressed = true;
    }
    originalUpdate();
    refreshStats();
  }) as typeof g.update;

  // Force a replan whenever a run ends (so the next attempt starts fresh).
  const watchEnded = () => {
    if (g.ended || g.ending) {
      planner?.invalidate();
      overlay?.draw([]);
    }
    requestAnimationFrame(watchEnded);
  };
  requestAnimationFrame(watchEnded);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyA') {
    aiActive = !aiActive;
    if (!aiActive) overlay?.draw([]);
    refreshStats();
  } else if (e.code === 'KeyD') {
    overlay?.toggle();
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
    refreshStats();
  },
}).catch((err) => {
  console.error('Failed to mount Interwheel:', err);
});
