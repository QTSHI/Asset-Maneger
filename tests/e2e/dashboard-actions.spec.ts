import { expect, test } from '@playwright/test';

test('dashboard shortcuts open the budget and plans pages', async ({ page }) => {
  await page.goto('/#/');
  await page.getByRole('link', { name: '管理预算' }).click();
  await expect(page).toHaveURL(/#\/budget$/);
  await expect(page.getByRole('heading', { name: '家庭预算' })).toBeVisible();

  await page.goto('/#/');
  await page.getByRole('link', { name: '查看大额事项提醒' }).click();
  await expect(page).toHaveURL(/#\/plans$/);
  await expect(page.getByRole('heading', { name: '计划与提醒' })).toBeVisible();
});

test('zero amount category rows still show the no-budget prompt', async ({ page }) => {
  await page.route('**/api/v2/dashboard?*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.household.budgets = [{
      id: 1,
      categoryId: 1,
      categoryName: '尚未规划的分类',
      kind: 'expense',
      color: '#0f766e',
      planned: 0,
      actual: 0,
      remaining: 0,
      percent: 0,
    }];
    payload.data.household.totals.plannedExpense = 0;
    payload.data.household.totals.remainingBudget = 0;
    await route.fulfill({ response, json: payload });
  });

  await page.goto('/#/');
  await expect(page.getByText('还没有预算，先为这个月做个轻量计划')).toBeVisible();
  await expect(page.getByText('尚未规划的分类')).toHaveCount(0);
});
