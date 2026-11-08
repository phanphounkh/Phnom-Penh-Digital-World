<script lang="ts">
	import { onMount } from 'svelte';

	const ASSETS = [
		'city/tree-rain', 'city/tree-palm', 'city/tree-slender', 'city/lamp',
		'city/traffic-signal', 'city/sign-post', 'landmarks/stupa', 'landmarks/phsar-thmei-dome'
	];
	let host: HTMLDivElement;
	let ready = $state(false);

	onMount(() => {
		let raf = 0;
		let dispose = () => {};
		(async () => {
			const THREE = await import('three');
			const { loadGLTF } = await import('$lib/game/city/props');
			const renderer = new THREE.WebGLRenderer({ antialias: true });
			renderer.setSize(host.clientWidth, host.clientHeight);
			renderer.setScissorTest(true);
			renderer.toneMapping = THREE.ACESFilmicToneMapping;
			host.appendChild(renderer.domElement);
			const cols = 4;
			const cellW = host.clientWidth / cols;
			const cellH = host.clientHeight / Math.ceil(ASSETS.length / cols);
			const scenes = await Promise.all(
				ASSETS.map(async (path) => {
					const scene = new THREE.Scene();
					scene.background = new THREE.Color('#dfe8e6');
					scene.add(new THREE.HemisphereLight('#ffffff', '#7a6f5a', 2));
					const sun = new THREE.DirectionalLight('#fff2d8', 2.5);
					sun.position.set(5, 10, 6);
					scene.add(sun);
					const model = (await loadGLTF(`/models/${path}.glb`)).clone(true);
					scene.add(model);
					const box = new THREE.Box3().setFromObject(model);
					const size = box.getSize(new THREE.Vector3());
					const centre = box.getCenter(new THREE.Vector3());
					const camera = new THREE.PerspectiveCamera(35, cellW / cellH, 0.1, 500);
					const d = Math.max(size.x, size.y, size.z) * 1.9;
					camera.position.set(centre.x + d * 0.7, centre.y + d * 0.35, centre.z + d * 0.7);
					camera.lookAt(centre);
					return { scene, camera, model, label: `${path} · ${size.y.toFixed(1)} m tall` };
				})
			);
			ready = true;
			const loop = () => {
				scenes.forEach(({ scene, camera, model }, i) => {
					model.rotation.y += 0.004;
					const x = (i % cols) * cellW;
					const y = host.clientHeight - (Math.floor(i / cols) + 1) * cellH;
					renderer.setViewport(x, y, cellW, cellH);
					renderer.setScissor(x, y, cellW, cellH);
					renderer.render(scene, camera);
				});
				raf = requestAnimationFrame(loop);
			};
			loop();
			labels = scenes.map((s) => s.label);
			dispose = () => renderer.dispose();
		})();
		return () => {
			cancelAnimationFrame(raf);
			dispose();
		};
	});
	let labels = $state<string[]>([]);
</script>

<div class="relative h-dvh w-full">
	<div bind:this={host} class="absolute inset-0" data-ready={ready} data-testid="asset-gallery"></div>
	<div class="pointer-events-none absolute inset-0 grid grid-cols-4">
		{#each labels as label (label)}<p class="p-2 font-mono text-xs text-ink">{label}</p>{/each}
	</div>
</div>
