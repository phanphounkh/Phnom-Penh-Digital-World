import { expect, it } from 'vitest';
import { npcFaceFor, npcSeed, npcWalkSpeed } from './npcIdentity';
it('selects stable NPC-only faces independently of body choice and varies walking speed', () => {
	const faces = new Set<string>(),
		speeds = new Set<number>();
	for (let i = 0; i < 100; i++) {
		const id = `person-${i}`;
		expect(npcSeed(id)).toBe(npcSeed(id));
		expect(npcFaceFor(id)).toBe(npcFaceFor(id));
		faces.add(npcFaceFor(id));
		speeds.add(npcWalkSpeed(id));
		expect(npcWalkSpeed(id)).toBeGreaterThanOrEqual(0.78);
		expect(npcWalkSpeed(id)).toBeLessThanOrEqual(1.22);
	}
	expect(faces.size).toBe(2);
	expect(speeds.size).toBeGreaterThan(10);
});
