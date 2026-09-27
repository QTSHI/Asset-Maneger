import { expect, test } from '@playwright/test';

test('foreign-currency memo amounts keep their original currency on both pages', async ({ page }) => {
  await page.route('**/api/v2/dashboard?*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.household.memos = [{
      id: 901,
      kind: 'expense',
      title: '美元付款提醒',
      expected_amount: 240,
      currency_code: 'USD',
      due_date: '2030-01-01',
      reminder_days: 7,
      display_status: 'pending',
      days_until: 30,
    }];
    await route.fulfill({ response, json: payload });
  });
  await page.route('**/api/v2/meta', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.currencies.push({ id: 9999, code: 'GBP' });
    await route.fulfill({ response, json: payload });
  });
  await page.route('**/api/v2/household/memos', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{
        id: 902,
        kind: 'expense',
        title: '英镑付款提醒',
        expected_amount: 375,
        currency_id: 9999,
        due_date: '2030-01-01',
        reminder_days: 7,
        status: 'pending',
      }] }),
    });
  });

  await page.goto('/#/');
  const dollarAmount = new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(240);
  await expect(page.locator('.memo-list')).toContainText(dollarAmount);

  await page.getByRole('link', { name: '查看大额事项提醒' }).click();
  const poundAmount = new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'GBP', maximumFractionDigits: 2,
  }).format(375);
  await expect(page.locator('.large-memo-list')).toContainText(poundAmount);
  await expect(page.locator('.large-memo-list')).not.toContainText('¥375');
});
