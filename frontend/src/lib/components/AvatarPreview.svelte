<script lang="ts">
	import { onMount } from 'svelte';
	import { Rotate3d } from 'lucide-svelte';
	import type { Material, Object3D } from 'three';
	import type { Avatar } from '$lib/api/types';
	import { loadAvatarStyle, saveAvatarStyle, type AvatarStyle } from '$lib/game/avatar/character';

	/**
	 * Turntable preview of the player's avatar in the chosen style (realistic or classic, also
	 * settable by the page: `bind:style`); restyles live as `avatar` changes. Realistic models
	 * idle-animate; a different build reloads the model. `caption` describes the look below the
	 * stage, where it never covers the avatar.
	 */
	let {
		avatar,
		style = $bindable(loadAvatarStyle()),
		caption = ''
	}: { avatar: Avatar; style?: AvatarStyle; caption?: string } = $props();
	let host: HTMLDivElement;
	let failed = $state(false);
	let ready = $state(false);
	let turned = $state(false);
	let shown = $state<AvatarStyle | null>(null);

	interface Model {
		root: Object3D;
		/** Restyle in place; false when it needs rebuilding (different realistic build). */
		update(a: Avatar): boolean;
		tick(dt: number): void;
		dispose(): void;
	}
	let model: Model | null = null;
	let rebuild: ((a: Avatar) => Promise<void>) | null = null;

	$effect(() => {
		const snapshot = $state.snapshot(avatar) as Avatar;
		void style;
		if (model && model.update(snapshot) && shown === style) return;
		rebuild?.(snapshot);
	});

	// The look is also the one used in the world (players see everyone in it).
	$effect(() => saveAvatarStyle(style));

	async function realisticModel(a: Avatar): Promise<Model> {
		const THREE = await import('three');
		const { createRealisticAvatar } = await import('$lib/game/avatar/realistic');
		const instance = await createRealisticAvatar(a);
		const mixer = new THREE.AnimationMixer(instance.root);
		const idle = instance.clips.find((c) => c.name === 'Idle');
		if (idle) mixer.clipAction(idle).play();
		return {
			root: instance.root,
			update: (n) => instance.update(n),
			tick: (dt) => mixer.update(dt),
			dispose() {
				mixer.stopAllAction();
				instance.dispose();
			}
		};
	}

	async function classicModel(a: Avatar): Promise<Model> {
		const { createAvatar } = await import('$lib/game/avatar/avatar');
		const instance = await createAvatar(a);
		return {
			root: instance.root,
			update: (n) => (instance.update(n), true),
			tick: () => {},
			dispose: () => instance.dispose()
		};
	}

	onMount(() => {
		let disposed = false;
		let cleanup = () => {};
		(async () => {
			try {
				const THREE = await import('three');
				const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
				renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
				renderer.shadowMap.enabled = true;
				renderer.toneMapping = THREE.ACESFilmicToneMapping;
				// Out of the layout: the stage's size comes from the page, never from the canvas (a
				// canvas sized for a narrow window would otherwise hold the column wide).
				Object.assign(renderer.domElement.style, { display: 'block', position: 'absolute', inset: '0' });
				host.appendChild(renderer.domElement);
				const scene = new THREE.Scene();
				const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
				camera.position.set(0, 1.1, 3.75);
				camera.lookAt(0, 0.88, 0);
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

				let token = 0;
				rebuild = async (a: Avatar) => {
					const mine = ++token;
					const want = style;
					let next: Model;
					try {
						next = want === 'realistic' ? await realisticModel(a) : await classicModel(a);
					} catch (error) {
						console.warn('Realistic preview unavailable, showing the classic avatar:', error);
						next = await classicModel(a);
					}
					if (disposed || mine !== token) return next.dispose();
					next.root.traverse((n) => ((n as import('three').Mesh).castShadow = true));
					model?.dispose();
					model = next;
					scene.add(next.root);
					shown = want;
					ready = true;
				};
				await rebuild($state.snapshot(avatar) as Avatar);
				if (disposed) return;

				let angle = 0.5;
				let dragging = false;
				let lastX = 0;
				let raf = 0;
				let last = performance.now();
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
					turned = true;
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
				const loop = (now: number) => {
					const dt = Math.min(0.1, (now - last) / 1000);
					last = now;
					if (!dragging) angle += 0.004;
					if (model) {
						model.root.rotation.y = angle;
						model.tick(dt);
					}
					renderer.render(scene, camera);
					raf = requestAnimationFrame(loop);
				};
				raf = requestAnimationFrame(loop);
				cleanup = () => {
					cancelAnimationFrame(raf);
					observer.disconnect();
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', up);
					model?.dispose();
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
			rebuild = null;
			cleanup();
		};
	});
</script>

<div
	class="flex h-full min-h-[340px] w-full flex-col overflow-hidden rounded-3xl bg-gradient-to-b from-saffron-100 to-paper-2"
	data-testid="avatar-preview"
	data-ready={ready}
	data-style={shown ?? ''}
>
	<div class="flex items-center justify-between gap-3 px-4 pt-3">
		<p class="flex items-center gap-1.5 text-xs text-ink-soft transition-opacity {turned ? 'opacity-0' : ''}" aria-hidden={turned}>
			<Rotate3d size={14} /> Drag to turn
		</p>
		<div class="grid grid-cols-2 gap-1 rounded-xl bg-white/80 p-1 text-xs font-semibold" role="radiogroup" aria-label="Avatar style">
			{#each [['realistic', 'Realistic'], ['classic', 'Classic']] as const as [s, text] (s)}
				<button
					type="button"
					role="radio"
					aria-checked={style === s}
					class="rounded-lg px-2.5 py-1 {style === s ? 'bg-white text-river-900 shadow' : 'text-ink-soft hover:text-river-900'}"
					onclick={() => (style = s)}>{text}</button
				>
			{/each}
		</div>
	</div>
	<div bind:this={host} class="relative min-h-0 flex-1 cursor-grab touch-pan-y active:cursor-grabbing">
		{#if failed}
			<p class="absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink-soft">
				3D preview unavailable (WebGL required). Your choices are still saved.
			</p>
		{:else if !ready}
			<p class="absolute inset-0 grid place-items-center text-sm text-ink-soft">Loading avatar…</p>
		{/if}
	</div>
	{#if caption || shown === 'realistic'}
		<div class="border-t border-river-900/10 bg-white/55 px-4 py-3" aria-live="polite">
			{#if caption}<p class="text-sm text-river-950">{caption}</p>{/if}
			{#if shown === 'realistic'}
				<p class="mt-0.5 text-xs text-ink-soft">The realistic look wears one outfit in your colours. Hairstyles, garment styles and accessories show in Classic.</p>
			{/if}
		</div>
	{/if}
</div>
