import { afterEach, describe, expect, it, vi } from 'vitest';
import { STYLE_KEY, loadAvatarStyle, saveAvatarStyle } from './character';

function fakeStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
		removeItem: (k: string) => void data.delete(k)
	};
}

describe('avatar style preference', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('defaults to realistic and remembers the choice', () => {
		vi.stubGlobal('localStorage', fakeStorage());
		expect(loadAvatarStyle()).toBe('realistic');
		saveAvatarStyle('classic');
		expect(localStorage.getItem(STYLE_KEY)).toBe('classic');
		expect(loadAvatarStyle()).toBe('classic');
	});

	it('ignores unknown values and blocked storage', () => {
		vi.stubGlobal('localStorage', { ...fakeStorage(), getItem: () => 'cartoon' });
		expect(loadAvatarStyle()).toBe('realistic');
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		});
		expect(loadAvatarStyle()).toBe('realistic');
		expect(() => saveAvatarStyle('classic')).not.toThrow();
	});
});
