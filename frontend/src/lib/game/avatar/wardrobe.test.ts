import { describe, expect, it } from 'vitest';
import type { Avatar } from '$lib/api/types';
import { CLOTH_COLORS, DEFAULT_AVATAR, HAIR_COLORS, SKIN_TONES } from './avatar';
import { CATEGORIES, describe as wearing, summary, wheels } from './wardrobe';

const base: Avatar = { ...DEFAULT_AVATAR, accessories: [] };

describe('the wardrobe', () => {
	it('every category has wheels whose value is one of their choices, named in words', () => {
		expect(CATEGORIES.map((c) => c.id)).toEqual(['top', 'bottom', 'shoes', 'bag', 'hair', 'body']);
		for (const c of CATEGORIES) {
			const list = wheels(c.id, base);
			expect(list.length).toBeGreaterThan(0);
			for (const w of list) {
				expect(w.choices.map((x) => x.id)).toContain(w.value);
				expect(new Set(w.choices.map((x) => x.id)).size).toBe(w.choices.length);
				expect(w.choices.every((x) => x.label && !x.label.startsWith('#'))).toBe(true);
			}
		}
	});

	it('turning a wheel gives a new avatar and leaves the old one as it was', () => {
		const [colour] = wheels('top', base);
		const saffron = colour.pick(base, '#e8a33d');
		expect(saffron.top_color).toBe('#e8a33d');
		expect(base.top_color).not.toBe('#e8a33d');
		expect(wheels('top', saffron)[0].value).toBe('#e8a33d');
	});

	it('each wheel changes its own field', () => {
		expect(wheels('bottom', base)[0].pick(base, CLOTH_COLORS[6]).bottom_color).toBe(CLOTH_COLORS[6]);
		expect(wheels('shoes', base)[0].pick(base, '#3d6fb6').shoe_color).toBe('#3d6fb6');
		expect(wheels('bag', base)[0].pick(base, CLOTH_COLORS[11]).accent_color).toBe(CLOTH_COLORS[11]);
		expect(wheels('hair', base)[0].pick(base, HAIR_COLORS[4]).hair_color).toBe(HAIR_COLORS[4]);
		const [build, skin] = wheels('body', base);
		expect(skin.pick(build.pick(base, 'b'), SKIN_TONES[5])).toMatchObject({ body: 'b', skin_tone: SKIN_TONES[5] });
	});

	it('says what is worn: build A a jacket, build B a hoodie', () => {
		const a: Avatar = { ...base, body: 'a', top_color: '#2f7d6d', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', hair_color: '#2b2220' };
		expect(wearing('top', a)).toBe('Jade jacket');
		expect(wearing('top', { ...a, body: 'b' })).toBe('Jade hoodie');
		expect(wearing('bottom', a)).toBe('Slate trousers');
		expect(wearing('bag', a)).toBe('Saffron backpack');
		expect(summary(a)).toBe('Soft black hair, a jade jacket, slate trousers, off-white shoes and a saffron backpack.');
		// "an" before a vowel.
		expect(summary({ ...a, top_color: '#f6f1e6', accent_color: '#6b4fa0' })).toContain('an ivory jacket, slate trousers, off-white shoes and an orchid backpack.');
	});
});
