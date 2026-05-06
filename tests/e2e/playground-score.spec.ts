import { expect, test } from '@playwright/test';

// Run several trials to a natural game-over (death or drown) and report the
// score distribution. Each trial caps at 120s of real time as a safety net.
test('AI score distribution', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);

  const TRIALS = 5;
  const MAX_TRIAL_MS = 120_000;
  const POLL_MS = 1_000;

  type Trial = {
    index: number;
    durationMs: number;
    ticks: number;
    score: number;
    heightMeters: number;
    ended: boolean;
    samples: Array<{ t: number; tick: number; height: number; score: number }>;
  };
  const results: Trial[] = [];

  for (let i = 0; i < TRIALS; i += 1) {
    await page.goto('/playground.html');
    await page.waitForFunction(() => Boolean((window as { __game__?: unknown }).__game__), null, {
      timeout: 15000,
    });

    const samples: Array<{ t: number; tick: number; height: number; score: number }> = [];
    const start = Date.now();

    while (Date.now() - start < MAX_TRIAL_MS) {
      await page.waitForTimeout(POLL_MS);
      const s = await page.evaluate(() => {
        const w = window as unknown as {
          __game__: { tick: number; maxHeight: number; score: number; ended: boolean; ending: boolean };
        };
        return {
          tick: w.__game__.tick,
          height: w.__game__.maxHeight,
          score: w.__game__.score,
          ended: w.__game__.ended,
          ending: w.__game__.ending,
        };
      });
      samples.push({ t: Date.now() - start, tick: s.tick, height: s.height, score: s.score });
      // eslint-disable-next-line no-console
      console.log(
        `trial ${i + 1}/${TRIALS} t=${(samples[samples.length - 1].t / 1000).toFixed(1)}s ` +
          `tick=${s.tick} height=${Math.floor(s.height * 0.2)}m score=${s.score} ` +
          `${s.ending ? '(ending)' : ''}${s.ended ? '(ended)' : ''}`,
      );
      if (s.ended) break;
    }

    const final = await page.evaluate(() => {
      const w = window as unknown as {
        __game__: { tick: number; maxHeight: number; score: number; ended: boolean };
      };
      return {
        tick: w.__game__.tick,
        height: w.__game__.maxHeight,
        score: w.__game__.score,
        ended: w.__game__.ended,
      };
    });

    results.push({
      index: i,
      durationMs: Date.now() - start,
      ticks: final.tick,
      score: final.score,
      heightMeters: Math.floor(final.height * 0.2),
      ended: final.ended,
      samples,
    });
  }

  const summary = results.map((r) => ({
    trial: r.index + 1,
    durationS: +(r.durationMs / 1000).toFixed(1),
    ticks: r.ticks,
    heightM: r.heightMeters,
    score: r.score,
    ended: r.ended,
  }));
  // eslint-disable-next-line no-console
  console.log('\n=== SCORE SUMMARY ===');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  const heights = results.map((r) => r.heightMeters).sort((a, b) => a - b);
  const median = (arr: number[]) => arr[Math.floor(arr.length / 2)];
  const sum = scores.reduce((a, b) => a + b, 0);
  // eslint-disable-next-line no-console
  console.log(
    `Scores: min=${scores[0]} median=${median(scores)} max=${scores[scores.length - 1]} mean=${Math.round(sum / scores.length)}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Heights (m): min=${heights[0]} median=${median(heights)} max=${heights[heights.length - 1]}`,
  );

  expect(scores[scores.length - 1]).toBeGreaterThan(0);
});
