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

    await expect(page.locator('#policy-focus')).toHaveCount(0);
    await expect(page.locator('#policy-thoroughness')).toHaveCount(0);
    await expect(page.locator('#policy-pace')).toHaveCount(0);
    await expect(page.locator('#policy-detour')).toHaveCount(0);
    await expect(page.locator('#policy-patience')).toHaveCount(0);
    await expect(page.locator('#policy-wall-value')).toHaveText('0.50');
    await expect(page.locator('#planner-lookahead-value')).toHaveText('0.50');
    await expect(page.locator('#planner-searchDepth-value')).toHaveText('4');
    await expect(page.locator('#planner-edgeBudget-value')).toHaveText('360');
    await expect(page.locator('#planner-planBudgetMs-value')).toHaveText('5ms');
    await expect(page.locator('#overlay-lineageDecay-value')).toHaveText('0.65');
    await expect(page.locator('#overlay-lineageGamma-value')).toHaveText('4.0');
    await expect(page.locator('#overlay-lineageClaimAmp')).toHaveCount(0);
    await expect(page.locator('#objective-asymmetricYGain')).toHaveCount(0);
    await expect(page.locator('#overlay-minSupportRank-value')).toHaveText('0.70');
    await expect(page.locator('#overlay-widthMin-value')).toHaveText('0.30');
    await expect(page.locator('#overlay-widthMax-value')).toHaveText('7.0');
    await expect(page.locator('#overlay-shareWidthScale-value')).toHaveText('18.0');
    await expect(page.locator('#overlay-generationWeight1-value')).toHaveText('1.00');
    await expect(page.locator('#overlay-generationWeight2-value')).toHaveText('0.90');
    await expect(page.locator('#overlay-generationWeight3-value')).toHaveText('0.50');
    await expect(page.locator('#overlay-generationWeight4')).toHaveCount(0);
    await expect(page.locator('#overlay-alphaMin-value')).toHaveText('0.07');
    await expect(page.locator('#overlay-alphaMax-value')).toHaveText('0.90');
    await expect(page.locator('#overlay-alphaGamma-value')).toHaveText('4.0');
    await expect(page.locator('#overlay-color')).toHaveValue('#ff3333');
    await expect(page.locator('#overlay-highlightChosen')).not.toBeChecked();
    await page.waitForFunction(() => {
      const planner = (window as { __planner__?: { lastSegments: () => Array<{ generation: number }> } }).__planner__;
      return (planner?.lastSegments() ?? []).length > 0;
    });
    const defaultMaxGeneration = await page.evaluate(() => {
      const overlay = (window as { __overlay__: { lastDrawnStats: () => { maxGeneration: number } } }).__overlay__;
      return overlay.lastDrawnStats().maxGeneration;
    });
    expect(defaultMaxGeneration).toBeLessThanOrEqual(3);

    await page.locator('#planner-lookahead').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '1.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#planner-lookahead-value')).toHaveText('1.50');
    await expect(page.locator('#stats')).toContainText('1.50x');

    const lookahead = await page.evaluate(() => {
      const w = window as unknown as {
        __planner__: { getRevealScreensAbove: () => number };
      };
      return w.__planner__.getRevealScreensAbove();
    });
    expect(lookahead).toBe(1.5);

    await page.locator('#planner-searchDepth').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#planner-searchDepth-value')).toHaveText('5');

    await page.locator('#planner-edgeBudget').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '480';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#planner-edgeBudget-value')).toHaveText('480');

    await page.locator('#planner-planBudgetMs').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '10';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#planner-planBudgetMs-value')).toHaveText('10ms');
    await expect(page.locator('#stats')).toContainText('5 jumps');

    const searchLimits = await page.evaluate(() => {
      const w = window as unknown as {
        __planner__: { getSearchLimits: () => { maxStableDepth: number; maxEdgeRollouts: number; budgetMs: number } };
      };
      return w.__planner__.getSearchLimits();
    });
    expect(searchLimits).toMatchObject({ maxStableDepth: 5, maxEdgeRollouts: 480, budgetMs: 10 });
    await page.waitForFunction(() => {
      const planner = (window as { __planner__?: { lastSegments: () => Array<{ generation: number }> } }).__planner__;
      return (planner?.lastSegments() ?? []).length > 0;
    });
    const updatedMaxGeneration = await page.evaluate(() => {
      const overlay = (window as { __overlay__: { lastDrawnStats: () => { maxGeneration: number } } }).__overlay__;
      return overlay.lastDrawnStats().maxGeneration;
    });
    expect(updatedMaxGeneration).toBeLessThanOrEqual(3);

    await page.locator('#policy-wall').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '0.8';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#policy-wall-value')).toHaveText('0.80');

    const policy = await page.evaluate(() => {
      const w = window as unknown as {
        __planner__: { policy: () => { climb: number; wall: number } };
      };
      return w.__planner__.policy();
    });

    expect(policy.climb).toBeCloseTo(1.0);
    expect(policy).toMatchObject({ wall: 0.8 });
    await expect(page.locator('#stats')).not.toContainText('wall 0.80');

    await page.locator('#policy-reset').click();
    await expect(page.locator('#policy-wall-value')).toHaveText('0.50');

    const resetPolicy = await page.evaluate(() => {
      const w = window as unknown as {
        __planner__: { policy: () => { climb: number; wall: number } };
      };
      return w.__planner__.policy();
    });
    expect(resetPolicy.climb).toBeCloseTo(1.0);
    expect(resetPolicy).toMatchObject({ wall: 0.5 });

    await page.locator('#overlay-shareWidthScale').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '14';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#overlay-shareWidthScale-value')).toHaveText('14.0');

    await page.locator('#overlay-generationWeight3').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '0.25';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#overlay-generationWeight3-value')).toHaveText('0.25');

    const generationWeights = await page.evaluate(() => {
      const overlay = (window as { __overlay__: { getGenerationWidthWeights: () => number[] } }).__overlay__;
      return overlay.getGenerationWidthWeights();
    });
    expect(generationWeights).toEqual([1, 0.9, 0.25, 0]);

    await page.locator('#overlay-highlightChosen').check();
    await expect(page.locator('#overlay-highlightChosen')).toBeChecked();

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
