import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR, SKIN_TONES, optionOf, randomAvatar, selectedOptions } from './avatar';

/** Node names inside the GLB, as Three.js's GLTFLoader will name them (sanitised). */
function glbNodeNames(path: string): string[] {
	const buffer = readFileSync(path);
	const jsonLength = buffer.readUInt32LE(12);
	const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString());
	// PropertyBinding.sanitizeNodeName: whitespace → _, reserved chars removed.
	return json.nodes.map((n: { name?: string }) =>
		(n.name ?? '').replace(/\s/g, '_').replace(/[[\].:/]/g, '')
	);
}

const GLB = 'static/models/characters/avatar.glb';

describe('avatar options', () => {
	it('parses option node names, including Blender duplicate suffixes', () => {
		expect(optionOf('opt__acc-glasses__rim001')).toBe('acc-glasses');
		expect(optionOf('opt__top-tee__forearm')).toBe('top-tee');
		expect(optionOf('LeftArm')).toBeNull();
	});

	it('selects exactly one option per group plus accessories', () => {
		const s = selectedOptions({ ...DEFAULT_AVATAR, accessories: ['cap', 'krama'] });
		expect([...s].sort()).toEqual(
			['acc-cap', 'acc-krama', 'body-a', 'bottom-trousers', 'hair-short', 'top-tee'].sort()
		);
	});

	it('random avatars are valid', () => {
		let seed = 7;
		const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		for (let i = 0; i < 50; i++) {
			const a = randomAvatar('Test', rand);
			expect(SKIN_TONES).toContain(a.skin_tone);
			expect(a.accessories.length).toBeLessThanOrEqual(3);
			expect(new Set(a.accessories).size).toBe(a.accessories.length);
		}
	});
});

describe('avatar.glb (Blender asset)', () => {
	const names = glbNodeNames(GLB);
	const options = new Set(names.map(optionOf).filter(Boolean));

	it('contains every option the UI and API offer', () => {
		const expected = [
			'body-a', 'body-b', 'top-hoodie', 'top-tee', 'bottom-trousers', 'bottom-shorts',
			'hair-short', 'hair-long', 'hair-bun', 'hair-buzz',
			'acc-cap', 'acc-glasses', 'acc-backpack', 'acc-krama'
		];
		for (const option of expected) expect(options).toContain(option);
	});

	it('keeps the animation rig used by PlayerAnimations', () => {
		for (const joint of ['BodyRoot', 'LeftLeg', 'LeftKnee', 'LeftAnkle', 'RightArm', 'RightElbow', 'RightWrist'])
			expect(names).toContain(joint);
	});

	it('has semantic, recolourable materials', () => {
		const buffer = readFileSync(GLB);
		const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
		const materials = json.materials.map((m: { name: string }) => m.name);
		for (const name of ['Skin', 'Hair', 'Top', 'Bottom', 'Shoes', 'Accent']) expect(materials).toContain(name);
	});
});
