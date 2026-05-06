import { expect, test } from '@playwright/test';

// Faithful headless bench: same AI as the live playground, only Pixi
// rendering and particle animation are skipped. We *first* assert parity
// (same start state + same press sequence → identical end state with
// rendering on vs off) so we know the bench is trustworthy, *then* run
// trials.
test('bench is faithful to live game and runs many trials', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto('/bench.html');
  await page.waitForFunction(() => Boolean((window as { __bench__?: unknown }).__bench__), null, {
    timeout: 15000,
  });

  // 1. Parity — render off vs render on, same inputs, identical outcome.
  const parity = await page.evaluate(async () => {
    const w = window as unknown as {
      __bench__: { parityCheck: () => Promise<{
        bench: { score: number; height: number; ticks: number };
        full: { score: number; height: number; ticks: number };
        equal: boolean;
        firstDivergence?: { tick: number; bench: unknown; full: unknown };
      }> };
    };
    return await w.__bench__.parityCheck();
  });
  // eslint-disable-next-line no-console
  console.log(`PARITY: bench=${JSON.stringify(parity.bench)} full=${JSON.stringify(parity.full)} equal=${parity.equal}`);
  if (parity.firstDivergence) {
    // eslint-disable-next-line no-console
    console.log(`FIRST_DIVERGENCE: ${JSON.stringify(parity.firstDivergence, null, 2)}`);
  }
  // eslint-disable-next-line no-console
  console.log('STATS_TEXT:\n' + (await page.evaluate(() => document.getElementById('out')?.textContent ?? '')));
  expect(parity.equal, `bench must reproduce live gameplay exactly. firstDivergence=${JSON.stringify(parity.firstDivergence)}`).toBe(true);

  // 2. Trials — production planner config, no shortcuts.
  const N = 20;
  const wallStart = Date.now();
  const results: Array<{ score: number; heightMeters: number; ticks: number; cpuMs: number }> =
    await page.evaluate(async (n) => {
      const w = window as unknown as {
        __bench__: {
          runTrial: () => Promise<{ score: number; heightMeters: number; ticks: number; cpuMs: number }>;
        };
      };
      const out: Array<{ score: number; heightMeters: number; ticks: number; cpuMs: number }> = [];
      for (let i = 0; i < n; i += 1) out.push(await w.__bench__.runTrial());
      return out;
    }, N);
  const wallMs = Date.now() - wallStart;

  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  const heights = results.map((r) => r.heightMeters).sort((a, b) => a - b);
  const cpuTotal = results.reduce((s, r) => s + r.cpuMs, 0);
  const median = (a: number[]) => a[Math.floor(a.length / 2)];
  const p10 = (a: number[]) => a[Math.floor(a.length * 0.1)];
  const p90 = (a: number[]) => a[Math.floor(a.length * 0.9)];
  const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  // eslint-disable-next-line no-console
  console.log(`\n=== BENCH (${N} trials, ${(wallMs / 1000).toFixed(1)}s wall, ${(cpuTotal / 1000).toFixed(1)}s CPU) ===`);
  // eslint-disable-next-line no-console
  console.log(
    `score:    p10=${p10(scores)}  median=${median(scores)}  p90=${p90(scores)}  max=${scores[scores.length - 1]}  mean=${Math.round(meanScore)}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `height_m: p10=${p10(heights)}  median=${median(heights)}  p90=${p90(heights)}  max=${heights[heights.length - 1]}`,
  );

  expect(consoleErrors, `errors: ${consoleErrors.join('\n')}`).toEqual([]);
  expect(results).toHaveLength(N);
  expect(scores[scores.length - 1]).toBeGreaterThan(0);
});
