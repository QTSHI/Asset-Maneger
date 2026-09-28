import { expect, test } from '@playwright/test';

test('unfinished budget and plans modules are absent from the site', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByText('家庭总资产')).toBeVisible();
  await expect(page.getByRole('link', { name: '家庭预算' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '计划与提醒' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '家庭预算' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '近期大额事项' })).toHaveCount(0);

  await page.goto('/#/budget');
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByText('家庭总资产')).toBeVisible();

  await page.goto('/#/plans');
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByText('家庭总资产')).toBeVisible();
});
