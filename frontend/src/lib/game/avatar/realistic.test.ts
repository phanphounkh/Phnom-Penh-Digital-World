import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR } from './avatar';
import { RECOLOR, hairFactor, kindFor, paletteFills, skinFactor, type RealisticManifest } from './realistic';
import { EMOTE_CLIP } from './RealisticAnimations';
import { EMOTES } from '$lib/game/net/protocol';

const DIR = 'static/models/characters/realistic/';
const manifest: RealisticManifest = JSON.parse(readFileSync(DIR + 'manifest.json', 'utf8'));

/** The glTF JSON chunk of a GLB (meshopt compresses buffers, not the JSON). */
function glbJson(path: string) {
	const buffer = readFileSync(path);
	expect(buffer.toString('ascii', 0, 4)).toBe('glTF');
	const length = buffer.readUInt32LE(12);
	return JSON.parse(buffer.subarray(20, 20 + length).toString());
}

describe('realistic avatar assets (avatar-generator output)', () => {
	for (const kind of ['male', 'female'] as const) {
		const entry = manifest.characters[kind];
		const json = glbJson(DIR + entry.file);
		const nodes: string[] = json.nodes.map((n: { name?: string }) => n.name ?? '');
		const materials: string[] = json.materials.map((m: { name: string }) => m.name);
		const clips: string[] = json.animations.map((a: { name: string }) => a.name);

		it(`${kind}: Mixamo skeleton the game code drives`, () => {
			for (const bone of ['Hips', 'Spine', 'Head', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightArm', 'RightForeArm', 'RightHand'])
				expect(nodes).toContain(`mixamorig:${bone}`);
			expect(json.skins.length).toBeGreaterThan(0);
		});

		it(`${kind}: gait and emote clips`, () => {
			for (const clip of ['Idle', 'Walk', 'Run', ...Object.values(EMOTE_CLIP).map((e) => e.clip)]) expect(clips).toContain(clip);
			expect(entry.clips.sort()).toEqual([...clips].sort());
			for (const emote of EMOTES) expect(clips).toContain(EMOTE_CLIP[emote].clip);
		});

		it(`${kind}: recolourable materials and palette cells`, () => {
			expect(materials).toContain('Skin');
			expect(materials).toContain(`${kind}_game_hair`);
			expect(materials).toContain(`${kind}.Outfit`);
			for (const names of Object.values(RECOLOR[kind]))
				for (const name of names) {
					const cell = entry.palette.cells[name];
					expect(cell, name).toBeDefined();
					expect(cell[0] + entry.palette.cell).toBeLessThanOrEqual(entry.palette.size);
					expect(cell[1] + entry.palette.cell).toBeLessThanOrEqual(entry.palette.size);
				}
		});

		it(`${kind}: measured gait speeds and size are plausible`, () => {
			expect(entry.walk_speed).toBeGreaterThan(1.2);
			expect(entry.walk_speed).toBeLessThan(2.5);
			expect(entry.run_speed).toBeGreaterThan(entry.walk_speed);
			expect(entry.height_m).toBeGreaterThan(1.5);
			expect(entry.height_m).toBeLessThan(1.9);
		});
	}
});

describe('realistic avatar recolouring', () => {
	it('Build A is the male model, Build B the female', () => {
		expect(kindFor({ body: 'a' })).toBe('male');
		expect(kindFor({ body: 'b' })).toBe('female');
	});

	it('paints the palette cells of each colour choice', () => {
		const entry = manifest.characters.male;
		const avatar = { ...DEFAULT_AVATAR, top_color: '#ff0000', bottom_color: '#00ff00', shoe_color: '#0000ff', accent_color: '#ffff00' };
		const fills = paletteFills(entry, avatar);
		const byColour = (c: string) => fills.filter((f) => f[3] === c).length;
		expect(byColour('#ff0000')).toBe(RECOLOR.male.top.length);
		expect(byColour('#00ff00')).toBe(RECOLOR.male.bottom.length);
		expect(byColour('#0000ff')).toBe(RECOLOR.male.shoe.length);
		expect(byColour('#ffff00')).toBe(RECOLOR.male.accent.length);
		const jacket = entry.palette.cells.Jacket;
		expect(fills).toContainEqual([jacket[0], jacket[1], entry.palette.cell, '#ff0000']);
	});

	it('skin tint keeps the baked tone and scales toward lighter or darker tones', () => {
		expect(skinFactor('#b5815f', '#b5815f').every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
		expect(skinFactor('#b5815f', '#5a3824').every((v) => v < 1)).toBe(true);
		expect(skinFactor('#b5815f', '#f1d0b5').every((v) => v > 1 && v <= 1.8)).toBe(true);
	});

	it('hair factor reproduces the colour on the 0.5-grey neutral texture', () => {
		const [r, g, b] = hairFactor('#7a4b2a', 0.5);
		expect(r * 0.5).toBeCloseTo(0.1946, 3); // sRGB 0x7a → linear
		expect(g).toBeLessThan(r);
		expect(b).toBeLessThan(g);
	});
});
