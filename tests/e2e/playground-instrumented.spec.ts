import { expect, test } from '@playwright/test';
import path from 'node:path';

// Instrumented run: actually watch the AI play for ~10s, sample the live state,
// count presses and plan calls, verify determinism, and snapshot the overlay.
test('AI agent observably plays Interwheel', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/playground.html');

  await page.waitForFunction(() => Boolean((window as { __game__?: unknown }).__game__), null, {
    timeout: 15000,
  });

  // Wrap game.update so we can count live ticks + observe blob state. We
  // can't easily count "presses issued by AI" without coupling to
  // planner internals, so we measure tick rate, blob state, and deaths
  // — enough to assert the AI is genuinely playing.
  await page.evaluate(() => {
    const w = window as unknown as {
      __game__: { update(): void; blob: { state: number } };
      __probe__: {
        liveTicks: number;
        stateCounts: Record<number, number>;
        deaths: number;
      };
    };

    w.__probe__ = { liveTicks: 0, stateCounts: {}, deaths: 0 };

    let prevState = w.__game__.blob.state;
    const origUpdate = w.__game__.update.bind(w.__game__);
    w.__game__.update = () => {
      origUpdate();
      w.__probe__.liveTicks += 1;
      const s = w.__game__.blob.state;
      w.__probe__.stateCounts[s] = (w.__probe__.stateCounts[s] || 0) + 1;
      if (s === 4 && prevState !== 4) w.__probe__.deaths += 1;
      prevState = s;
    };
  });

  // Sample maxHeight every 500ms for 10s.
  type Sample = { t: number; tick: number; maxHeight: number; segments: number };
  const samples: Sample[] = [];
  const startMs = Date.now();
  const SAMPLE_INTERVAL = 500;
  const TOTAL_MS = 10_000;

  while (Date.now() - startMs < TOTAL_MS) {
    await page.waitForTimeout(SAMPLE_INTERVAL);
    const s = await page.evaluate(() => {
      const w = window as unknown as {
        __game__: { tick: number; maxHeight: number };
      };
      const stats = document.getElementById('stats')?.textContent ?? '';
      // Extract segments count from the stats line.
      const m = stats.match(/(\d+) segments/);
      return {
        tick: w.__game__.tick,
        maxHeight: w.__game__.maxHeight,
        segments: m ? Number(m[1]) : 0,
      };
    });
    samples.push({
      t: Date.now() - startMs,
      tick: s.tick,
      maxHeight: s.maxHeight,
      segments: s.segments,
    });
  }

  const probe = await page.evaluate(() => {
    const w = window as unknown as {
      __probe__: {
        liveTicks: number;
        stateCounts: Record<number, number>;
        deaths: number;
      };
    };
    return w.__probe__;
  });

  // Determinism check: snapshot the live state, run 60 sim steps with a fixed
  // press sequence, capture end blob; restore and re-run; both must match.
  const determinism = await page.evaluate(() => {
    const w = window as unknown as {
      __game__: {
        sim: {
          clone: () => unknown;
          restore: (s: unknown) => void;
          step: (p: boolean, rng: () => number) => void;
          blob: { x: number; y: number; vx: number; vy: number; state: number };
        };
      };
    };
    const sim = w.__game__.sim;
    const snap = sim.clone();
    const constRng = () => 0.5;
    const seq: boolean[] = [];
    for (let i = 0; i < 60; i += 1) seq.push(i % 13 === 0);
    const run = () => {
      sim.restore(snap);
      for (const press of seq) sim.step(press, constRng);
      return { x: sim.blob.x, y: sim.blob.y, vx: sim.blob.vx, vy: sim.blob.vy, state: sim.blob.state };
    };
    const a = run();
    const b = run();
    sim.restore(snap);
    return { a, b, equal: JSON.stringify(a) === JSON.stringify(b) };
  });

  const finalSample = samples[samples.length - 1];
  const firstSample = samples[0];
  const climbed = finalSample.maxHeight - firstSample.maxHeight;
  const ticksPerSec = (finalSample.tick - firstSample.tick) / ((finalSample.t - firstSample.t) / 1000);

  // Take a screenshot of the playground for human review.
  await page.screenshot({
    path: path.resolve('.tmp/e2e/playground.png'),
    fullPage: false,
  });

  // Log it all to the test report — Playwright will print it via reporter=list.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    samples,
    probe,
    determinism,
    climbed,
    ticksPerSec,
  }, null, 2));

  // Hard expectations
  expect(pageErrors, `pageerror: ${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console.error: ${consoleErrors.join('\n')}`).toEqual([]);
  expect(determinism.equal, 'sim must be deterministic').toBe(true);

  // The game ticks at 40 Hz; verify we got close to that.
  expect(ticksPerSec).toBeGreaterThan(30);

  // The blob must climb. State 1=Fly, 2=Grab, 3=Wall, 4=Dead.
  // We don't require it to live the whole 10s — just that it climbed something.
  expect(climbed).toBeGreaterThan(20);
  // Must have spent some time in Fly state (= it actually jumped at all).
  expect(probe.stateCounts[1] ?? 0).toBeGreaterThan(20);
});
