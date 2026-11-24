import { expect, it } from 'vitest';
import * as THREE from 'three';
import { AvatarLighting, addAvatarLighting } from './AvatarLighting';

it('keeps fill in character materials, with indoor/day fading and cleanup', () => {
    const material = new THREE.MeshStandardMaterial();
    const world = new THREE.MeshStandardMaterial();
    addAvatarLighting(material);
    const key = material.customProgramCacheKey();
    addAvatarLighting(material);
    expect(material.customProgramCacheKey()).toBe(key);
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader,
        vertexShader: THREE.ShaderLib.standard.vertexShader } as Parameters<typeof material.onBeforeCompile>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += diffuseColor.rgb * uAvatarBounce');
    expect(world.userData.avatarBounce).toBeUndefined();
    const cloned = material.clone();
    addAvatarLighting(cloned);
    expect(cloned.customProgramCacheKey()).toContain('avatar-bounce');
    cloned.dispose();
    const fill = new AvatarLighting();
    fill.update(1, 0);
    expect(shader.uniforms.uAvatarBounce.value).toBeGreaterThan(0);
    fill.update(1, 1);
    expect(shader.uniforms.uAvatarBounce.value).toBe(0);
    fill.update(0, 0);
    expect(shader.uniforms.uAvatarBounce.value).toBe(0);
    fill.dispose();
    expect(shader.uniforms.uAvatarBounce.value).toBe(0);
    material.dispose(); world.dispose();
});
