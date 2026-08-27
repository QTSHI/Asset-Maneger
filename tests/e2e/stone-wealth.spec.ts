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

test('month controls can navigate to future periods', async ({ page }) => {
  await page.goto('/#/transactions');
  const transactionMonth = page.getByLabel('选择月份');
  const initialMonth = await transactionMonth.inputValue();
  const [year, month] = initialMonth.split('-').map(Number);
  const next = new Date(year, month, 1, 12);
  const expectedNext = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  await page.getByRole('button', { name: '下一个月' }).click();
  await expect(transactionMonth).toHaveValue(expectedNext);
  await page.getByRole('button', { name: '记一笔' }).click();
  await expect(page.locator('input[name="occurred_on"]')).toHaveValue(`${expectedNext}-01`);
  await page.keyboard.press('Escape');

  await page.goto('/#/plans');
  await page.getByRole('button', { name: '下一个月' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`${next.getFullYear()} 年 ${next.getMonth() + 1} 月大额事项日历`) })).toBeVisible();
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
