import { expect, test } from '@playwright/test';

test('dashboard and core navigation render', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('家庭总资产')).toBeVisible();
  const width = page.viewportSize()?.width || 1440;
  const navigation = width <= 720 ? page.locator('.mobile-nav') : page.locator('.sidebar');
  await navigation.getByRole('link', { name: '资产' }).click();
  await expect(page.getByRole('heading', { name: '家庭资产' })).toBeVisible();
  await expect(page.getByText('按资产类别')).toBeVisible();
  await expect(page.locator('.selected-detail')).toHaveCount(0);
});

test('transaction page explains asset linkage', async ({ page }) => {
  await page.goto('/#/transactions');
  await expect(page.getByText('资产联动是什么？')).toBeVisible();
  await expect(page.getByText('它不会自动修改持仓数量或行情价格。')).toBeVisible();
});

test('responsive navigation is usable with no page overflow', async ({ page }) => {
  await page.goto('/');
  const width = page.viewportSize()?.width || 1440;
  if (width <= 720) {
    await expect(page.locator('.mobile-nav')).toBeVisible();
  } else {
    await expect(page.locator('.sidebar')).toBeVisible();
  }
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
});
