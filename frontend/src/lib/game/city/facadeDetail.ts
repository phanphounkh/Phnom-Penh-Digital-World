/** Original canvas artwork, not photographs of the mapped buildings. Keeps existing bays,
 * window styles and doorway coordinates. Two pixels per source texel improve nearby detail. */
export function finishFacadeAtlas(
	source: HTMLCanvasElement,
	mask: boolean
): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = source.width * 2;
	canvas.height = source.height * 2;
	const g = canvas.getContext('2d')!;
	g.imageSmoothingEnabled = false;
	g.drawImage(source, 0, 0, canvas.width, canvas.height);
	if (mask) return canvas;
	g.scale(2, 2);
	let seed = 9173;
	const random = () =>
		(seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
	const rect = (colour: string, x: number, y: number, w: number, h: number) => {
		g.fillStyle = colour;
		g.fillRect(x, y, w, h);
	};
	const pane = (
		x: number,
		y: number,
		w: number,
		h: number,
		variant: number
	) => {
		// Inner shadow, reflection gradient and a dim room behind opaque glazing.
		const glass = g.createLinearGradient(x, y, x + w * 0.6, y + h);
		glass.addColorStop(0, '#34444a');
		glass.addColorStop(0.35, '#657e86');
		glass.addColorStop(0.48, '#53666b');
		glass.addColorStop(0.52, '#35494d');
		glass.addColorStop(1, '#202b2c');
		g.fillStyle = glass;
		g.fillRect(x, y, w, h);
		g.save();
		g.beginPath();
		g.rect(x, y, w, h);
		g.clip();
		if (variant % 3 === 0) {
			// Soft curtain folds instead of an identical bright white reflection stripe.
			for (let i = 0; i < w * 0.35; i += 2)
				rect(i % 4 ? '#92958955' : '#c3bc9c55', x + i, y, 1.5, h);
		} else {
			g.fillStyle = '#bed6dd28';
			g.beginPath();
			g.moveTo(x + w * 0.12, y);
			g.lineTo(x + w * 0.38, y);
			g.lineTo(x + w * 0.76, y + h);
			g.lineTo(x + w * 0.56, y + h);
			g.fill();
		}
		// Reflected distant roofline: visual suggestion only, not real geometry or a live reflection.
		for (let i = 0; i < 6; i++) {
			const top = y + h * (0.58 + random() * 0.16);
			rect('#15282b28', x + (i * w) / 6, top, w / 6, y + h - top);
		}
		g.restore();
		rect('#121d2399', x, y, w, 2.5);
		rect('#17232788', x, y, 1.5, h);
		rect('#b7c4c34d', x, y + h - 1, w, 0.8);
	};
	for (let bay = 0; bay < 6; bay++) {
		const x = bay * 128;
		// Fine stucco and subtle paint wear are baked once, not sampled as fragment noise.
		for (let i = 0; i < 4500; i++) {
			const px = x + random() * 128,
				py = random() * 128;
			rect(
				random() > 0.5 ? '#ffffff13' : '#302a2014',
				px,
				py,
				0.5 + random(),
				0.5
			);
		}
		// Narrow contact shade under the floor slab and a sunlit moulding edge.
		const shade = g.createLinearGradient(0, 116, 0, 127);
		shade.addColorStop(0, '#3e342500');
		shade.addColorStop(0.3, '#3e342520');
		shade.addColorStop(1, '#3e342540');
		g.fillStyle = shade;
		g.fillRect(x, 116, 128, 11);
		rect('#ffffff66', x, 118, 128, 0.7);
		if (bay === 0) {
			rect('#b8b6af', x + 25, 19, 78, 76);
			pane(x + 29, 23, 33, 68, 0);
			pane(x + 66, 23, 33, 68, 1);
			rect('#293337', x + 62, 22, 4, 70);
		} else if (bay === 1) {
			pane(x + 49, 19, 14, 78, 0);
			pane(x + 66, 19, 13, 78, 1);
			for (const sx of [32, 80]) {
				const shutter = g.createLinearGradient(x + sx, 0, x + sx + 16, 0);
				shutter.addColorStop(0, '#294d46');
				shutter.addColorStop(0.3, '#598377');
				shutter.addColorStop(1, '#325e54');
				g.fillStyle = shutter;
				g.fillRect(x + sx, 18, 16, 80);
				for (let y = 22; y < 96; y += 4) {
					rect('#183b3299', x + sx + 2, y, 12, 1);
					rect('#a5bca44d', x + sx + 2, y + 1, 12, 0.6);
				}
			}
		} else if (bay === 2) {
			pane(x + 42, 14, 21, 64, 0);
			pane(x + 65, 14, 21, 64, 1);
			// Preserve the original rail positions; give the metal a slim highlight.
			for (let i = 8; i < 122; i += 7) rect('#a0a19655', x + i, 83, 0.6, 23);
			for (const sx of [20, 108]) {
				// Smaller irregular foliage clusters soften the old circular pot silhouettes.
				rect('#ffffff', x + sx - 9, 66, 18, 10);
				for (let i = 0; i < 24; i++) {
					g.fillStyle = ['#4f6337', '#647b43', '#3d512a'][i % 3];
					g.beginPath();
					g.ellipse(
						x + sx + (random() - 0.5) * 14,
						74 - random() * 6,
						1 + random() * 2,
						1.2,
						random() * 3,
						0,
						Math.PI * 2
					);
					g.fill();
				}
			}
		} else if (bay === 3) {
			pane(x + 28, 34, 34, 48, 0);
			pane(x + 66, 34, 34, 48, 1);
		} else if (bay === 4) {
			// A shaded fictional shop interior with side walls, shelving and a tiled threshold.
			const room = g.createLinearGradient(0, 62, 0, 128);
			room.addColorStop(0, '#1c2525');
			room.addColorStop(1, '#514d40');
			g.fillStyle = room;
			g.fillRect(x + 8, 62, 112, 66);
			rect('#605c4b', x + 18, 70, 32, 47);
			rect('#343b34', x + 78, 70, 31, 46);
			for (let y = 78; y < 117; y += 13) {
				rect('#96846a', x + 18, y, 32, 1.5);
				rect('#746954', x + 78, y, 31, 1.5);
				for (let i = 0; i < 5; i++)
					rect(
						['#8a7558', '#52665d', '#9b9879'][i % 3],
						x + 20 + i * 5,
						y - 7,
						3,
						6
					);
			}
			rect('#b9b09c', x + 8, 125, 112, 3);
		} else {
			pane(x + 10, 48, 44, 70, 1);
			pane(x + 74, 48, 44, 70, 0);
			// Fabric folds, valance shade and a thin handle; no added doorway or collision.
			const awning = g.createLinearGradient(0, 20, 0, 39);
			awning.addColorStop(0, '#00000030');
			awning.addColorStop(0.45, '#ffffff28');
			awning.addColorStop(1, '#00000070');
			g.fillStyle = awning;
			g.fillRect(x, 20, 128, 18);
			rect('#29261e66', x + 6, 39, 116, 3);
			rect('#a99971', x + 68, 86, 1, 9);
		}
	}
	return canvas;
}

/** Approximate recess depth, not extrusion of the mapped building footprint. */
export function facadeHeightAtlas(glass: HTMLCanvasElement): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = glass.width;
	canvas.height = glass.height;
	const g = canvas.getContext('2d')!;
	g.fillStyle = '#b8b8b8';
	g.fillRect(0, 0, canvas.width, canvas.height);
	g.globalCompositeOperation = 'difference';
	g.globalAlpha = 0.55;
	g.drawImage(glass, 0, 0);
	g.globalAlpha = 1;
	g.globalCompositeOperation = 'source-over';
	return canvas;
}

/** Seamless monochrome aggregate: generated once, shared by every street material.
 * A filtered texture fetch replaces fragment noise on integrated graphics. */
export function streetGrainCanvas(): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 256;
	const g = canvas.getContext('2d')!,
		data = g.createImageData(256, 256);
	const hash = (x: number, y: number) => {
		let n = Math.imul(x + 17, 374761393) ^ Math.imul(y + 31, 668265263);
		n = Math.imul(n ^ (n >>> 13), 1274126177);
		return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
	};
	const noise = (x: number, y: number, period: number) => {
		const ix = Math.floor(x),
			iy = Math.floor(y);
		const fx = x - ix,
			fy = y - iy,
			u = fx * fx * (3 - 2 * fx),
			v = fy * fy * (3 - 2 * fy);
		const a = hash(ix % period, iy % period),
			b = hash((ix + 1) % period, iy % period);
		const c = hash(ix % period, (iy + 1) % period),
			d = hash((ix + 1) % period, (iy + 1) % period);
		return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
	};
	for (let y = 0; y < 256; y++)
		for (let x = 0; x < 256; x++) {
			const value = Math.round(
				255 *
					(0.5 +
						(hash(x, y) - 0.5) * 0.32 +
						(noise(x / 32, y / 32, 8) - 0.5) * 0.22 +
						(noise(x / 128, y / 128, 2) - 0.5) * 0.12)
			);
			const i = (y * 256 + x) * 4;
			data.data[i] = data.data[i + 1] = data.data[i + 2] = value;
			data.data[i + 3] = 255;
		}
	g.putImageData(data, 0, 0);
	return canvas;
}
