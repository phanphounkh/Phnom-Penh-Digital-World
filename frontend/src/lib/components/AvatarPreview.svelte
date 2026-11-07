<script lang="ts">
	import { onMount } from 'svelte';
	import type { Material } from 'three';
	import type { Avatar } from '$lib/api/types';
	import type { AvatarInstance } from '$lib/game/avatar/avatar';

	/** Turntable preview of the Blender avatar; restyles live as `avatar` changes. */
	let { avatar }: { avatar: Avatar } = $props();
	let host: HTMLDivElement;
	let instance: AvatarInstance | null = null;
	let failed = $state(false);
	let ready = $state(false);

	$effect(() => {
		const snapshot = $state.snapshot(avatar) as Avatar;
		instance?.update(snapshot);
	});

	onMount(() => {
		let disposed = false;
		let cleanup = () => {};
		(async () => {
			try {
				const THREE = await import('three');
				const { createAvatar } = await import('$lib/game/avatar/avatar');
				const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
				renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
				renderer.shadowMap.enabled = true;
				renderer.toneMapping = THREE.ACESFilmicToneMapping;
				host.appendChild(renderer.domElement);
				const scene = new THREE.Scene();
				const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
				camera.position.set(0, 1.2, 4.3);
				camera.lookAt(0, 0.95, 0);
				scene.add(new THREE.HemisphereLight('#fff6e6', '#2b4a46', 1.6));
				const sun = new THREE.DirectionalLight('#ffe7c2', 2.2);
				sun.position.set(2.5, 4, 3);
				sun.castShadow = true;
				sun.shadow.mapSize.set(1024, 1024);
				scene.add(sun);
				const disc = new THREE.Mesh(
					new THREE.CircleGeometry(1.1, 48),
					new THREE.MeshStandardMaterial({ color: '#e8dcc4', roughness: 0.9 })
				);
				disc.rotation.x = -Math.PI / 2;
				disc.receiveShadow = true;
				scene.add(disc);
				instance = await createAvatar($state.snapshot(avatar) as Avatar);
				if (disposed) return instance.dispose();
				scene.add(instance.root);
				ready = true;

				let angle = 0.5;
				let dragging = false;
				let lastX = 0;
				let raf = 0;
				const resize = () => {
					const w = host.clientWidth;
					const h = host.clientHeight;
					renderer.setSize(w, h);
					camera.aspect = w / h;
					camera.updateProjectionMatrix();
				};
				const observer = new ResizeObserver(resize);
				observer.observe(host);
				resize();
				const down = (e: PointerEvent) => {
					dragging = true;
					lastX = e.clientX;
				};
				const move = (e: PointerEvent) => {
					if (!dragging) return;
					angle += (e.clientX - lastX) * 0.01;
					lastX = e.clientX;
				};
				const up = () => (dragging = false);
				renderer.domElement.addEventListener('pointerdown', down);
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', up);
				const loop = () => {
					if (!dragging) angle += 0.004;
					if (instance) instance.root.rotation.y = angle;
					renderer.render(scene, camera);
					raf = requestAnimationFrame(loop);
				};
				loop();
				cleanup = () => {
					cancelAnimationFrame(raf);
					observer.disconnect();
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', up);
					instance?.dispose();
					disc.geometry.dispose();
					(disc.material as Material).dispose();
					renderer.dispose();
					renderer.domElement.remove();
				};
			} catch (error) {
				console.error(error);
				failed = true;
			}
		})();
		return () => {
			disposed = true;
			cleanup();
		};
	});
</script>

<div
	bind:this={host}
	class="relative h-full min-h-[340px] w-full cursor-grab touch-pan-y overflow-hidden rounded-3xl bg-gradient-to-b from-saffron-100 to-paper-2 active:cursor-grabbing"
	data-testid="avatar-preview"
	data-ready={ready}
>
	{#if failed}
		<p class="absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink-soft">
			3D preview unavailable (WebGL required). Your choices are still saved.
		</p>
	{:else if !ready}
		<p class="absolute inset-0 grid place-items-center text-sm text-ink-soft">Loading avatar…</p>
	{/if}
</div>
