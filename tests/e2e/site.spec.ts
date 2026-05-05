import { expect, test } from '@playwright/test';

test.describe('localized shell', () => {
  test('detects browser language and persists manual selection', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fr-FR' });
    const page = await context.newPage();

    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('#mainBarInfo')).toContainText('Projet amateur de préservation');
    await expect(page.locator('.languageSwitch button.active')).toHaveText('FR');
    await expect(page.locator('.menuBox')).toContainText('Jouer');
    await expect(page.locator('#leftPane')).toContainText('8 jeux en ligne');

    await page.getByRole('button', { name: 'EN' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.languageSwitch button.active')).toHaveText('EN');

    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#mainBarInfo')).toContainText('Fan preservation project');
    await expect(page.locator('.languageSwitch button.active')).toHaveText('EN');

    await context.close();
  });
});

test.describe('portal smoke tests', () => {
  test('loads a game route inside the portal shell', async ({ page }) => {
    await page.goto('/#interwheel');

    await expect(page.locator('#mainLogo img')).toHaveAttribute('alt', 'KadoKado');
    await expect(page.locator('.player-title')).toHaveText('Interwheel');
    await expect(page.locator('.player-back')).toBeVisible();
  });

  test('renders seeded leaderboard scores', async ({ page, request }) => {
    const response = await request.post('/api/games/linea/scores', {
      data: {
        pseudonym: 'E2E Player',
        score: 12345,
        secondary: { key: 'difficulty', label: 'Difficulty', value: 7 },
      },
    });
    expect(response.status()).toBe(201);

    await page.goto('/#scores');

    const lineaBox = page.locator('.scoreBox').filter({ hasText: 'Linea' });
    await expect(lineaBox).toContainText('E2E Player');
    await expect(lineaBox).toContainText('12,345');
  });
});
