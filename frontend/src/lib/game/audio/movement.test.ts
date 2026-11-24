import { expect, it } from 'vitest';
import { footProfile, vehicleProfile } from './movement';

it('walk, run and sprint have progressively faster, heavier footfalls',()=>{
	const walk=footProfile(1), run=footProfile(2.6), sprint=footProfile(6.5);
	expect([walk.gait,run.gait,sprint.gait]).toEqual(['walk','run','sprint']);
	expect(run.stride/2.6).toBeLessThan(walk.stride);
	expect(sprint.stride/6.5).toBeLessThan(run.stride/2.6);
	expect(sprint.gain).toBeGreaterThan(run.gain);
	expect(run.gain).toBeGreaterThan(walk.gain);
});
it('bicycles have rolling and coasting sounds but never a motor',()=>{
	const coast=vehicleProfile('bicycle',4,4,false,false);
	expect(coast.engine).toBe(0);
	expect(coast.tyres).toBeGreaterThan(0);
	expect(coast.bikeTick).toBeGreaterThan(0);
	expect(coast.coasting).toBe(true);
	const stopped=vehicleProfile('bicycle',0,0,false,false);
	expect(stopped.tyres).toBe(0); expect(stopped.bikeTick).toBe(0);
});
it('motorbike revs grow with speed/throttle, and paused vehicles go silent',()=>{
	const idle=vehicleProfile('motorbike',0,0,false,false), rev=vehicleProfile('motorbike',6,6,true,false);
	expect(idle.engine).toBeGreaterThan(0); expect(rev.rpm).toBeGreaterThan(idle.rpm);
	expect(rev.engine).toBeGreaterThan(idle.engine); expect(rev.bikeTick).toBe(0);
	const paused=vehicleProfile('motorbike',6,6,true,true);
	expect(paused.engine).toBe(0); expect(paused.tyres).toBe(0);
});
