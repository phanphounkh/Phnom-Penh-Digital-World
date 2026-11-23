import { describe, expect, it } from 'vitest';
import type { Avatar } from '$lib/api/types';
import { CLOTH_COLORS, DEFAULT_AVATAR, HAIR_COLORS, SKIN_TONES } from './avatar';
import { CATEGORIES, describe as wearing, dressed, randomOutfit, summary, wheels } from './wardrobe';

/** An avatar saved before garments existed (model "avatar"): it wears the original outfit. */
const base: Avatar = { ...DEFAULT_AVATAR, accessories: [] };
const pick = (avatar: Avatar, category: Parameters<typeof wheels>[0], id: string, wheel = 0) => wheels(category, avatar)[wheel].pick(avatar, id);

describe('the wardrobe', () => {
	it('every category has wheels whose value is one of their choices, named in words', () => {
		expect(CATEGORIES.map((c) => c.id)).toEqual(['top', 'bottom', 'shoes', 'hat', 'bag', 'hair', 'body']);
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

	it('opens an avatar saved before garments in the outfit it wears now', () => {
		const d = dressed({ ...base, top_style: 'tee', bottom_style: 'shorts', accessories: ['cap', 'glasses'] });
		expect(d).toMatchObject({ model: 'outfit', top_style: 'hoodie', bottom_style: 'trousers', shoe_style: 'sneakers', accessories: ['backpack'] });
		expect(wheels('top', base)[0].value).toBe('hoodie');
		expect(wheels('hat', base)[0].value).toBe('none');
		expect(wheels('bag', base)[0].value).toBe('backpack');
		// Already dressed: unchanged.
		expect(dressed(d)).toEqual(d);
	});

	it('item wheels choose garments', () => {
		const tee = pick(base, 'top', 'tee');
		expect(tee).toMatchObject({ model: 'outfit', top_style: 'tee', bottom_style: 'trousers', accessories: ['backpack'] });
		expect(pick(tee, 'bottom', 'jeans').bottom_style).toBe('jeans');
		expect(pick(tee, 'shoes', 'sandals').shoe_style).toBe('sandals');
		const cap = pick(tee, 'hat', 'cap');
		expect(cap.accessories).toEqual(['backpack', 'cap']);
		expect(pick(cap, 'hat', 'hat').accessories).toEqual(['backpack', 'hat']); // one hat at a time
		expect(pick(cap, 'hat', 'none').accessories).toEqual(['backpack']);
		expect(pick(cap, 'bag', 'none').accessories).toEqual(['cap']);
		expect(pick(pick(cap, 'bag', 'none'), 'bag', 'backpack').accessories).toEqual(['backpack', 'cap']);
	});

	it('turning a wheel gives a new avatar and leaves the old one as it was', () => {
		const [, colour] = wheels('top', base);
		const saffron = colour.pick(base, '#e8a33d');
		expect(saffron.top_color).toBe('#e8a33d');
		expect(base.top_color).not.toBe('#e8a33d');
		expect(wheels('top', saffron)[1].value).toBe('#e8a33d');
	});

	it('each colour wheel changes its own field', () => {
		expect(pick(base, 'bottom', CLOTH_COLORS[6], 1).bottom_color).toBe(CLOTH_COLORS[6]);
		expect(pick(base, 'shoes', '#3d6fb6', 1).shoe_color).toBe('#3d6fb6');
		expect(pick(base, 'bag', CLOTH_COLORS[11], 1).accent_color).toBe(CLOTH_COLORS[11]);
		expect(pick(base, 'hat', CLOTH_COLORS[11], 1).accent_color).toBe(CLOTH_COLORS[11]);
		expect(pick(base, 'hair', HAIR_COLORS[4]).hair_color).toBe(HAIR_COLORS[4]);
		const [build, skin] = wheels('body', base);
		expect(skin.pick(build.pick(base, 'b'), SKIN_TONES[5])).toMatchObject({ body: 'b', skin_tone: SKIN_TONES[5] });
	});

	it('says what is worn', () => {
		const a: Avatar = { ...base, body: 'a', top_color: '#2f7d6d', bottom_color: '#343b4a', shoe_color: '#eee5d5', accent_color: '#e8a33d', hair_color: '#2b2220' };
		// The original outfit: build A a jacket, build B a hoodie.
		expect(wearing('top', a)).toBe('Jade jacket');
		expect(wearing('top', { ...a, body: 'b' })).toBe('Jade hoodie');
		expect(wearing('bottom', a)).toBe('Slate joggers');
		expect(wearing('hat', a)).toBe('No hat');
		expect(wearing('bag', a)).toBe('Saffron backpack');
		expect(summary(a)).toBe('Soft black hair, a jade jacket, slate joggers, off-white sneakers and a saffron backpack.');
		const b = pick(pick(pick(pick(pick(a, 'top', 'tee'), 'bottom', 'jeans'), 'shoes', 'sandals'), 'hat', 'cap'), 'bag', 'none');
		expect(wearing('top', b)).toBe('Jade T-shirt');
		expect(wearing('hat', b)).toBe('Saffron cap');
		expect(wearing('bag', b)).toBe('No backpack');
		expect(summary(b)).toBe('Soft black hair, a jade T-shirt, slate jeans, off-white sandals and a saffron cap.');
		// "an" before a vowel.
		expect(summary({ ...a, top_color: '#f6f1e6', accent_color: '#6b4fa0' })).toContain('an ivory jacket, slate joggers, off-white sneakers and an orchid backpack.');
	});
});

describe('surprise me', () => {
	it('is a whole outfit of garments, every wheel on one of its choices', () => {
		let seed = 7;
		const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		for (let i = 0; i < 30; i++) {
			const a = randomOutfit('Sokha', rand);
			expect(a.model).toBe('outfit');
			expect(a.accessories.filter((x) => x === 'cap' || x === 'hat').length).toBeLessThanOrEqual(1);
			for (const c of CATEGORIES)
				for (const w of wheels(c.id, a)) expect(w.choices.map((x) => x.id)).toContain(w.value);
		}
	});
});
