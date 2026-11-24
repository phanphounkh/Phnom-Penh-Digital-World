export type FootGait = 'walk' | 'run' | 'sprint';
export function footProfile(speed: number): { gait: FootGait; stride: number; gain: number; duration: number } {
	if (speed > 4.5) return {gait:'sprint',stride:1.55,gain:.25,duration:.11};
	if (speed > 2) return {gait:'run',stride:1.05,gain:.2,duration:.1};
	return {gait:'walk',stride:.75,gain:.15,duration:.075};
}
export function vehicleProfile(kind: string | null, speed: number, rolling: number, propelling: boolean, paused: boolean) {
	const bike=kind==='bicycle', moto=kind==='motorbike';
	return {
		engine: moto && !paused ? .055+Math.min(.075,Math.abs(speed)*.006)+(propelling ? .02 : 0) : 0,
		rpm: 28+Math.min(140,Math.abs(speed)*8)+(propelling ? 16 : 0),
		tyres: kind && !paused ? Math.min(.09,Math.max(0,rolling)*.011) : 0,
		bikeTick: bike && !paused && rolling>.35 ? (propelling ? .25 : Math.max(.07,.42/(1+rolling*.3))) : 0,
		coasting: bike && !propelling
	};
}
