import { expect, test } from '@playwright/test';

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test('all seven pages are reachable at the narrowest supported width', async ({ page }) => {
    await page.goto('/#/');
    const navigation = page.getByRole('navigation', { name: '移动端导航' });
    await expect(navigation).toBeVisible();

    for (const [label, path] of [
      ['总览', '/'],
      ['资产', '/assets'],
      ['预算', '/budget'],
      ['收支', '/transactions'],
      ['计划', '/plans'],
    ]) {
      const link = navigation.getByRole('link', { name: label, exact: true });
      await link.click();
      await expect(page).toHaveURL(new RegExp(`#${path === '/' ? '/$' : `${path}$`}`));
      await expect(link).toHaveAttribute('aria-current', 'page');
    }

    const more = navigation.getByRole('button', { name: '更多' });
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await navigation.getByRole('link', { name: '账户' }).click();
    await expect(page).toHaveURL(/#\/accounts$/);
    await expect(page.getByRole('heading', { name: '家庭账户' })).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    await more.click();
    await navigation.getByRole('link', { name: '数据状态' }).click();
    await expect(page).toHaveURL(/#\/status$/);
    await expect(page.getByRole('heading', { name: '数据状态' })).toBeVisible();
    await expect(more).toHaveClass(/active/);

    const dimensions = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
    for (const item of await navigation.locator(':scope > a, :scope > button').all()) {
      const box = await item.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('more pages can be dismissed with Escape or a tap outside', async ({ page }) => {
    await page.goto('/#/');
    const navigation = page.getByRole('navigation', { name: '移动端导航' });
    const more = navigation.getByRole('button', { name: '更多' });
    const account = navigation.getByRole('link', { name: '账户' });

    await more.click();
    await expect(account).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(account).toBeHidden();
    await expect(more).toBeFocused();

    await more.click();
    await page.locator('.topbar h1').click();
    await expect(account).toBeHidden();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
  });
});
