import { test, expect, type Browser, type BrowserContext } from '@playwright/test';

test('password recovery signs out the old session and permits login with the new password', async ({
	browser,
	baseURL
}) => {
	const name = `reset_${Date.now().toString(36)}`;
	const account = await player(browser, baseURL!, name);
	try {
		await account.page.goto('/forgot-password');
		await account.page.getByLabel('Username, email or phone', { exact: true }).fill(name);
		await account.page.getByRole('button', { name: 'Send reset instructions' }).click();
		const token = (await account.page.getByTestId('reset-dev-token').textContent())!.trim();
		await account.page.getByLabel('Token from your message').fill(token);
		await account.page.getByLabel('New password', { exact: true }).fill('new-mobile-safe-password');
		await account.page.getByRole('button', { name: 'Update password' }).click();
		await expect(account.page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
		expect((await account.api.get('/api/v1/auth/me')).status()).toBe(401);
		await account.page.getByRole('link', { name: 'Sign in', exact: true }).click();
		await expect(account.page).toHaveURL(/\/login/);
		await account.page.getByLabel('Username, email or phone', { exact: true }).fill(name);
		await account.page.getByLabel('Password', { exact: true }).fill('new-mobile-safe-password');
		await account.page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(account.page).toHaveURL(/\/world/);
	} finally {
		await account.context.close();
	}
});

async function player(
	browser: Browser,
	baseURL: string,
	name: string,
	roles = ['visitor'],
	mobile = false
) {
	const context = await browser.newContext({
		baseURL,
		viewport: mobile ? { width: 844, height: 390 } : { width: 1100, height: 720 },
		isMobile: mobile,
		hasTouch: mobile,
		deviceScaleFactor: 1
	});
	const api = context.request;
	const registration = await api.post('/api/v1/auth/register', {
		data: {
			username: name,
			email: `${name}@example.com`,
			password: 'correct-horse-battery',
			display_name: name,
			preferred_language: 'en',
			accept_terms: true,
			accept_privacy: true
		}
	});
	expect(registration.status(), await registration.text()).toBe(201);
	const result = await registration.json();
	const headers = async () => ({
		'X-CSRF-Token': (await context.cookies()).find((cookie) => cookie.name === 'ppw_csrf')!.value
	});
	await api.post('/api/v1/auth/verification/confirm', {
		data: { code: result.verification.dev_code },
		headers: await headers()
	});
	await api.put('/api/v1/me/avatar', {
		data: {
			avatar_name: name,
			body: 'a',
			skin_tone: '#c8946b',
			hair_style: 'short',
			hair_color: '#1b1514',
			top_style: 'tee',
			top_color: '#2f7d6d',
			bottom_style: 'trousers',
			bottom_color: '#343b4a',
			shoe_color: '#eee5d5',
			accent_color: '#e8a33d',
			accessories: []
		},
		headers: await headers()
	});
	await api.post('/api/v1/me/roles', {
		data: { roles },
		headers: await headers()
	});
	if (roles.includes('buyer'))
		await api.post('/api/v1/me/addresses', {
			data: {
				label: 'Home',
				lat: 11.56955,
				lon: 104.92115,
				address_line: 'Private test address'
			},
			headers: await headers()
		});
	const spawns = await (await api.get('/api/v1/geo/spawn-points')).json();
	await api.put('/api/v1/me/spawn', {
		data: { spawn_point_id: spawns[0].id, world_visible: true },
		headers: await headers()
	});
	expect(
		(
			await api.post('/api/v1/me/onboarding/complete', {
				headers: await headers()
			})
		).ok()
	).toBe(true);
	return { context, api, page: await context.newPage(), headers, spawns };
}

test('landscape and portrait controls fit; chat and wallet open without overlapping movement', async ({
	browser,
	baseURL
}) => {
	test.setTimeout(240_000);
	const { context, page } = await player(
		browser,
		baseURL!,
		`mobile_${Date.now().toString(36)}`,
		['visitor'],
		true
	);
	try {
		await page.goto('/world');
		await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', {
			timeout: 180_000
		});
		await expect(page.getByTestId('hud-net')).toHaveAttribute('data-status', 'open', {
			timeout: 30_000
		});
		await expect(page.getByTestId('chat')).toBeHidden();
		await expect(page.getByTestId('touch-controls')).toBeVisible();
		for (const label of [
			'People (P)',
			'Places & shops (M)',
			'My vehicles (V)',
			'Cart (C)',
			'More controls',
			'Forward',
			'Back',
			'Left',
			'Right'
		]) {
			const box = (await page.getByRole('button', { name: label, exact: true }).boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(845);
			expect(box.y + box.height).toBeLessThanOrEqual(391);
		}
		await page.screenshot({ path: 'artifacts/mobile-landscape-world.png' });
		await page.getByRole('button', { name: 'Open chat', exact: true }).tap();
		await expect(page.getByTestId('chat')).toBeVisible();
		await expect(page.getByTestId('touch-controls')).toBeHidden();
		await page.getByRole('button', { name: 'Close chat', exact: true }).tap();
		await page.getByRole('button', { name: 'More controls', exact: true }).tap();
		await page.getByRole('button', { name: 'Demo wallet', exact: true }).tap();
		await expect(page.getByTestId('wallet-balance')).toHaveText('$100.00');
		await page
			.getByRole('button', {
				name: 'Add $50 in free demo credits',
				exact: true
			})
			.tap();
		await expect(page.getByTestId('wallet-balance')).toHaveText('$150.00');
		const dialog = page.getByRole('dialog');
		const box = (await dialog.boundingBox())!;
		expect(box.y + box.height).toBeLessThanOrEqual(391);
		await page.getByRole('button', { name: 'Close', exact: true }).tap();
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(page.getByRole('button', { name: 'Open chat', exact: true })).toBeVisible();
		await expect(page.getByTestId('touch-controls')).toBeVisible();
		await page.screenshot({ path: 'artifacts/mobile-portrait-world.png' });
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth
		);
		expect(overflow).toBe(false);
	} finally {
		await context.close();
	}
});

test('buyer chooses virtual delivery, pays from wallet, and an approved driver accepts the offer', async ({
	browser,
	baseURL
}) => {
	test.setTimeout(300_000);
	const id = Date.now().toString(36);
	const seller = await player(browser, baseURL!, `seller_${id}`, ['seller']);
	const buyer = await player(browser, baseURL!, `buyer_${id}`, ['buyer']);
	const driver = await player(browser, baseURL!, `driver_${id}`, ['driver']);
	const adminContext: BrowserContext = await browser.newContext({ baseURL });
	try {
		const admin = adminContext.request;
		expect(
			(
				await admin.post('/api/v1/auth/login', {
					data: { identifier: 'e2eadmin', password: 'e2e-admin-password' }
				})
			).ok()
		).toBe(true);
		const adminHeaders = {
			'X-CSRF-Token': (await adminContext.cookies()).find((cookie) => cookie.name === 'ppw_csrf')!
				.value
		};
		const application = await seller.api.post('/api/v1/merchant', {
			data: {
				business_name: 'Delivery test shop',
				category: 'food_drink',
				contact_email: `seller_${id}@example.com`
			},
			headers: await seller.headers()
		});
		expect(application.status(), await application.text()).toBe(201);
		const merchant = await application.json();
		expect(
			(
				await admin.post(`/api/v1/admin/merchants/${merchant.id}/approve`, {
					data: {},
					headers: adminHeaders
				})
			).ok()
		).toBe(true);
		await seller.page.goto('/seller');
		await seller.page.getByTestId('tab-units').click();
		await expect(seller.page.getByTestId('unit-map')).toHaveAttribute('data-ready', 'true', {
			timeout: 60_000
		});
		const units = await (
			await seller.api.get('/api/v1/market/units?bbox=104.915,11.564,104.927,11.576&available=true')
		).json();
		const unit = units.find(
			(value: { requires_verification: boolean }) => !value.requires_verification
		);
		expect(
			(
				await seller.api.post('/api/v1/merchant/claims', {
					data: { unit_code: unit.code },
					headers: await seller.headers()
				})
			).status()
		).toBe(201);
		const shop = (await (await seller.api.get('/api/v1/merchant/shops')).json())[0];
		const product = await (
			await seller.api.post('/api/v1/merchant/products', {
				data: {
					name: 'Delivery noodles',
					category: 'food',
					price_minor: 250,
					stock: 10,
					fulfillment: ['pickup', 'delivery']
				},
				headers: await seller.headers()
			})
		).json();
		await buyer.api.post('/api/v1/cart/items', {
			data: { product_id: product.id, shop_id: shop.id },
			headers: await buyer.headers()
		});
		await buyer.page.goto('/world');
		await expect(buyer.page.getByTestId('world-canvas')).toHaveAttribute('data-ready', 'true', {
			timeout: 180_000
		});
		await buyer.page.getByRole('button', { name: 'Cart (C)', exact: true }).click();
		await buyer.page.getByLabel('How would you like your order?').selectOption('delivery');
		await buyer.page.getByLabel('Public drop-off point').selectOption(buyer.spawns[0].id);
		await expect(buyer.page.getByTestId('cart-total')).toHaveText('$4.00');
		await buyer.page.getByTestId('place-order').click();
		await buyer.page.getByTestId('pay-demo').click();
		await expect(buyer.page.getByTestId('checkout-done')).toBeVisible();
		const order = (await (await buyer.api.get('/api/v1/orders')).json())[0];
		for (const to of ['merchant_accepted', 'preparing', 'ready_for_pickup'])
			expect(
				(
					await seller.api.post(`/api/v1/merchant/orders/${order.id}/transition`, {
						data: { to },
						headers: await seller.headers()
					})
				).ok()
			).toBe(true);
		const requests = await (await admin.get('/api/v1/admin/role-requests')).json();
		const request = requests.find(
			(value: { username: string; role: string }) =>
				value.username === `driver_${id}` && value.role === 'driver'
		);
		await admin.post(`/api/v1/admin/role-requests/${request.id}/approve`, {
			data: {},
			headers: adminHeaders
		});
		await driver.page.goto('/driver');
		await driver.page.getByRole('button', { name: 'Go online', exact: true }).click();
		await driver.page.getByRole('button', { name: 'Accept job', exact: true }).first().click();
		await expect(driver.page.getByTestId('active-delivery')).toContainText(order.number);
		await buyer.page.goto('/orders');
		await expect(buyer.page.getByTestId('delivery-tracking')).toContainText(buyer.spawns[0].name);
		await expect(buyer.page.getByTestId('buyer-order')).toHaveAttribute(
			'data-status',
			'assigned_to_driver'
		);
		await buyer.page.screenshot({
			path: 'artifacts/delivery-order-tracking.png'
		});
		expect((await (await buyer.api.get('/api/v1/wallet')).json()).balance_minor).toBe(9600);
	} finally {
		await Promise.all([
			seller.context.close(),
			buyer.context.close(),
			driver.context.close(),
			adminContext.close()
		]);
	}
});
