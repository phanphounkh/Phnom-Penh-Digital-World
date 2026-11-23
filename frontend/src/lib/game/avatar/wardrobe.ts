/**
 * The in-game wardrobe's catalogue: what the realistic avatar lets a player change, as wheels.
 * It wears one outfit (a jacket or hoodie, trousers, shoes and a backpack) in the player's
 * colours, on build A or B, with their skin tone and hair colour. Pure: every turn of a wheel
 * gives a new avatar (the old one is never changed). New garments (shirts, jeans, hats, other
 * shoes) need new realistic models first, then become item wheels here.
 */
import type { Avatar } from '$lib/api/types';
import { CLOTH_COLORS, HAIR_COLORS, SHOE_COLORS, SKIN_TONES, colorName } from './avatar';

export type CategoryId = 'top' | 'bottom' | 'shoes' | 'bag' | 'hair' | 'body';

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
	{ id: 'bottom', label: 'Trousers' },
	{ id: 'shoes', label: 'Shoes' },
	{ id: 'bag', label: 'Backpack', note: "This colour also trims the top's panels and the shoes." },
	{ id: 'hair', label: 'Hair' },
	{ id: 'body', label: 'Body' }
];

const BUILDS = { a: 'Build A', b: 'Build B' } as const;

function colours(palette: 'cloth' | 'hair' | 'shoe' | 'skin', list: string[], label: string, value: string, field: keyof Avatar): Wheel {
	return {
		kind: 'colour',
		label,
		choices: list.map((c) => ({ id: c, label: colorName(palette, c), swatch: c })),
		value,
		pick: (avatar, id) => ({ ...avatar, [field]: id })
	};
}

/** The wheels of a category for this avatar. */
export function wheels(category: CategoryId, avatar: Avatar): Wheel[] {
	switch (category) {
		case 'top':
			return [colours('cloth', CLOTH_COLORS, 'Colour', avatar.top_color, 'top_color')];
		case 'bottom':
			return [colours('cloth', CLOTH_COLORS, 'Colour', avatar.bottom_color, 'bottom_color')];
		case 'shoes':
			return [colours('shoe', SHOE_COLORS, 'Colour', avatar.shoe_color, 'shoe_color')];
		case 'bag':
			return [colours('cloth', CLOTH_COLORS, 'Colour', avatar.accent_color, 'accent_color')];
		case 'hair':
			return [colours('hair', HAIR_COLORS, 'Colour', avatar.hair_color, 'hair_color')];
		default:
			return [
				{
					kind: 'item',
					label: 'Build',
					choices: Object.entries(BUILDS).map(([id, label]) => ({ id, label })),
					value: avatar.body,
					pick: (a, id) => ({ ...a, body: id as Avatar['body'] })
				},
				colours('skin', SKIN_TONES, 'Skin tone', avatar.skin_tone, 'skin_tone')
			];
	}
}

const lower = (name: string) => name.toLowerCase().replace('mekong', 'Mekong');
/** Build A wears a jacket, build B a hoodie. */
const top = (avatar: Avatar) => (avatar.body === 'b' ? 'hoodie' : 'jacket');

/** What is worn in a category, in words ("Jade jacket"). */
export function describe(category: CategoryId, avatar: Avatar): string {
	switch (category) {
		case 'top':
			return `${colorName('cloth', avatar.top_color)} ${top(avatar)}`;
		case 'bottom':
			return `${colorName('cloth', avatar.bottom_color)} trousers`;
		case 'shoes':
			return `${colorName('shoe', avatar.shoe_color)} shoes`;
		case 'bag':
			return `${colorName('cloth', avatar.accent_color)} backpack`;
		case 'hair':
			return `${colorName('hair', avatar.hair_color)} hair`;
		default:
			return `${BUILDS[avatar.body]}, skin ${lower(colorName('skin', avatar.skin_tone))}`;
	}
}

/** The whole outfit in one sentence ("Soft black hair, a jade jacket, slate trousers, off-white
 * shoes and a saffron backpack."). */
export function summary(avatar: Avatar): string {
	const a = (words: string) => `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${lower(words)}`;
	return `${describe('hair', avatar)}, ${a(describe('top', avatar))}, ${lower(describe('bottom', avatar))}, ${lower(describe('shoes', avatar))} and ${a(describe('bag', avatar))}.`;
}
