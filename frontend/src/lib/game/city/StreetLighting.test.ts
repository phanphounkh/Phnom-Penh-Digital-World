import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StreetLighting } from './StreetLighting';
import type { ChunkManager } from './ChunkManager';

describe('nearby street lighting', () => {
	it('uses four nearby heads and disables their light by day or in performance mode', () => {
		const scene = new THREE.Scene();
		const chunks = { version: 1, lampPositions: () => [3, 6, 9, 12, 50].map(x => new THREE.Vector3(x, 8, 0)) } as unknown as ChunkManager;
		const lighting = new StreetLighting(scene, chunks);
		lighting.update(1, 0, 0, 1, true);
		const lights = scene.children as THREE.PointLight[];
		expect(lights).toHaveLength(4);
		expect(lights.map(l => l.position.x)).toEqual([3, 6, 9, 12]);
		expect(lights.every(l => l.intensity > 0)).toBe(true);
		lighting.update(1, 0, 0, 0, true);
		expect(lights.every(l => l.intensity === 0)).toBe(true);
		lighting.update(1, 0, 0, 1, false);
		expect(lights.every(l => l.intensity === 0)).toBe(true);
		lighting.dispose();
		expect(scene.children).toHaveLength(0);
	});
	it('drops lamp positions when their chunks unload', () => {
		const scene = new THREE.Scene();
		const chunks = { version: 1, lampPositions: () => [new THREE.Vector3(0, 8, 0)] };
		const lighting = new StreetLighting(scene, chunks as unknown as ChunkManager);
		lighting.update(1, 0, 0, 1, true);
		expect((scene.children[0] as THREE.PointLight).intensity).toBeGreaterThan(0);
		chunks.version++;
		chunks.lampPositions = () => [];
		lighting.update(1, 0, 0, 1, true);
		expect((scene.children[0] as THREE.PointLight).intensity).toBe(0);
		lighting.dispose();
	});
});

it('removes inactive lights from rendering and respects the Medium budget', () => {
	const scene = new THREE.Scene();
	const chunks = { version: 1, lampPositions: () => [1,2,3,4].map(x=>new THREE.Vector3(x,8,0)) };
	const lighting = new StreetLighting(scene, chunks as unknown as ChunkManager);
	expect(scene.children.every(l=>!l.visible)).toBe(true);
	lighting.update(1,0,0,1,true,2);
	expect(scene.children.filter(l=>l.visible)).toHaveLength(2);
	lighting.update(1,0,0,0,true,2);
	expect(scene.children.every(l=>!l.visible)).toBe(true);
	lighting.dispose();
});
