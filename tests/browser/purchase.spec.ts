import { test, expect, type Page } from '@playwright/test';

const openSale = () => ({
  saleId: 'flash-sale',
  status: 'OPEN',
  startsAt: new Date(Date.now() - 60000).toISOString(),
  endsAt: new Date(Date.now() + 60000).toISOString(),
  observedAt: new Date().toISOString(),
  remainingStock: 10,
});
const available = (order: object = { status: 'NOT_ORDERED' }) => ({
  status: 'AVAILABLE',
  order,
});

async function setup(page: Page) {
  await page.route('**/api/sales/flash-sale', (route) =>
    route.fulfill({ json: openSale() }),
  );
  await page.route('**/order?*', (route) =>
    route.fulfill({ json: available() }),
  );
  await page.goto('/');
}

test('normalizes arbitrary identifiers, rejects empty input and locks double submission', async ({
  page,
}) => {
  await setup(page);

  const button = page.getByRole('button', { name: 'Buy Now' });

  await expect(button).toHaveCount(0);
  await expect(page.getByText('Enter your username to buy.')).toBeVisible();
  await page.getByLabel('Username').fill('   ');
  await expect(button).toHaveCount(0);

  let deliveries = 0;
  let body: { identifier: string } | undefined;

  await page.route('**/purchases', async (route) => {
    deliveries++;
    body = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: { status: 'PROCESSING', phase: 'queued' } });
  });
  await page.getByLabel('Username').fill('  Any NAME + / ?  ');
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.getByText('Your order is being confirmed.')).toBeVisible();
  expect(deliveries).toBe(1);
  expect(body?.identifier).toBe('any name + / ?');
});

test('uncertain delivery retries the same key and recovers to success', async ({
  page,
}) => {
  await setup(page);

  const keys: string[] = [];

  await page.route('**/purchases', async (route) => {
    keys.push(route.request().postDataJSON().idempotencyKey);

    if (keys.length === 1) await route.abort();
    else
      await route.fulfill({
        json: { status: 'SUCCESS', orderId: 'order-recovered' },
      });
  });
  await page.getByLabel('Username').fill('person');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(page.getByText(/We couldn’t confirm your order/)).toBeVisible();
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(
    page.getByRole('heading', { name: 'Order confirmed' }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test('refresh retrieves remembered pending and successful orders after sale ends', async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel('Username').fill('remember-me');
  await page.route('**/api/sales/flash-sale', (route) =>
    route.fulfill({ json: { ...openSale(), status: 'ENDED' } }),
  );
  await page.route('**/order?*', (route) =>
    route.fulfill({
      json: available({ status: 'PROCESSING', phase: 'delayed' }),
    }),
  );
  await page.reload();
  await expect(page.getByLabel('Username')).toHaveValue('remember-me');
  await expect(page.getByText(/This is taking a little longer/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(0);
  await page.route('**/order?*', (route) =>
    route.fulfill({
      json: available({ status: 'SUCCESS', orderId: 'remembered-order' }),
    }),
  );
  await expect(page.getByText('Order remembered-order')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Order remembered-order')).toBeVisible();
});

test('late lookup and purchase cannot overwrite a different identifier', async ({
  page,
}) => {
  await setup(page);

  let releaseLookup!: () => void;
  let releasePurchase!: () => void;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const purchaseGate = new Promise<void>((resolve) => {
    releasePurchase = resolve;
  });

  await page.route('**/order?*', async (route) => {
    if (route.request().url().includes('identifier=old')) {
      await lookupGate;
      await route.fulfill({
        json: available({ status: 'SUCCESS', orderId: 'old-lookup' }),
      });
    } else await route.fulfill({ json: available() });
  });
  await page.route('**/purchases', async (route) => {
    await purchaseGate;
    await route.fulfill({
      json: { status: 'SUCCESS', orderId: 'old-purchase' },
    });
  });
  await page.getByLabel('Username').fill('old');
  await page.waitForRequest('**/order?identifier=old');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await page.getByLabel('Username').fill('new');
  releaseLookup();
  releasePurchase();
  await expect(page.getByText('Checking your order…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy Now' })).toBeEnabled();
  await expect(page.getByText('Ready when you are.')).toHaveCount(0);
  await expect(page.getByText(/Order old-/)).toHaveCount(0);
});

for (const status of ['PROCESSING', 'SUCCESS'] as const) {
  test(`restored ${status} order disables purchase, including form submission`, async ({
    page,
  }) => {
    await setup(page);
    let purchases = 0;
    await page.route('**/purchases', (route) => {
      purchases++;
      return route.abort();
    });
    await page.route('**/order?*', (route) =>
      route.fulfill({
        json: available(
          status === 'SUCCESS'
            ? { status, orderId: 'existing' }
            : { status, phase: 'queued' },
        ),
      }),
    );
    await page.getByLabel('Username').fill('allocated');
    await expect(
      page.getByRole('heading', {
        name:
          status === 'SUCCESS' ? 'Order confirmed' : 'Confirming your order',
      }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(0);
    await page
      .locator('#purchase-form')
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.getByLabel('Username').press('Enter');
    expect(purchases).toBe(0);
    await page.getByLabel('Username').fill('another-user');
    await page.route('**/order?*', (route) =>
      route.fulfill({ json: available() }),
    );
    await expect(page.getByRole('button', { name: 'Buy Now' })).toBeEnabled();
  });
}

test('already placed response confirms order and disables repeat purchase', async ({
  page,
}) => {
  await setup(page);
  await page.route('**/purchases', (route) =>
    route.fulfill({
      status: 409,
      json: {
        status: 'REJECTED',
        reason: 'already_placed',
        existingOrder: { status: 'SUCCESS', orderId: 'existing' },
      },
    }),
  );
  await page.getByLabel('Username').fill('allocated');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(page.getByText('Order existing')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(0);
});

test('keyboard submission shows busy feedback and backend closing race rejection', async ({
  page,
}) => {
  await setup(page);
  await page.route('**/purchases', (route) =>
    route.fulfill({
      status: 429,
      json: { status: 'REJECTED', reason: 'busy' },
    }),
  );
  await page.getByLabel('Username').fill('keyboard');
  await page.getByLabel('Username').press('Enter');
  await expect(
    page.getByText('The service is busy. Please try again.'),
  ).toBeVisible();
  await page.route('**/purchases', (route) =>
    route.fulfill({
      status: 409,
      json: { status: 'REJECTED', reason: 'ended' },
    }),
  );
  await page.getByLabel('Username').press('Enter');
  await expect(page.getByText('The sale has ended.')).toBeVisible();
});

for (const status of ['UPCOMING', 'ENDED', 'SOLD_OUT']) {
  test(`disables purchasing for known ${status}`, async ({ page }) => {
    await setup(page);
    await page.route('**/api/sales/flash-sale', (route) =>
      route.fulfill({ json: { ...openSale(), status } }),
    );
    await page.reload();
    await page.getByLabel('Username').fill('person');
    await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(0);
  });
}

test('lookup debounces edits and recovers after a network error', async ({
  page,
}) => {
  await setup(page);

  let calls = 0;

  await page.route('**/order?*', (route) => {
    calls++;

    return calls === 1
      ? route.abort()
      : route.fulfill({
          json: available({ status: 'SUCCESS', orderId: 'network-recovered' }),
        });
  });
  await page.getByLabel('Username').pressSequentially('person', { delay: 15 });
  await expect(page.getByText(/Connection lost/)).toBeVisible();
  expect(calls).toBe(1);
  await expect(page.getByText('Order network-recovered')).toBeVisible();
});

for (const width of [320, 768, 1024, 1440]) {
  test(`page fits a ${width}px viewport`, async ({ page }, testInfo) => {
    const errors: string[] = [];

    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(0);
    await expect(page.locator('button:disabled')).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('purchase.png'),
      fullPage: true,
    });
  });
}

test('sale status refresh disables purchase when the sale closes', async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel('Username').fill('person');
  await expect(page.getByRole('button', { name: 'Buy Now' })).toBeEnabled();
  await page.route('**/api/sales/flash-sale', (route) =>
    route.fulfill({ json: { ...openSale(), status: 'ENDED' } }),
  );
  await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(0, {
    timeout: 8000,
  });
});

test('lookup started before submission cannot erase placed state', async ({
  page,
}) => {
  await setup(page);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route('**/order?*', async (route) => {
    await gate;
    await route.fulfill({ json: available() });
  });
  await page.route('**/purchases', (route) =>
    route.fulfill({ json: { status: 'PROCESSING', phase: 'queued' } }),
  );
  await page.getByLabel('Username').fill('person');
  await page.waitForRequest('**/order?identifier=person');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirming your order' }),
  ).toBeVisible();
  release();
  await expect(page.getByText('Ready when you are.')).toHaveCount(0);
});

test('automatic lookup resolves uncertain confirmation and clears its warning', async ({
  page,
}) => {
  await setup(page);
  await page.route('**/purchases', (route) => route.abort());
  await page.getByLabel('Username').fill('person');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(page.getByText(/We couldn’t confirm your order/)).toBeVisible();
  await page.route('**/order?*', (route) =>
    route.fulfill({
      json: available({ status: 'SUCCESS', orderId: 'confirmed-later' }),
    }),
  );
  await expect(page.getByText('Order confirmed-later')).toBeVisible();
  await expect(page.getByText(/We couldn’t confirm your order/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(0);
});

for (const offset of [-86400000, 86400000]) {
  test(`uses server sale status with browser clock offset ${offset}`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(Date.now() + offset));
    await setup(page);
    await page.getByLabel('Username').fill('clock-skew');
    await expect(page.getByRole('button', { name: 'Buy Now' })).toBeEnabled();
    await page.route('**/purchases', (route) =>
      route.fulfill({
        status: 409,
        json: { status: 'REJECTED', reason: 'ended' },
      }),
    );
    await page.getByRole('button', { name: 'Buy Now' }).click();
    await expect(page.getByText('The sale has ended.')).toBeVisible();
  });
}

for (const outcome of ['NOT_ORDERED', 'lost-response']) {
  test(`unconfirmed ${outcome} preserves retry key through empty lookup and closure`, async ({
    page,
  }) => {
    await setup(page);

    const keys: string[] = [];

    await page.route('**/purchases', async (route) => {
      keys.push(route.request().postDataJSON().idempotencyKey);

      if (keys.length === 2)
        return route.fulfill({
          status: 429,
          json: { status: 'REJECTED', reason: 'busy' },
        });

      if (keys.length > 2)
        return route.fulfill({
          json: { status: 'PROCESSING', phase: 'queued' },
        });

      if (outcome === 'lost-response') return route.abort();

      return route.fulfill({
        status: 202,
        json: { status: 'NOT_ORDERED', reason: 'confirmation_uncertain' },
      });
    });
    await page.getByLabel('Username').fill('retry-person');
    await page.getByRole('button', { name: 'Buy Now' }).click();
    await expect(
      page.getByText('We couldn’t confirm your order. Try again.'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Confirming your order' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Buy Now' }).click();
    await expect(
      page.getByText('The service is busy. Please try again.'),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    await page.route('**/api/sales/flash-sale', (route) =>
      route.fulfill({ json: { ...openSale(), status: 'ENDED' } }),
    );
    await expect(page.getByText('Sale ended', { exact: true })).toBeVisible({
      timeout: 8000,
    });
    await expect(page.getByText('This sale has ended.')).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(0);
    await page
      .locator('#purchase-form')
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(keys).toHaveLength(2);
    await page.route('**/order?*', (route) =>
      route.fulfill({
        json: available({
          status: 'SUCCESS',
          orderId: 'confirmed-after-closure',
        }),
      }),
    );
    await expect(page.getByText('Order confirmed-after-closure')).toBeVisible();
    await expect(page.getByText('This sale has ended.')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(0);
  });
}

test('fresh missing reservation clears PROCESSING and retries the original key', async ({
  page,
}) => {
  await setup(page);

  let missing = false;

  await page.route('**/order?*', (route) =>
    route.fulfill({
      json: available(
        missing || keys.length === 0
          ? { status: 'NOT_ORDERED' }
          : { status: 'PROCESSING', phase: 'queued' },
      ),
    }),
  );

  const keys: string[] = [];

  await page.route('**/purchases', (route) => {
    keys.push(route.request().postDataJSON().idempotencyKey);

    return route.fulfill({
      status: 202,
      json: { status: 'PROCESSING', phase: 'queued' },
    });
  });
  await page.getByLabel('Username').fill('lost-reservation');
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirming your order' }),
  ).toBeVisible();
  missing = true;
  await expect(
    page.getByText(
      'Your reservation is no longer available. Please try again.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Confirming your order' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Buy Now' }).click();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test('centered sale presents a prominent countdown and customer copy', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await setup(page);
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByText('Sale is live', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Black Death Note notebook' }),
  ).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(
    page.getByText(/prototype|identifier|payment|shipping|one unit/i),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('sale-desktop.png'),
    fullPage: true,
  });
  await page.getByLabel('Username').fill('Alex');
  await page.route('**/purchases', (route) =>
    route.fulfill({ json: { status: 'SUCCESS', orderId: 'confirmed-order' } }),
  );
  await page.getByRole('button', { name: 'Buy Now' }).click();
  await expect(
    page.getByRole('heading', { name: 'Order confirmed' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('sale-confirmed.png'),
    fullPage: true,
  });
});

for (const viewport of [
  { width: 320, height: 667 },
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
]) {
  test(`purchase and feedback fit ${viewport.width}x${viewport.height} without scrolling`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.getByLabel('Username').fill('compact');
    await expect(page.getByText('Checking your order…')).toHaveCount(0);
    await expect(page.getByText('Ready when you are.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Buy Now' })).toBeEnabled();
    const image = page.getByRole('img', { name: 'Black Death Note notebook' });
    await expect
      .poll(() =>
        image.evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
      )
      .toBe(true);
    const dimensions = await image.evaluate((img) => {
      const image = img.getBoundingClientRect();
      const frame = img.parentElement!.getBoundingClientRect();
      return {
        image: { width: image.width, height: image.height },
        frame: { width: frame.width, height: frame.height },
      };
    });
    expect(dimensions.frame).toEqual(dimensions.image);
    for (const state of ['idle', 'processing', 'success']) {
      if (state === 'processing') {
        await page.route('**/purchases', (route) =>
          route.fulfill({ json: { status: 'PROCESSING', phase: 'queued' } }),
        );
        await page.getByRole('button', { name: 'Buy Now' }).click();
        await expect(
          page.getByRole('heading', { name: 'Confirming your order' }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(
          0,
        );
      }
      if (state === 'success') {
        await page.route('**/order?*', (route) =>
          route.fulfill({
            json: available({ status: 'SUCCESS', orderId: 'confirmed-order' }),
          }),
        );
        await expect(
          page.getByRole('heading', { name: 'Order confirmed' }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Buy Now' })).toHaveCount(
          0,
        );
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${state}.png`) });
    }
  });
}
