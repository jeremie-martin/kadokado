import { expect, test } from '@playwright/test';

test.describe('AI playground', () => {
  test('mounts Interwheel, runs the planner, and draws candidate trajectories', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto('/playground.html');

    // Wait for the InterwheelGame to attach to window via onReady.
    await page.waitForFunction(() => Boolean((window as { __game__?: unknown }).__game__), null, {
      timeout: 15000,
    });

    // Let the AI ticks roll for a moment.
    await page.waitForTimeout(2000);

    const probe = await page.evaluate(() => {
      const w = window as unknown as {
        __game__: {
          tick: number;
          maxHeight: number;
          ended: boolean;
          ending: boolean;
          wheels: Array<unknown>;
        };
      };
      return {
        tick: w.__game__.tick,
        maxHeight: w.__game__.maxHeight,
        wheels: w.__game__.wheels.length,
        ended: w.__game__.ended,
        ending: w.__game__.ending,
        statsText: document.getElementById('stats')?.textContent ?? '',
      };
    });

    expect(probe.wheels).toBeGreaterThan(10);
    expect(probe.tick).toBeGreaterThan(20);
    // The AI should drive the blob upward.
    expect(probe.maxHeight).toBeGreaterThan(0);
    expect(probe.statsText).toContain('Last plan:');

    expect(pageErrors, `pageerror events: ${pageErrors.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console.error events: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
