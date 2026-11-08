// Shared by the perf/tour scripts: a reusable, onboarded test account (avoids the
// registration rate limit) that can be moved between spawn points.
const PASSWORD = 'correct-horse-battery';

export async function perfSession(context, USER = 'perfbot') {
	const api = context.request;
	const csrf = async () => ({ 'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'ppw_csrf').value });
	let res = await api.post('/api/v1/auth/login', { data: { identifier: USER, password: PASSWORD } });
	if (!res.ok()) {
		res = await api.post('/api/v1/auth/register', {
			data: { username: USER, email: `${USER}@example.com`, password: PASSWORD, display_name: 'Perf Bot', preferred_language: 'en', accept_terms: true, accept_privacy: true }
		});
		if (!res.ok()) throw new Error(`perfbot registration failed: ${res.status()} ${await res.text()}`);
		const reg = await res.json();
		await api.post('/api/v1/auth/verification/confirm', { data: { code: reg.verification.dev_code }, headers: await csrf() });
		await api.put('/api/v1/me/avatar', { headers: await csrf(), data: { avatar_name: 'Perf Bot', body: 'b', skin_tone: '#a8744f', hair_style: 'bun', hair_color: '#1b1514', top_style: 'tee', top_color: '#e8a33d', bottom_style: 'shorts', bottom_color: '#123b3a', shoe_color: '#c4552f', accent_color: '#c4552f', accessories: ['krama'] } });
		await api.post('/api/v1/me/roles', { headers: await csrf(), data: { roles: [] } });
	}
	const spawns = await (await api.get('/api/v1/geo/spawn-points')).json();
	return {
		async moveTo(slug) {
			const sp = spawns.find((s) => s.slug === slug);
			await api.put('/api/v1/me/spawn', { headers: await csrf(), data: { spawn_point_id: sp.id, world_visible: false } });
			await api.post('/api/v1/me/onboarding/complete', { headers: await csrf() });
		}
	};
}
