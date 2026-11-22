/**
 * The TV picture: a small canvas (256 x 144) animated about 8 times a second while the set is
 * on — a slow sunrise over the river with a scrolling news ticker. Cheap enough for a laptop
 * without a GPU, and it stops drawing when the TV is off.
 */
import * as THREE from 'three';

const HEADLINES = [
	'Water festival boat races start on the Tonle Sap this weekend',
	'Riverside night market opens with new food stalls',
	'Rain expected in the afternoon across Phnom Penh',
	'Football: Phnom Penh Crown win at home'
];

export class TvPicture {
	readonly texture: THREE.CanvasTexture;
	private ctx: CanvasRenderingContext2D;
	private time = 0;
	private sinceDraw = 1;

	constructor() {
		const canvas = document.createElement('canvas');
		canvas.width = 256;
		canvas.height = 144;
		// A CPU canvas: uploading a GPU-accelerated 2D canvas into WebGL stalls the GPU (it
		// halved the frame rate on an integrated GPU); this one is a plain memory copy.
		this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
		this.texture = new THREE.CanvasTexture(canvas);
		this.texture.colorSpace = THREE.SRGBColorSpace;
		this.texture.flipY = false; // glTF UVs
		this.draw();
	}

	update(dt: number): void {
		this.time += dt;
		this.sinceDraw += dt;
		if (this.sinceDraw < 0.12) return;
		this.sinceDraw = 0;
		this.draw();
		this.texture.needsUpdate = true;
	}

	private draw(): void {
		const g = this.ctx;
		const t = this.time;
		// Sky to river, slowly brightening and fading back.
		const k = 0.5 + 0.5 * Math.sin(t * 0.15);
		const sky = g.createLinearGradient(0, 0, 0, 100);
		sky.addColorStop(0, `rgb(${40 + 120 * k},${60 + 110 * k},${110 + 90 * k})`);
		sky.addColorStop(1, `rgb(${230},${150 + 60 * k},${90 + 40 * k})`);
		g.fillStyle = sky;
		g.fillRect(0, 0, 256, 100);
		g.fillStyle = '#ffe0a0';
		g.beginPath();
		g.arc(190, 92 - 30 * k, 14, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = '#20384a';
		g.fillRect(0, 100, 256, 44);
		for (let i = 0; i < 6; i++) {
			const x = (i * 53 + t * 12) % 300 - 20;
			g.fillStyle = 'rgba(255,220,160,0.5)';
			g.fillRect(x, 104 + (i % 3) * 5, 24, 1.5);
		}
		// Boat crossing the river.
		const bx = ((t * 18) % 320) - 40;
		g.fillStyle = '#5a2a1a';
		g.fillRect(bx, 98, 34, 5);
		g.fillStyle = '#e0b040';
		g.fillRect(bx + 10, 91, 12, 7);
		// News bar.
		g.fillStyle = 'rgba(160,30,40,0.92)';
		g.fillRect(0, 122, 256, 22);
		g.fillStyle = '#ffffff';
		g.font = 'bold 12px system-ui, sans-serif';
		const text = HEADLINES.join('   •   ') + '   •   ';
		const w = g.measureText(text).width;
		const x = -((t * 40) % w);
		g.fillText(text, x, 137);
		g.fillText(text, x + w, 137);
		g.fillStyle = '#ffffff';
		g.fillRect(6, 6, 46, 16);
		g.fillStyle = '#a01e28';
		g.font = 'bold 11px system-ui, sans-serif';
		g.fillText('PPW 1', 12, 18);
	}

	dispose(): void {
		this.texture.dispose();
	}
}
