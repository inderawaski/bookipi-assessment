import { test, expect, type Page } from '@playwright/test';

const openSale = () => ({ saleId: 'flash-sale', status: 'OPEN', startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), observedAt: new Date().toISOString(), remainingStock: 10 });
const available = (order: object = { status: 'NOT_ORDERED' }) => ({ status: 'AVAILABLE', order });
async function setup(page: Page) {
  await page.route('**/api/sales/flash-sale', route => route.fulfill({ json: openSale() }));
  await page.route('**/order?*', route => route.fulfill({ json: available() }));
  await page.goto('/');
}

test('normalizes arbitrary identifiers, rejects empty input and locks double submission', async ({ page }) => {
  await setup(page);
  const button = page.getByRole('button', { name: 'Buy Now' });
  await expect(button).toBeDisabled();
  await page.getByLabel('Your identifier').fill('   ');
  await expect(button).toBeDisabled();
  let deliveries = 0;
  let body: { identifier: string } | undefined;
  await page.route('**/purchases', async route => {
    deliveries++; body = route.request().postDataJSON();
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ json: { status: 'PROCESSING', phase: 'queued' } });
  });
  await page.getByLabel('Your identifier').fill('  Any NAME + / ?  ');
  await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect(page.getByText('Order placed. Waiting for processing to complete.')).toBeVisible();
  expect(deliveries).toBe(1); expect(body?.identifier).toBe('any name + / ?');
});

test('uncertain delivery retries the same key and recovers to success', async ({ page }) => {
  await setup(page);
  const keys: string[] = [];
  await page.route('**/purchases', async route => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (keys.length === 1) await route.abort();
    else await route.fulfill({ json: { status: 'SUCCESS', orderId: 'order-recovered' } });
  });
  await page.getByLabel('Your identifier').fill('person');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(page.getByText(/Confirmation uncertain/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry confirmation' }).click();
  await expect(page.getByRole('heading', { name: 'SUCCESS' })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
});

test('refresh retrieves remembered pending and successful orders after sale ends', async ({ page }) => {
  await setup(page);
  await page.getByLabel('Your identifier').fill('remember-me');
  await page.route('**/api/sales/flash-sale', route => route.fulfill({ json: { ...openSale(), status: 'ENDED' } }));
  await page.route('**/order?*', route => route.fulfill({ json: available({ status: 'PROCESSING', phase: 'delayed' }) }));
  await page.reload();
  await expect(page.getByLabel('Your identifier')).toHaveValue('remember-me');
  await expect(page.getByText(/Processing is delayed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Now' })).toBeDisabled();
  await page.route('**/order?*', route => route.fulfill({ json: available({ status: 'SUCCESS', orderId: 'remembered-order' }) }));
  await expect(page.getByText('Order remembered-order')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Order remembered-order')).toBeVisible();
});

test('late lookup and purchase cannot overwrite a different identifier', async ({ page }) => {
  await setup(page);
  let releaseLookup!: () => void;
  let releasePurchase!: () => void;
  const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve; });
  const purchaseGate = new Promise<void>(resolve => { releasePurchase = resolve; });
  await page.route('**/order?*', async route => {
    if (route.request().url().includes('identifier=old')) { await lookupGate; await route.fulfill({ json: available({ status: 'SUCCESS', orderId: 'old-lookup' }) }); }
    else await route.fulfill({ json: available() });
  });
  await page.route('**/purchases', async route => { await purchaseGate; await route.fulfill({ json: { status: 'SUCCESS', orderId: 'old-purchase' } }); });
  await page.getByLabel('Your identifier').fill('old');
  await page.waitForRequest('**/order?identifier=old');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await page.getByLabel('Your identifier').fill('new');
  releaseLookup(); releasePurchase();
  await expect(page.getByText('No order found for this identifier.')).toBeVisible();
  await expect(page.getByText(/Order old-/)).toHaveCount(0);
});

test('new placement reports already placed and preserves success through rejection', async ({ page }) => {
  await setup(page);
  await page.route('**/order?*', route => route.fulfill({ json: available({ status: 'SUCCESS', orderId: 'existing' }) }));
  await page.getByLabel('Your identifier').fill('allocated');
  await expect(page.getByText('Order existing')).toBeVisible();
  await page.route('**/purchases', route => route.fulfill({ status: 409, json: { status: 'REJECTED', reason: 'already_placed', existingOrder: { status: 'SUCCESS', orderId: 'existing' } } }));
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(page.getByText(/Already placed:/)).toBeVisible();
  await page.route('**/purchases', route => route.fulfill({ status: 409, json: { status: 'REJECTED', reason: 'ended' } }));
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(page.getByText('The sale has ended.')).toBeVisible();
  await expect(page.getByText('Order existing')).toBeVisible();
});

test('keyboard submission shows busy feedback and backend closing race rejection', async ({ page }) => {
  await setup(page);
  await page.route('**/purchases', route => route.fulfill({ status: 429, json: { status: 'REJECTED', reason: 'busy' } }));
  await page.getByLabel('Your identifier').fill('keyboard');
  await page.getByLabel('Your identifier').press('Enter');
  await expect(page.getByText('The service is busy. Please try again.')).toBeVisible();
  await page.route('**/purchases', route => route.fulfill({ status: 409, json: { status: 'REJECTED', reason: 'ended' } }));
  await page.getByLabel('Your identifier').press('Enter');
  await expect(page.getByText('The sale has ended.')).toBeVisible();
});

for (const status of ['UPCOMING', 'ENDED', 'SOLD_OUT']) {
  test(`disables purchasing for known ${status}`, async ({ page }) => {
    await setup(page);
    await page.route('**/api/sales/flash-sale', route => route.fulfill({ json: { ...openSale(), status } }));
    await page.reload();
    await page.getByLabel('Your identifier').fill('person');
    await expect(page.getByRole('button', { name: 'Buy Now' })).toBeDisabled();
  });
}

test('lookup debounces edits and recovers after a network error', async ({ page }) => {
  await setup(page);
  let calls = 0;
  await page.route('**/order?*', route => {
    calls++;
    return calls === 1 ? route.abort() : route.fulfill({ json: available({ status: 'SUCCESS', orderId: 'network-recovered' }) });
  });
  await page.getByLabel('Your identifier').pressSequentially('person', { delay: 15 });
  await expect(page.getByText(/Connection lost/)).toBeVisible();
  expect(calls).toBe(1);
  await expect(page.getByText('Order network-recovered')).toBeVisible();
});

for (const width of [320, 768, 1024, 1440]) {
  test(`page fits a ${width}px viewport`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Buy Now' })).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('purchase.png'), fullPage: true });
  });
}

test('sale status refresh disables purchase when the sale closes', async ({ page }) => {
  await setup(page);
  await page.getByLabel('Your identifier').fill('person');
  await expect(page.getByRole('button', { name: 'Buy Now' })).toBeEnabled();
  await page.route('**/api/sales/flash-sale', route => route.fulfill({ json: { ...openSale(), status: 'ENDED' } }));
  await expect(page.getByRole('button', { name: 'Buy Now' })).toBeDisabled({ timeout: 8000 });
});

test('lookup started before submission cannot erase placed state', async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/order?*', async route => { await gate; await route.fulfill({ json: available() }); });
  await page.route('**/purchases', route => route.fulfill({ json: { status: 'PROCESSING', phase: 'queued' } }));
  await page.getByLabel('Your identifier').fill('person');
  await page.waitForRequest('**/order?identifier=person');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(page.getByRole('heading', { name: 'PROCESSING' })).toBeVisible();
  release();
  await expect(page.getByText('No order found for this identifier.')).toHaveCount(0);
});

test('automatic lookup resolves uncertain confirmation and clears its warning', async ({ page }) => {
  await setup(page);
  await page.route('**/purchases', route => route.abort());
  await page.getByLabel('Your identifier').fill('person');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(page.getByText(/Confirmation uncertain/)).toBeVisible();
  await page.route('**/order?*', route => route.fulfill({ json: available({ status: 'SUCCESS', orderId: 'confirmed-later' }) }));
  await expect(page.getByText('Order confirmed-later')).toBeVisible();
  await expect(page.getByText(/Confirmation uncertain/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy Now' })).toBeVisible();
});

for (const offset of [-86400000, 86400000]) {
  test(`uses server sale status with browser clock offset ${offset}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(Date.now() + offset));
    await setup(page);
    await page.getByLabel('Your identifier').fill('clock-skew');
    await expect(page.getByRole('button', { name: 'Buy Now' })).toBeEnabled();
    await page.route('**/purchases', route => route.fulfill({ status: 409, json: { status: 'REJECTED', reason: 'ended' } }));
    await page.getByRole('button', { name: 'Buy Now' }).click();
    await expect(page.getByText('The sale has ended.')).toBeVisible();
  });
}
