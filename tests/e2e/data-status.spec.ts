import { expect, test } from '@playwright/test';

test('Trading212 authentication failure is distinct from configured credentials', async ({ page }) => {
  await page.route('**/api/v2/integrations/trading212/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          configured: true,
          authenticationState: 'invalid',
          lastErrorCode: 'AUTH_FAILED',
          detailedSyncAvailable: false,
          aggregateFallback: true,
          state: 'error',
          message: 'Trading212 凭据验证失败',
        },
      }),
    });
  });

  await page.goto('/#/status');
  await expect(page.getByRole('heading', { name: '凭据认证失败' })).toBeVisible();
  await expect(page.getByText('API 凭据被拒绝，请更新配置后重试；现有资产数据已保留。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新同步并对账' })).toBeEnabled();
  await expect(page.getByText('账户汇总备用值仍列为待分类资产，详细同步成功后再归档。')).toBeVisible();
});

test('failed exchange-rate refresh is shown as an error even when quotes succeeded', async ({ page }) => {
  await page.route('**/api/v2/market/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: {
      state: 'error', updated: 91, failed: 0,
      message: '汇率更新失败，已保留上次有效汇率',
      finishedAt: new Date().toISOString(),
    } }),
  }));

  await page.goto('/#/status');
  await expect(page.getByRole('heading', { name: '部分异常' })).toBeVisible();
  await expect(page.getByText('汇率更新失败，已保留上次有效汇率')).toBeVisible();
  await expect(page.getByText('需关注')).toBeVisible();
});
