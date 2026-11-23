/**
 * The in-game wardrobe's catalogue: categories of things to wear, and for each one or two wheels
 * (the item, and its colour) built from the avatar's options. Pure: the UI turns the wheels, and
 * every turn gives a new avatar (the old one is never changed).
 */
import type { Accessory, Avatar } from '$lib/api/types';
import { CLOTH_COLORS, HAIR_COLORS, SHOE_COLORS, SKIN_TONES, colorName } from './avatar';

export type CategoryId = 'top' | 'bottom' | 'shoes' | 'hat' | 'glasses' | 'bag' | 'scarf' | 'hair' | 'body';

export interface Category {
	id: CategoryId;
	label: string;
	/** The item wheel changes nothing in the realistic look (it wears one outfit in your colours). */
	classicOnly: boolean;
	/** A note under the wheels. */
	note?: string;
}

export interface Choice {
	id: string;
	label: string;
	/** A colour sample for colour wheels. */
	swatch?: string;
	/** Why it cannot be chosen now. */
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

/** At most this many extras at once (hat, glasses, bag, scarf); the server checks it too. */
export const MAX_EXTRAS = 3;
const EXTRA_COLOURS = CLOTH_COLORS.slice(0, 6);
const SHARED = 'The hat, bag and scarf share this colour.';

export const CATEGORIES: Category[] = [
	{ id: 'top', label: 'Top', classicOnly: true },
	{ id: 'bottom', label: 'Bottom', classicOnly: true },
	{ id: 'shoes', label: 'Shoes', classicOnly: false },
	{ id: 'hat', label: 'Hat', classicOnly: true, note: SHARED },
	{ id: 'glasses', label: 'Glasses', classicOnly: true },
	{ id: 'bag', label: 'Bag', classicOnly: true, note: SHARED },
	{ id: 'scarf', label: 'Scarf', classicOnly: true, note: SHARED },
	{ id: 'hair', label: 'Hair', classicOnly: true },
	{ id: 'body', label: 'Body', classicOnly: false }
];

const EXTRA: Partial<Record<CategoryId, { accessory: Accessory; none: string; label: string }>> = {
	hat: { accessory: 'cap', none: 'No hat', label: 'Cap' },
	glasses: { accessory: 'glasses', none: 'No glasses', label: 'Glasses' },
	bag: { accessory: 'backpack', none: 'No bag', label: 'Backpack' },
	scarf: { accessory: 'krama', none: 'No scarf', label: 'Krama scarf' }
};

const TOPS = { tee: 'T-shirt', hoodie: 'Hoodie' } as const;
const BOTTOMS = { trousers: 'Trousers', shorts: 'Shorts' } as const;
const HAIRS = { short: 'Short', long: 'Long', bun: 'Bun', buzz: 'Buzz cut' } as const;
const BUILDS = { a: 'Build A', b: 'Build B' } as const;

const options = <K extends string>(labels: Record<K, string>): Choice[] => (Object.entries(labels) as [K, string][]).map(([id, label]) => ({ id, label }));

function colours(palette: 'cloth' | 'hair' | 'shoe' | 'skin', list: string[], label: string, value: string, field: keyof Avatar): Wheel {
	return {
		kind: 'colour',
		label,
		choices: list.map((c) => ({ id: c, label: colorName(palette, c), swatch: c })),
		value,
		pick: (avatar, id) => ({ ...avatar, [field]: id })
	};
}

/** The wheels of a category for this avatar: the item (if there is a choice) and its colour. */
export function wheels(category: CategoryId, avatar: Avatar): Wheel[] {
	const extra = EXTRA[category];
	if (extra) {
		const wearing = avatar.accessories.includes(extra.accessory);
		const full = !wearing && avatar.accessories.length >= MAX_EXTRAS;
		const item: Wheel = {
			kind: 'item',
			label: category === 'glasses' ? 'Glasses' : extra.label,
			choices: [
				{ id: 'none', label: extra.none },
				{ id: extra.accessory, label: extra.label, blocked: full ? `Up to ${MAX_EXTRAS} extras: take one off first` : undefined }
			],
			value: wearing ? extra.accessory : 'none',
			pick: (a, id) => ({
				...a,
				accessories: id === 'none' ? a.accessories.filter((x) => x !== extra.accessory) : a.accessories.includes(extra.accessory) || a.accessories.length >= MAX_EXTRAS ? a.accessories : [...a.accessories, extra.accessory]
			})
		};
		return category === 'glasses' ? [item] : [item, colours('cloth', EXTRA_COLOURS, 'Colour', avatar.accent_color, 'accent_color')];
	}
	switch (category) {
		case 'top':
			return [
				{ kind: 'item', label: 'Top', choices: options(TOPS), value: avatar.top_style, pick: (a, id) => ({ ...a, top_style: id as Avatar['top_style'] }) },
				colours('cloth', CLOTH_COLORS, 'Colour', avatar.top_color, 'top_color')
			];
		case 'bottom':
			return [
				{ kind: 'item', label: 'Bottom', choices: options(BOTTOMS), value: avatar.bottom_style, pick: (a, id) => ({ ...a, bottom_style: id as Avatar['bottom_style'] }) },
				colours('cloth', CLOTH_COLORS, 'Colour', avatar.bottom_color, 'bottom_color')
			];
		case 'shoes':
			return [colours('shoe', SHOE_COLORS, 'Shoes', avatar.shoe_color, 'shoe_color')];
		case 'hair':
			return [
				{ kind: 'item', label: 'Style', choices: options(HAIRS), value: avatar.hair_style, pick: (a, id) => ({ ...a, hair_style: id as Avatar['hair_style'] }) },
				colours('hair', HAIR_COLORS, 'Colour', avatar.hair_color, 'hair_color')
			];
		default:
			return [
				{ kind: 'item', label: 'Build', choices: options(BUILDS), value: avatar.body, pick: (a, id) => ({ ...a, body: id as Avatar['body'] }) },
				colours('skin', SKIN_TONES, 'Skin tone', avatar.skin_tone, 'skin_tone')
			];
	}
}

const lower = (name: string) => name.toLowerCase().replace('mekong', 'Mekong');

/** What is worn in a category, in words ("Jade T-shirt", "No hat"). */
export function describe(category: CategoryId, avatar: Avatar): string {
	const extra = EXTRA[category];
	if (extra) {
		if (!avatar.accessories.includes(extra.accessory)) return extra.none;
		return category === 'glasses' ? 'Glasses' : `${colorName('cloth', avatar.accent_color)} ${lower(extra.label)}`;
	}
	switch (category) {
		case 'top':
			return `${colorName('cloth', avatar.top_color)} ${lower(TOPS[avatar.top_style])}`;
		case 'bottom':
			return `${colorName('cloth', avatar.bottom_color)} ${lower(BOTTOMS[avatar.bottom_style])}`;
		case 'shoes':
			return `${colorName('shoe', avatar.shoe_color)} shoes`;
		case 'hair':
			return `${HAIRS[avatar.hair_style]}, ${lower(colorName('hair', avatar.hair_color))}`;
		default:
			return `${BUILDS[avatar.body]}, skin ${lower(colorName('skin', avatar.skin_tone))}`;
	}
}
