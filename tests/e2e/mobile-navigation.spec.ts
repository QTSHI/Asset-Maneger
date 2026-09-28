import { expect, test } from '@playwright/test';

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test('the five main pages and Agent authorization are reachable at the narrowest supported width', async ({ page }) => {
    await page.goto('/#/');
    const navigation = page.getByRole('navigation', { name: '移动端导航' });
    await expect(navigation).toBeVisible();

    for (const [label, path] of [
      ['总览', '/'],
      ['资产', '/assets'],
      ['收支', '/transactions'],
      ['账户', '/accounts'],
      ['状态', '/status'],
    ]) {
      const link = navigation.getByRole('link', { name: label, exact: true });
      await link.click();
      await expect(page).toHaveURL(new RegExp(`#${path === '/' ? '/$' : `${path}$`}`));
      await expect(link).toHaveAttribute('aria-current', 'page');
    }

    await expect(navigation.getByRole('link')).toHaveCount(5);
    await expect(navigation.getByRole('button')).toHaveCount(0);

    await page.getByRole('link', { name: 'Agent 授权' }).click();
    await expect(page).toHaveURL(/#\/agent$/);
    await expect(page.getByRole('heading', { name: 'Agent 授权' })).toBeVisible();
    const agentLink = page.getByRole('link', { name: 'Agent 授权' });
    const agentBox320 = await agentLink.boundingBox();
    expect(agentBox320?.width).toBeGreaterThanOrEqual(44);
    expect(agentBox320?.height).toBeGreaterThanOrEqual(44);

    const dimensions = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
    for (const item of await navigation.locator(':scope > a').all()) {
      const box = await item.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    await page.setViewportSize({ width: 375, height: 700 });
    const agentBox = await agentLink.boundingBox();
    expect(agentBox?.width).toBeGreaterThanOrEqual(44);
    expect(agentBox?.height).toBeGreaterThanOrEqual(44);
    const width375 = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    expect(width375.scroll).toBeLessThanOrEqual(width375.width + 1);
  });

});
