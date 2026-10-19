import { expect, test } from '@playwright/test';

test('an archived asset can be restored from its recycle bin', async ({ page, baseURL }, testInfo) => {
  const headers = { Origin: baseURL! };
  const meta = (await (await page.request.get('/api/v2/meta')).json()).data;
  const name = `恢复现金-${testInfo.project.name}-${Date.now()}`;
  const created = await page.request.post('/api/v2/assets', { headers, data: {
    name, code: `RECYCLE-${Date.now()}`, shares: 123, cost_price: 1,
    platform_id: meta.accounts[0].id,
    asset_type_id: meta.assetTypes.find((type: { name: string }) => type.name === 'cash').id,
    currency_id: meta.currencies.find((currency: { code: string }) => currency.code === 'CNY').id,
  } });
  expect(created.status()).toBe(201);
  const asset = (await created.json()).data;
  expect((await page.request.delete(`/api/v2/assets/${asset.id}`, { headers })).status()).toBe(204);

  await page.goto('/#/assets');
  await page.getByRole('button', { name: '资产回收站', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await row.getByRole('button', { name: '恢复资产', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('已恢复资产');
  const active = (await (await page.request.get('/api/v2/assets')).json()).data;
  expect(active.some((item: { id: number }) => item.id === asset.id)).toBe(true);
});

test('a deleted transaction and its original flow can be recovered together', async ({ page, baseURL }, testInfo) => {
  const headers = { Origin: baseURL! };
  const meta = (await (await page.request.get('/api/v2/meta')).json()).data;
  const note = `恢复收支-${testInfo.project.name}-${Date.now()}`;
  const created = await page.request.post('/api/v2/household/transactions', { headers, data: {
    kind: 'expense', amount: 23,
    currency_id: meta.currencies.find((currency: { code: string }) => currency.code === 'CNY').id,
    category_id: meta.categories.find((category: { kind: string }) => category.kind === 'expense').id,
    account_id: meta.accounts[0].id,
    occurred_on: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    note,
  } });
  expect(created.status()).toBe(201);
  const transaction = (await created.json()).data;
  const linked = await page.request.post(`/api/v2/household/transactions/${transaction.id}/link-cash-flow`, { headers, data: {} });
  expect(linked.ok()).toBe(true);
  const flow = (await linked.json()).data;
  expect((await page.request.delete(`/api/v2/household/transactions/${transaction.id}`, { headers, data: { linked_action: 'sync' } })).status()).toBe(204);

  await page.goto('/#/transactions');
  await page.getByRole('button', { name: '收支回收站', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: note });
  await row.getByRole('button', { name: '恢复收支及资金流', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已恢复收支记录及关联资金流');
  const active = (await (await page.request.get('/api/v2/household/transactions')).json()).data;
  expect(active.find((item: { id: number }) => item.id === transaction.id)?.linked_cash_flow_id).toBe(flow.cashFlowId);
});
