import { test, expect } from '@playwright/test';

test('shows the purchase page when sale status is unavailable', async ({
  page,
}) => {
  await page.route('**/api/**', (route) => route.abort());
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'THE KILLER DEAL' }),
  ).toBeVisible();
  await expect(
    page.getByText('Sale status unavailable. Reconnecting…'),
  ).toBeVisible();
});
