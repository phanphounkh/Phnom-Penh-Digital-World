/** NPC-only identity; player construction never passes this option. */
export function npcSeed(id: string): number {
	let h = 2166136261;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
export function npcFaceFor(id: string): 'broad' | 'slender' {
	return (npcSeed(id) >>> 11) & 1 ? 'broad' : 'slender';
}
export function npcWalkSpeed(id: string): number {
	return 0.78 + ((npcSeed(id) >>> 5) % 45) / 100;
}
