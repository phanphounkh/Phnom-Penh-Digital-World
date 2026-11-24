import { describe, expect, it } from 'vitest';
import { Group, Mesh } from 'three';
import { cloudDensity, DaylightClouds } from './DaylightClouds';
import { Sky } from 'three/addons/objects/Sky.js';
import { GRAPHICS_PRESETS, lowerQuality } from './quality';
import { setChunkShadows } from './shadows';

describe('daylight budgets and sky lifecycle', () => {
	it('keeps a bounded, deterministic, nonuniform opaque density atlas', () => {
		const atlas = cloudDensity();
		expect(atlas).toEqual(cloudDensity());
		expect(atlas.length).toBe(128 * 128 * 4);
		const samples = Array.from(atlas).filter((_, i) => i % 4 === 0);
		expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(150);
		expect(
			Array.from(atlas)
				.filter((_, i) => i % 4 === 3)
				.every((a) => a === 255)
		).toBe(true);
	});
	it('fades daylight clouds at night and releases their GPU texture', () => {
		const sky = new Sky(),
			clouds = new DaylightClouds(sky);
		let disposed = false;
		sky.material.uniforms.uPpwCloudMap.value.addEventListener(
			'dispose',
			() => (disposed = true)
		);
		clouds.update(1, 123000);
		expect(clouds.diagnostics()).toMatchObject({
			size: 128,
			day: 0,
			time: 123
		});
		clouds.update(0, 123000);
		expect(clouds.diagnostics().day).toBe(1);
		clouds.dispose();
		expect(disposed).toBe(true);
		sky.geometry.dispose();
		sky.material.dispose();
	});
	it('bounds medium shadows and steps down one preset at a time', () => {
		expect(GRAPHICS_PRESETS.low.shadows).toBe(false);
		expect(GRAPHICS_PRESETS.medium.shadowSize).toBe(1024);
		expect(GRAPHICS_PRESETS.medium.pixelRatio).toBeLessThan(
			GRAPHICS_PRESETS.high.pixelRatio
		);
		expect(GRAPHICS_PRESETS.medium.radius).toBeLessThan(
			GRAPHICS_PRESETS.high.radius
		);
		expect(lowerQuality('high')).toBe('medium');
		expect(lowerQuality('medium')).toBe('low');
	});
});

it('restores eligible casters in already-loaded chunks when leaving Low, without making roads cast shadows', () => {
	const chunk = new Group(),
		tree = new Mesh(),
		road = new Mesh();
	tree.userData.shadowCaster = true;
	road.receiveShadow = true;
	chunk.add(tree, road);
	setChunkShadows(chunk, false);
	expect(tree.castShadow).toBe(false);
	setChunkShadows(chunk, true);
	expect(tree.castShadow).toBe(true);
	expect(road.castShadow).toBe(false);
	expect(road.receiveShadow).toBe(true);
	expect(chunk.userData.shadowEnabled).toBe(true);
	setChunkShadows(chunk, false);
	expect(tree.castShadow).toBe(false);
});
