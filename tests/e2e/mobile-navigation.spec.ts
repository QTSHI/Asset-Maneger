import { expect, test } from '@playwright/test';

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test('all five remaining pages are reachable at the narrowest supported width', async ({ page }) => {
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
  });

});
