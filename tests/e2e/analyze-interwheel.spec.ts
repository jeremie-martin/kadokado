import { expect, test } from '@playwright/test';

// Faithful headless analytics: same AI as the live playground, only Pixi
// rendering and particle animation are skipped. We *first* assert parity
// (same start state + same press sequence → identical end state with
// rendering on vs off) so we know the harness is trustworthy, *then* run one
// short deterministic analytics sample.
test('analytics harness is faithful to live game and records movement stats', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto('/analyze-interwheel.html');
  await page.waitForFunction(() => Boolean((window as { __interwheelAnalytics__?: unknown }).__interwheelAnalytics__), null, {
    timeout: 15000,
  });

  // 1. Parity — render off vs render on, same inputs, identical outcome.
  const parity = await page.evaluate(async () => {
    const w = window as unknown as {
      __interwheelAnalytics__: { parityCheck: (maxTicks?: number) => Promise<{
        headless: { score: number; height: number; ticks: number };
        full: { score: number; height: number; ticks: number };
        equal: boolean;
        firstDivergence?: { tick: number; headless: unknown; full: unknown };
      }> };
    };
    return await w.__interwheelAnalytics__.parityCheck(1200);
  });
  // eslint-disable-next-line no-console
  console.log(`PARITY: headless=${JSON.stringify(parity.headless)} full=${JSON.stringify(parity.full)} equal=${parity.equal}`);
  if (parity.firstDivergence) {
    // eslint-disable-next-line no-console
    console.log(`FIRST_DIVERGENCE: ${JSON.stringify(parity.firstDivergence, null, 2)}`);
  }
  // eslint-disable-next-line no-console
  console.log('STATS_TEXT:\n' + (await page.evaluate(() => document.getElementById('out')?.textContent ?? '')));
  expect(parity.equal, `headless must reproduce live gameplay exactly. firstDivergence=${JSON.stringify(parity.firstDivergence)}`).toBe(true);

  // 2. Analytics sample - production planner config, deterministic level.
  const wallStart = Date.now();
  type Trial = {
    score: number;
    heightMeters: number;
    ticks: number;
    cpuMs: number;
    uniquePerceivedPastilles: number;
    analytics: {
      summary: {
        jumps: number;
        wheelStays: number;
        pastilles: number;
        sparks: number;
        bonusScore: number;
        actionsPerMinute: {
          jumpsPerMinute: number;
          pressesPerMinute: number;
          pastillesPerMinute: number;
          sparksPerMinute: number;
          bonusScorePerMinute: number;
        };
        phaseTime: { wheelPercent: number; flightPercent: number; wallPercent: number; classifiedPercent: number };
        wheelStayRevolutions: { count: number; median: number; p95: number; max: number };
        planner: {
          plans: number;
          planMs: { count: number; p95: number; max: number };
          bestScoreBreakdown: {
            total: { count: number; mean: number };
            climb: { count: number; mean: number };
            thoroughness: { count: number; mean: number };
            pace: { count: number; mean: number };
          };
        };
      };
      events: {
        jumps: unknown[];
        wheelStays: unknown[];
        wallDrifts: unknown[];
        flights: unknown[];
        pastilles: unknown[];
        sparks: unknown[];
      };
    };
  };
  const result: { trials: Trial[]; stats: { height_m: { p95: number } } } =
    await page.evaluate(async () => {
      const w = window as unknown as {
        __interwheelAnalytics__: {
          runAnalyze: (opts: { trials: number; seedBase: number; maxTicks: number }) => Promise<{
            trials: Trial[];
            stats: { height_m: { p95: number } };
          }>;
        };
      };
      return await w.__interwheelAnalytics__.runAnalyze({ trials: 1, seedBase: 42, maxTicks: 1200 });
    });
  const results = result.trials;
  const wallMs = Date.now() - wallStart;

  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  const heights = results.map((r) => r.heightMeters).sort((a, b) => a - b);
  const cpuTotal = results.reduce((s, r) => s + r.cpuMs, 0);
  const median = (a: number[]) => a[Math.floor(a.length / 2)];
  const p10 = (a: number[]) => a[Math.floor(a.length * 0.1)];
  const p90 = (a: number[]) => a[Math.floor(a.length * 0.9)];
  const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  // eslint-disable-next-line no-console
  console.log(`\n=== ANALYTICS (${results.length} trial, ${(wallMs / 1000).toFixed(1)}s wall, ${(cpuTotal / 1000).toFixed(1)}s CPU) ===`);
  // eslint-disable-next-line no-console
  console.log(
    `score:    p10=${p10(scores)}  median=${median(scores)}  p90=${p90(scores)}  max=${scores[scores.length - 1]}  mean=${Math.round(meanScore)}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `height_m: p10=${p10(heights)}  median=${median(heights)}  p90=${p90(heights)}  max=${heights[heights.length - 1]}`,
  );

  expect(consoleErrors, `errors: ${consoleErrors.join('\n')}`).toEqual([]);
  expect(results).toHaveLength(1);
  expect(scores[scores.length - 1]).toBeGreaterThan(0);
  expect(result.stats.height_m.p95).toBeGreaterThanOrEqual(results[0].heightMeters);
  expect(results[0].analytics.summary.jumps).toBe(results[0].analytics.events.jumps.length);
  expect(results[0].analytics.summary.wheelStays).toBe(results[0].analytics.events.wheelStays.length);
  expect(results[0].analytics.summary.wheelStayRevolutions.count).toBe(results[0].analytics.events.wheelStays.length);
  expect(results[0].analytics.summary.actionsPerMinute.jumpsPerMinute).toBeGreaterThan(0);
  expect(results[0].analytics.summary.actionsPerMinute.pressesPerMinute).toBeGreaterThan(0);
  expect(results[0].analytics.summary.pastilles).toBe(results[0].analytics.events.pastilles.length);
  expect(results[0].analytics.summary.sparks).toBe(results[0].analytics.events.sparks.length);
  expect(results[0].analytics.summary.bonusScore).toBeGreaterThanOrEqual(0);
  expect(results[0].analytics.summary.actionsPerMinute.bonusScorePerMinute).toBeGreaterThanOrEqual(0);
  expect(results[0].analytics.summary.phaseTime.classifiedPercent).toBeGreaterThan(90);
  expect(results[0].analytics.summary.planner.plans).toBeGreaterThan(0);
  expect(results[0].analytics.summary.planner.planMs.p95).toBeGreaterThanOrEqual(0);
  expect(results[0].analytics.summary.planner.bestScoreBreakdown.total.count).toBe(results[0].analytics.summary.planner.plans);
  expect(results[0].analytics.summary.planner.bestScoreBreakdown.climb.mean).toBeGreaterThan(0);
  expect(results[0].analytics.summary.planner.bestScoreBreakdown.pace.mean).toBeGreaterThanOrEqual(0);

  const noPastilles = await page.evaluate(async () => {
    const w = window as unknown as {
      __interwheelAnalytics__: {
        setPastilleSpawnChanceOverride: (value: number | null) => void;
        runAnalyze: (opts: {
          trials: number;
          seedBase: number;
          maxTicks: number;
          policy?: { thoroughness?: number };
        }) => Promise<{ trials: Trial[] }>;
      };
    };
    w.__interwheelAnalytics__.setPastilleSpawnChanceOverride(0);
    try {
      return await w.__interwheelAnalytics__.runAnalyze({
        trials: 1,
        seedBase: 42,
        maxTicks: 300,
        policy: { thoroughness: 4 },
      });
    } finally {
      w.__interwheelAnalytics__.setPastilleSpawnChanceOverride(null);
    }
  });
  expect(noPastilles.trials[0].uniquePerceivedPastilles).toBe(0);
  expect(noPastilles.trials[0].analytics.summary.pastilles).toBe(0);
  expect(noPastilles.trials[0].analytics.summary.planner.bestScoreBreakdown.thoroughness.mean).toBe(0);

  const replayEquivalence = await page.evaluate(async () => {
    const w = window as unknown as {
      __interwheelAnalytics__: {
        comparePureReplay: (seed: number, maxTicks: number) => Promise<{
          equal: boolean;
          firstDivergence?: { tick: number; path: string; mounted: unknown; pure: unknown };
          mounted: { sampleCount: number; final: { score: number; heightMeters: number; ticks: number } };
          pure: { sampleCount: number; final: { score: number; heightMeters: number; ticks: number } };
        }>;
      };
    };
    return await w.__interwheelAnalytics__.comparePureReplay(42, 1200);
  });
  expect(
    replayEquivalence.equal,
    `pure sim replay must match mounted headless transcript. firstDivergence=${JSON.stringify(replayEquivalence.firstDivergence)}`,
  ).toBe(true);
  expect(replayEquivalence.pure.final).toEqual(replayEquivalence.mounted.final);
});
