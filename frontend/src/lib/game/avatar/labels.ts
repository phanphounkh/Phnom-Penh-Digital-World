/**
 * Floating labels over people in the city: name tags and speech bubbles, drawn on a canvas into
 * a sprite (always facing the camera). Shared by other players and the shopkeepers.
 */
import * as THREE from 'three';

export interface LabelLine {
	text: string;
	font: string;
	color: string;
}

/** A rounded label with one or more centred lines; ~0.0075 m per canvas pixel. */
export function roundedLabel(lines: LabelLine[], bg: string, pad = 22): THREE.Sprite {
	const c = document.createElement('canvas');
	const g = c.getContext('2d')!;
	const widths = lines.map((l) => {
		g.font = l.font;
		return g.measureText(l.text).width;
	});
	const lineH = 44;
	c.width = Math.ceil(Math.max(...widths) + pad * 2);
	c.height = lineH * lines.length + pad;
	g.fillStyle = bg;
	g.beginPath();
	g.roundRect(0, 0, c.width, c.height, 22);
	g.fill();
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	lines.forEach((l, i) => {
		g.font = l.font;
		g.fillStyle = l.color;
		g.fillText(l.text, c.width / 2, pad / 2 + lineH * (i + 0.5));
	});
	const texture = new THREE.CanvasTexture(c);
	texture.colorSpace = THREE.SRGBColorSpace;
	const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
	sprite.scale.set(c.width * 0.0075, c.height * 0.0075, 1);
	sprite.renderOrder = 20;
	return sprite;
}

/** Break text into at most four lines of about `max` characters. */
export function wrapText(text: string, max = 34): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let line = '';
	for (const w of words) {
		if ((line + ' ' + w).trim().length > max && line) {
			lines.push(line);
			line = w;
		} else line = (line + ' ' + w).trim();
	}
	if (line) lines.push(line);
	return lines.slice(0, 4);
}

/** A speech bubble (light, dark text); lines of about `max` characters. */
export function speechBubble(text: string, max = 34): THREE.Sprite {
	return roundedLabel(
		wrapText(text, max).map((line) => ({ text: line, font: '500 28px Inter, "Noto Sans Khmer", sans-serif', color: '#1d2422' })),
		'rgba(246,241,230,0.95)'
	);
}

export function disposeSprite(s: THREE.Sprite): void {
	s.material.map?.dispose();
	s.material.dispose();
	s.removeFromParent();
}
