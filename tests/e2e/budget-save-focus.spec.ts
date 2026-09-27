import { expect, test } from '@playwright/test';

test('budget save failure keeps keyboard focus on the save action', async ({ page }) => {
  await page.route('**/api/v2/household/budgets', (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEST_FAILURE', message: '模拟保存失败' } }),
    });
  });

  await page.goto('/#/budget');
  const save = page.getByRole('button', { name: '保存该月预算' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('alert')).toContainText('模拟保存失败');
  await expect(save).toBeFocused();
});
