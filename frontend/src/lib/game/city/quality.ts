/** Seconds spent below 24 FPS, with recovery on smooth frames. Cap one hitch so
 * a tab resume or shader compilation alone cannot force Performance mode. */
export function qualityDebt(previous: number, elapsed: number): number {
	const sample = Math.min(Math.max(elapsed, 0), 0.25);
	return elapsed > 1 / 24
		? previous + sample
		: Math.max(0, previous - sample * 2);
}

export type GraphicsQuality = 'low' | 'medium' | 'high';
/** Explicit budgets, not an assertion that every device can sustain the preset. */
export const GRAPHICS_PRESETS = {
	low: {
		pixelRatio: 0.75,
		shadows: false,
		shadowSize: 512,
		shadowSpan: 70,
		radius: 300,
		detailRadius: 160,
		surfaceDetail: 0,
		environment: false,
		dayFill: 0,
		fogNear: 220,
		fogFar: 650
	},
	medium: {
		pixelRatio: 1,
		shadows: true,
		shadowSize: 1024,
		shadowSpan: 96,
		radius: 340,
		detailRadius: 180,
		surfaceDetail: 0,
		environment: false,
		dayFill: 0.6,
		fogNear: 250,
		fogFar: 700
	},
	high: {
		pixelRatio: 1.5,
		shadows: true,
		shadowSize: 2048,
		shadowSpan: 150,
		radius: 420,
		detailRadius: 240,
		surfaceDetail: 1,
		environment: true,
		dayFill: 0,
		fogNear: 280,
		fogFar: 800
	}
} as const;
export function lowerQuality(quality: GraphicsQuality): GraphicsQuality {
	return quality === 'high' ? 'medium' : 'low';
}
