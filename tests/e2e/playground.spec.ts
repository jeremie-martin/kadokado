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

    // Let the AI ticks roll without assuming a fixed local planner speed.
    await page.waitForFunction(
      () => ((window as { __game__?: { tick: number } }).__game__?.tick ?? 0) > 20,
      null,
      { timeout: 15000 },
    );

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
    expect(probe.statsText).toContain('Last plan');

    expect(pageErrors, `pageerror events: ${pageErrors.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console.error events: ${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('updates planner policy from live playground controls', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto('/playground.html');
    await page.waitForFunction(() => Boolean((window as { __game__?: unknown; __planner__?: unknown }).__game__ && (window as { __planner__?: unknown }).__planner__), null, {
      timeout: 15000,
    });

    await page.locator('#policy-wallRoutes').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '0.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#policy-wallRoutes-value')).toHaveText('0.50');

    const policy = await page.evaluate(() => {
      const w = window as unknown as {
        __planner__: { policy: () => { climb: number; collectibles: number; wallRoutes: number; pace: number } };
      };
      return w.__planner__.policy();
    });

    expect(policy).toMatchObject({ climb: 1, collectibles: 1, wallRoutes: 0.5, pace: 1 });
    await expect(page.locator('#stats')).not.toContainText('wall 0.50');

    await page.locator('#policy-reset').click();
    await expect(page.locator('#policy-wallRoutes-value')).toHaveText('0.00');

    const resetPolicy = await page.evaluate(() => {
      const w = window as unknown as {
        __planner__: { policy: () => { climb: number; collectibles: number; wallRoutes: number; pace: number } };
      };
      return w.__planner__.policy();
    });
    expect(resetPolicy).toMatchObject({ climb: 1, collectibles: 1, wallRoutes: 0, pace: 1 });

    await page.locator('#overlay-shareWidthScale').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '14';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#overlay-shareWidthScale-value')).toHaveText('14.0');

    await page.locator('#overlay-alphaMin').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '0.2';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#overlay-alphaMin-value')).toHaveText('0.20');

    expect(pageErrors, `pageerror events: ${pageErrors.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console.error events: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
