import { expect, it } from 'vitest';
import { qualityDebt } from './quality';

it('detects sustained 20 FPS rather than cancelling the accumulated slow time', () => {
	let debt = 0;
	for (let i = 0; i < 65; i++) debt = qualityDebt(debt, 1/20);
	expect(debt).toBeGreaterThan(3);
});
it('recovers during smooth frames and does not trigger on one long pause', () => {
	let debt = qualityDebt(0, 20);
	expect(debt).toBeLessThan(3);
	for (let i = 0; i < 60; i++) debt = qualityDebt(debt, 1/60);
	expect(debt).toBe(0);
});
