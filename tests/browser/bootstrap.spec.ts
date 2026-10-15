import { test, expect } from '@playwright/test';
test('serves the React foundation', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: 'Flash sale' })).toBeVisible(); });
