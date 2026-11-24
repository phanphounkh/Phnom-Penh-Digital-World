import * as THREE from 'three';

const bounce = { value: 0 };
const installed = new WeakSet<THREE.Material>();

/** Subtle character-only readability fill, with no extra lights or render passes. */
export function addAvatarLighting(material: THREE.MeshStandardMaterial): void {
    if (installed.has(material)) return;
    installed.add(material);
    material.userData.avatarBounce = true;
    const previous = material.onBeforeCompile.bind(material);
    const previousKey = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        shader.uniforms.uAvatarBounce = bounce;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uAvatarBounce;')
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
// Soft camera-side bounce; retain texture detail and chosen colours.
totalEmissiveRadiance += diffuseColor.rgb * uAvatarBounce * (.35+.65*max(normal.z,0.));`);
    };
    material.customProgramCacheKey = () => `${previousKey()}|avatar-bounce`;
    material.needsUpdate = true;
}

export class AvatarLighting {
    update(night: number, indoor: number) {
        bounce.value = .4 * THREE.MathUtils.clamp(night, 0, 1) * (1 - THREE.MathUtils.clamp(indoor, 0, 1));
    }
    dispose() { bounce.value = 0; }
}
