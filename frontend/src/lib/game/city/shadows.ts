import type { Group } from 'three';

/** Remember caster eligibility independently of the active preset. In particular, a chunk
 * loaded in Low must cast shadows when the player later selects Medium/High. */
export function setChunkShadows(group: Group, enabled: boolean): void {
	group.userData.shadowEnabled = enabled;
	group.traverse((object) => {
		if (object.userData.shadowCaster === true) object.castShadow = enabled;
	});
}
