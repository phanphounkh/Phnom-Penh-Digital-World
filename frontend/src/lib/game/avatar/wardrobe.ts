/**
 * The in-game wardrobe's catalogue: what the realistic avatar lets a player change, as wheels.
 * Item wheels choose garments (a hoodie, a t-shirt or a shirt; joggers, jeans or shorts;
 * sneakers or sandals; a cap or a bucket hat; the backpack), colour wheels their colours, on
 * build A or B with their skin tone and hair colour. Pure: every turn of a wheel gives a new
 * avatar (the old one is never changed).
 */
import type { Accessory, Avatar, BottomStyle, ShoeStyle, TopStyle } from '$lib/api/types';
import { CLOTH_COLORS, HAIR_COLORS, SHOE_COLORS, SKIN_TONES, colorName } from './avatar';

export type CategoryId = 'top' | 'bottom' | 'shoes' | 'hat' | 'bag' | 'hair' | 'body';

export interface Category {
	id: CategoryId;
	label: string;
	/** A note under the wheels. */
	note?: string;
}

export interface Choice {
	id: string;
	label: string;
	/** A colour sample for colour wheels. */
	swatch?: string;
	/** Why it cannot be chosen now (the wheel passes over it). */
	blocked?: string;
}

export interface Wheel {
	kind: 'item' | 'colour';
	label: string;
	choices: Choice[];
	value: string;
	/** The avatar with this choice. */
	pick(avatar: Avatar, id: string): Avatar;
}

export const CATEGORIES: Category[] = [
	{ id: 'top', label: 'Top' },
	{ id: 'bottom', label: 'Bottoms' },
	{ id: 'shoes', label: 'Shoes' },
	{ id: 'hat', label: 'Hat', note: 'Same colour as the backpack.' },
	{ id: 'bag', label: 'Backpack', note: "This colour also trims the jacket's panels, the shoes and the hat." },
	{ id: 'hair', label: 'Hair' },
	{ id: 'body', label: 'Body' }
];

const BUILDS = { a: 'Build A', b: 'Build B' } as const;
const HATS = ['cap', 'hat'] as const;

/** The original top's name: build A wears a jacket over the hoodie, build B a hoodie. */
const hoodie = (avatar: Avatar) => (avatar.body === 'b' ? 'Hoodie' : 'Jacket & hoodie');
const TOPS: Record<TopStyle, (a: Avatar) => string> = { hoodie, tee: () => 'T-shirt', shirt: () => 'Shirt' };
const BOTTOMS: Record<BottomStyle, string> = { trousers: 'Joggers', jeans: 'Jeans', shorts: 'Shorts' };
const SHOES: Record<ShoeStyle, string> = { sneakers: 'Sneakers', sandals: 'Sandals' };
const HAT_LABELS = { none: 'No hat', cap: 'Cap', hat: 'Bucket hat' } as const;

/**
 * Ready for the wardrobe: an avatar dressed in garments. One saved before garments existed
 * (model "avatar") is shown in the outfit it wears now: the hoodie (with the jacket on build A),
 * joggers, sneakers and the backpack, no hat. Saving it keeps that look until a wheel turns.
 */
export function dressed(avatar: Avatar): Avatar {
	if (avatar.model === 'outfit') return { ...avatar, shoe_style: avatar.shoe_style ?? 'sneakers' };
	return { ...avatar, model: 'outfit', top_style: 'hoodie', bottom_style: 'trousers', shoe_style: 'sneakers', accessories: ['backpack'] };
}

const hatOf = (a: Avatar): 'none' | 'cap' | 'hat' => (a.accessories.includes('cap') ? 'cap' : a.accessories.includes('hat') ? 'hat' : 'none');
/** Accessories with `item` added or taken away (the old wardrobe's glasses and krama dropped). */
function withAccessory(a: Avatar, remove: readonly Accessory[], add: Accessory | null): Accessory[] {
	const kept = a.accessories.filter((x) => !remove.includes(x) && x !== 'glasses' && x !== 'krama');
	return (add ? [...kept, add] : kept).sort() as Accessory[];
}

function colours(palette: 'cloth' | 'hair' | 'shoe' | 'skin', list: string[], label: string, value: string, field: keyof Avatar): Wheel {
	return {
		kind: 'colour',
		label,
		choices: list.map((c) => ({ id: c, label: colorName(palette, c), swatch: c })),
		value,
		pick: (avatar, id) => ({ ...avatar, [field]: id })
	};
}

function items<T extends string>(label: string, choices: [T, string][], value: T, pick: (a: Avatar, id: T) => Avatar): Wheel {
	return { kind: 'item', label, choices: choices.map(([id, l]) => ({ id, label: l })), value, pick: (a, id) => pick(a, id as T) };
}

/** The wheels of a category for this avatar. */
export function wheels(category: CategoryId, avatar: Avatar): Wheel[] {
	const a = dressed(avatar);
	switch (category) {
		case 'top':
			return [
				items('Style', (Object.keys(TOPS) as TopStyle[]).map((t) => [t, TOPS[t](a)]), a.top_style, (x, id) => ({ ...dressed(x), top_style: id })),
				colours('cloth', CLOTH_COLORS, 'Colour', a.top_color, 'top_color')
			];
		case 'bottom':
			return [
				items('Style', Object.entries(BOTTOMS) as [BottomStyle, string][], a.bottom_style, (x, id) => ({ ...dressed(x), bottom_style: id })),
				colours('cloth', CLOTH_COLORS, 'Colour', a.bottom_color, 'bottom_color')
			];
		case 'shoes':
			return [
				items('Style', Object.entries(SHOES) as [ShoeStyle, string][], a.shoe_style ?? 'sneakers', (x, id) => ({ ...dressed(x), shoe_style: id })),
				colours('shoe', SHOE_COLORS, 'Colour', a.shoe_color, 'shoe_color')
			];
		case 'hat':
			return [
				items('Style', Object.entries(HAT_LABELS) as ['none' | 'cap' | 'hat', string][], hatOf(a), (x, id) => {
					const d = dressed(x);
					return { ...d, accessories: withAccessory(d, HATS, id === 'none' ? null : id) };
				}),
				colours('cloth', CLOTH_COLORS, 'Colour', a.accent_color, 'accent_color')
			];
		case 'bag':
			return [
				items('Wear', [['backpack', 'Backpack'], ['none', 'No backpack']], a.accessories.includes('backpack') ? 'backpack' : 'none', (x, id) => {
					const d = dressed(x);
					return { ...d, accessories: withAccessory(d, ['backpack'], id === 'backpack' ? 'backpack' : null) };
				}),
				colours('cloth', CLOTH_COLORS, 'Colour', a.accent_color, 'accent_color')
			];
		case 'hair':
			return [colours('hair', HAIR_COLORS, 'Colour', a.hair_color, 'hair_color')];
		default:
			return [
				{
					kind: 'item',
					label: 'Build',
					choices: Object.entries(BUILDS).map(([id, label]) => ({ id, label })),
					value: a.body,
					pick: (x, id) => ({ ...dressed(x), body: id as Avatar['body'] })
				},
				colours('skin', SKIN_TONES, 'Skin tone', a.skin_tone, 'skin_tone')
			];
	}
}

const lower = (name: string) => name.toLowerCase().replace('mekong', 'Mekong').replace('t-shirt', 'T-shirt');

/** What is worn in a category, in words ("Jade T-shirt", "No hat"). */
export function describe(category: CategoryId, avatar: Avatar): string {
	const a = dressed(avatar);
	switch (category) {
		case 'top':
			return `${colorName('cloth', a.top_color)} ${lower(a.top_style === 'hoodie' ? (a.body === 'b' ? 'hoodie' : 'jacket') : TOPS[a.top_style](a))}`;
		case 'bottom':
			return `${colorName('cloth', a.bottom_color)} ${lower(BOTTOMS[a.bottom_style])}`;
		case 'shoes':
			return `${colorName('shoe', a.shoe_color)} ${lower(SHOES[a.shoe_style ?? 'sneakers'])}`;
		case 'hat': {
			const hat = hatOf(a);
			return hat === 'none' ? 'No hat' : `${colorName('cloth', a.accent_color)} ${lower(HAT_LABELS[hat])}`;
		}
		case 'bag':
			return a.accessories.includes('backpack') ? `${colorName('cloth', a.accent_color)} backpack` : 'No backpack';
		case 'hair':
			return `${colorName('hair', a.hair_color)} hair`;
		default:
			return `${BUILDS[a.body]}, skin ${lower(colorName('skin', a.skin_tone))}`;
	}
}

/** The whole outfit in one sentence ("Soft black hair, a jade T-shirt, slate jeans, off-white
 * sandals, a saffron cap and a saffron backpack."). */
export function summary(avatar: Avatar): string {
	const a = dressed(avatar);
	const article = (words: string) => `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${lower(words)}`;
	const parts = [article(describe('top', a)), lower(describe('bottom', a)), lower(describe('shoes', a))];
	if (hatOf(a) !== 'none') parts.push(article(describe('hat', a)));
	if (a.accessories.includes('backpack')) parts.push(article(describe('bag', a)));
	const last = parts.pop()!;
	return `${describe('hair', a)}, ${parts.join(', ')} and ${last}.`;
}

/** "Surprise me": a random outfit of garments and colours, on a random build. */
export function randomOutfit(name: string, rand: () => number = Math.random): Avatar {
	const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
	const hat = pick(['none', 'none', 'cap', 'hat'] as const);
	const accessories: Accessory[] = [...(rand() < 0.5 ? (['backpack'] as const) : []), ...(hat === 'none' ? [] : [hat])];
	return {
		avatar_name: name,
		model: 'outfit',
		body: pick(['a', 'b'] as const),
		skin_tone: pick(SKIN_TONES),
		hair_style: 'short',
		hair_color: pick(HAIR_COLORS),
		top_style: pick(['hoodie', 'tee', 'shirt'] as const),
		top_color: pick(CLOTH_COLORS),
		bottom_style: pick(['trousers', 'jeans', 'shorts'] as const),
		bottom_color: pick(CLOTH_COLORS),
		shoe_style: pick(['sneakers', 'sandals'] as const),
		shoe_color: pick(SHOE_COLORS),
		accent_color: pick(CLOTH_COLORS),
		accessories: accessories.sort()
	};
}
