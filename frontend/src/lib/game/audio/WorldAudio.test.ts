import { expect, it } from 'vitest';
import type { ChunkPayload } from '$lib/api/types';
import { audioSettings, AUDIO_DEFAULTS, waterProximity } from './WorldAudio';

it('clamps stored sound preferences and rejects non-finite or invalid levels', () => {
	expect(audioSettings({ master:10, ambience:-1, effects:NaN })).toEqual({master:1,ambience:0,effects:AUDIO_DEFAULTS.effects,music:AUDIO_DEFAULTS.music,muted:false});
	expect(audioSettings({master:Infinity,muted:true})).toEqual({...AUDIO_DEFAULTS,muted:true});
});
it('fades water ambience with distance to mapped water rather than ordinary park polygons', () => {
	const payload = { areas:[{kind:'water',polys:[[[[0,0],[10,0],[10,10],[0,10]]]]}] } as unknown as ChunkPayload;
	expect(waterProximity([payload],20,5)).toBeCloseTo(1-10/70);
	expect(waterProximity([payload],100,5)).toBe(0);
	expect(waterProximity([],0,0)).toBe(0);
	const park={...payload,areas:payload.areas.map(a=>({...a,kind:'park'}))};
	expect(waterProximity([park],20,5)).toBe(0);
});

it('migrates saved settings with a quiet music default without changing existing volume choices',()=>{
 const settings=audioSettings({master:.4,ambience:.2,effects:0,muted:true});
 expect(settings).toEqual({master:.4,ambience:.2,effects:0,music:.25,muted:true});
 expect(audioSettings({music:NaN}).music).toBe(.25);
 expect(audioSettings({music:2}).music).toBe(1);
});
