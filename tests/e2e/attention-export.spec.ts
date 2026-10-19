import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

test('a checklist action opens the exact asset and disappears after balance confirmation', async ({ page, baseURL }, testInfo) => {
  const meta = (await (await page.request.get('/api/v2/meta')).json()).data;
  const name = `待核对现金-${testInfo.project.name}-${Date.now()}`;
  const created = await page.request.post('/api/v2/assets', { headers: { Origin: baseURL! }, data: {
    name, code: `CHECK-${Date.now()}`, shares: 123, cost_price: 1,
    platform_id: meta.accounts[0].id,
    asset_type_id: meta.assetTypes.find((type: { name: string }) => type.name === 'cash').id,
    currency_id: meta.currencies.find((currency: { code: string }) => currency.code === 'CNY').id,
  } });
  expect(created.status()).toBe(201);
  await page.goto('/');
  const checklist = page.getByRole('region', { name: '待核对清单' });
  await expect(checklist.getByRole('button', { name: '刷新待核对清单' })).toBeEnabled();
  const expand = checklist.getByRole('button', { name: /^展开其余/ });
  if (await expand.count()) await expand.click();
  await checklist.locator('li').filter({ hasText: name }).getByRole('link', { name: '确认现金余额' }).click();
  await expect(page.getByText(`已定位资产：${name}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `更新 ${name} 余额`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认余额', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const navigation = (page.viewportSize()?.width || 1440) <= 720 ? page.locator('.mobile-nav') : page.locator('.sidebar');
  await navigation.getByRole('link', { name: '总览', exact: true }).click();
  await expect(page.getByRole('region', { name: '待核对清单' }).locator('li').filter({ hasText: name })).toHaveCount(0);
});

test('holding export downloads a readable CSV with stored original fields', async ({ page }) => {
  await page.goto('/#/assets');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出持仓 CSV', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('stone-wealth-assets-active.csv');
  const csv = await fs.readFile((await download.path())!, 'utf8');
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('资产ID');
  expect(csv).toContain('E2E-CASH');
  expect(csv).toContain('演示备用金');
  expect(csv).toContain('现金余额确认时间');
  await expect(page.getByRole('status')).toContainText('下载已准备好');
});
