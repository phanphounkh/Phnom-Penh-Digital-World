/** Original CC0-1.0 procedural ground artwork. Packed channels: luminance, normal X,
 * normal Z, roughness. A 2 m repeat suggests short ground cover; it is not a plant survey. */
export function groundTextureData(size = 256): Uint8Array {
	if (!Number.isInteger(size) || size < 32 || size > 512 || size & (size - 1))
		throw new Error('Ground texture must be a power of two from 32 to 512');
	const height = new Float32Array(size * size);
	let seed = 17319;
	const random = () =>
		(seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
	const index = (x: number, y: number) =>
		((y + size) % size) * size + ((x + size) % size);
	for (let i = 0; i < height.length; i++) height[i] = 0.28 + random() * 0.16;
	// Interleaved, bent short fibres, wrapped across the tile so no seam is introduced.
	for (let blade = 0; blade < (size * size) / 10; blade++) {
		const x = random() * size,
			y = random() * size,
			angle = random() * Math.PI * 2;
		const length = ((4 + random() * 12) * size) / 256,
			bend = (random() - 0.5) * 4;
		const brightness = 0.55 + random() * 0.4;
		for (let step = 0; step <= Math.ceil(length); step++) {
			const t = step / Math.ceil(length),
				curve = Math.sin(t * Math.PI) * bend;
			const px = Math.floor(
				x + Math.cos(angle) * length * t - Math.sin(angle) * curve
			);
			const py = Math.floor(
				y + Math.sin(angle) * length * t + Math.cos(angle) * curve
			);
			const i = index(px, py);
			height[i] = Math.max(
				height[i],
				brightness * (0.7 + 0.3 * Math.sin(Math.PI * t))
			);
		}
	}
	const data = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const h = height[index(x, y)],
				i = (y * size + x) * 4;
			data[i] = Math.round(h * 255);
			// Bounded slopes avoid noisy sparkle; encoded normals are filtered with mipmaps.
			data[i + 1] = Math.round(
				128 + (height[index(x - 1, y)] - height[index(x + 1, y)]) * 54
			);
			data[i + 2] = Math.round(
				128 + (height[index(x, y - 1)] - height[index(x, y + 1)]) * 54
			);
			data[i + 3] = Math.round(222 + (1 - h) * 30);
		}
	return data;
}
