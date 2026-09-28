import { expect, test } from '@playwright/test';

test('an Agent suggestion changes an asset only after explicit website confirmation', async ({ page }) => {
  let approved = false;
  let approvalCalls = 0;
  const proposal = {
    id: 42,
    assetId: 7,
    status: 'pending',
    asset: { id: 7, code: 'CASH-7', name: '测试现金', accountName: '测试账户', currencyCode: 'CNY', assetTypeName: 'cash' },
    changes: [{ field: 'shares', before: 100, after: 125 }],
    createdAt: '2026-09-28T10:00:00.000Z',
    reviewedAt: null,
    reviewerUsername: null,
  };

  await page.route('**/api/v2/agent/proposals**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/approve')) {
      approvalCalls += 1;
      approved = true;
      await route.fulfill({ json: { data: { ...proposal, status: 'approved', reviewedAt: '2026-09-28T10:05:00.000Z', reviewerUsername: 'local-preview' } } });
      return;
    }
    const rows = url.searchParams.get('status') === 'pending'
      ? approved ? [] : [proposal]
      : [{ ...proposal, status: approved ? 'approved' : 'pending' }];
    await route.fulfill({ json: { data: rows, meta: { total: rows.length, page: 1, pageSize: 100 } } });
  });
  await page.route('**/api/v2/agent/keys', async (route) => {
    await route.fulfill({ json: { data: [], meta: { total: 0 } } });
  });

  await page.goto('/#/agent');
  await expect(page.getByRole('heading', { name: 'Agent 授权' })).toBeVisible();
  await expect(page.getByText('测试现金')).toBeVisible();
  await expect(page.getByText('100', { exact: true })).toBeVisible();
  await expect(page.getByText('125', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '批准修改', exact: true }).click();
  await expect(page.getByText('确认应用以上修改？')).toBeVisible();
  expect(approvalCalls).toBe(0);

  await page.getByRole('button', { name: '确认批准', exact: true }).click();
  await expect.poll(() => approvalCalls).toBe(1);
  await expect(page.getByText('修改已批准并应用到资产。')).toBeVisible();
  await expect(page.getByText('暂无待确认修改')).toBeVisible();
});
