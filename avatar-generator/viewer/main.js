// Avatar viewer: both characters side by side, High/Game quality, animation clips, face morphs.
// Uses the same Three.js (r180) as the game. window.__viewer exposes a small API for tests.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const CHARACTERS = [
	{ name: 'male', x: -0.5 },
	{ name: 'female', x: 0.5 }
];
const FILES = { high: (n) => `../output/${n}_avatar.glb`, game: (n) => `../output/${n}_avatar_game.glb` };

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#17181c');
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 50);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Soft studio environment for image-based lighting (skin, fabric and metal read correctly).
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight('#dfe6ff', '#3a3430', 0.35));
const key = new THREE.DirectionalLight('#fff3e6', 2.0);
key.position.set(2.2, 3.4, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2.5, bottom: -0.5, near: 0.5, far: 10 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);
const fill = new THREE.DirectionalLight('#cfe0ff', 0.45);
fill.position.set(-3, 2, 2);
scene.add(fill);
const rim = new THREE.DirectionalLight('#ffffff', 1.2);
rim.position.set(0.5, 2.5, -3);
scene.add(rim);
const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.MeshStandardMaterial({ color: '#2a2b31', roughness: 0.92 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const errors = [];
const state = { quality: 'high', clip: '', paused: false, morphs: {}, wire: false, models: {}, bytes: {} };

function prepare(gltf) {
	const meshes = [];
	gltf.scene.traverse((o) => {
		if (!o.isMesh) return;
		o.castShadow = true;
		o.receiveShadow = true;
		o.frustumCulled = false; // skinned: the bind-pose bounds do not follow the animation
		const list = Array.isArray(o.material) ? o.material : [o.material];
		for (const m of list) {
			if (m.alphaTest > 0) m.alphaToCoverage = true; // smoother hair/lash edges with MSAA
		}
		meshes.push(o);
	});
	return meshes;
}

// The game file holds every wardrobe choice; show one outfit (the original, or ?outfit=top=tee,...).
const OUTFIT = Object.fromEntries((new URLSearchParams(location.search).get('outfit') ?? '').split(',').filter(Boolean).map((p) => p.split('=')));

function wearOutfit(root, wardrobe) {
	const outfit = { ...wardrobe.default, ...OUTFIT };
	const worn = (choice) => { const [slot, variant] = choice.split('.'); return outfit[slot] === variant; };
	const byName = new Map(Object.entries(wardrobe.meshes).map(([n, info]) => [THREE.PropertyBinding.sanitizeNodeName(n), info]));
	root.traverse((o) => {
		const info = o.isMesh && byName.get(o.name);
		if (!info) return;
		o.visible = info.region
			? !(wardrobe.hidden_when[info.region] ?? []).some((clause) => clause.every(worn))
			: outfit[info.slot] === info.variant && (!info.with || worn(info.with));
	});
}

async function loadModel(name, quality) {
	const url = FILES[quality](name);
	const t0 = performance.now();
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	const buf = await res.arrayBuffer();
	const gltf = await loader.parseAsync(buf, url.replace(/[^/]*$/, ''));
	const meshes = prepare(gltf);
	if (quality === 'game') {
		const meta = await fetch(`../output/${name}_avatar_game.json`).then((r) => (r.ok ? r.json() : null));
		if (meta?.wardrobe) wearOutfit(gltf.scene, meta.wardrobe);
	}
	const mixer = new THREE.AnimationMixer(gltf.scene);
	const actions = Object.fromEntries(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]));
	const morphMeshes = meshes.filter((m) => m.morphTargetDictionary);
	return { name, gltf, root: gltf.scene, meshes, mixer, actions, morphMeshes, bytes: buf.byteLength, loadMs: performance.now() - t0 };
}

async function setQuality(quality) {
	statusEl.textContent = `Loading ${quality} quality…`;
	const loaded = await Promise.all(CHARACTERS.map((c) => loadModel(c.name, quality)));
	for (const old of Object.values(state.models)) {
		scene.remove(old.root);
		old.mixer.stopAllAction();
	}
	state.models = {};
	loaded.forEach((m, i) => {
		m.root.position.x = CHARACTERS[i].x;
		scene.add(m.root);
		state.models[m.name] = m;
	});
	state.quality = quality;
	document.querySelectorAll('#quality button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === quality)));
	buildControls();
	play(state.clip);
	setWire(state.wire);
	statusEl.textContent = `${quality === 'high' ? 'High quality' : 'Game quality'} · ${Object.values(state.models)
		.map((m) => `${m.name} ${(m.bytes / 1e6).toFixed(2)} MB`)
		.join(' · ')}`;
}

function clipNames() {
	return [...new Set(Object.values(state.models).flatMap((m) => Object.keys(m.actions)))];
}

function morphNames() {
	const names = new Set();
	for (const m of Object.values(state.models)) for (const mesh of m.morphMeshes) Object.keys(mesh.morphTargetDictionary).forEach((n) => names.add(n));
	return [...names];
}

function buildControls() {
	const select = document.getElementById('clip');
	const current = select.value;
	select.innerHTML = '<option value="">A-pose (rest)</option>' + clipNames().map((n) => `<option>${n}</option>`).join('');
	select.value = clipNames().includes(current) ? current : '';
	const box = document.getElementById('morphs');
	box.innerHTML = '';
	for (const name of morphNames()) {
		const label = document.createElement('label');
		label.className = 'slider';
		label.innerHTML = `<span>${name}</span><input type="range" min="0" max="1" step="0.01" value="${state.morphs[name] ?? 0}"><output>${(state.morphs[name] ?? 0).toFixed(2)}</output>`;
		const input = label.querySelector('input');
		input.addEventListener('input', () => {
			state.morphs[name] = Number(input.value);
			label.querySelector('output').textContent = Number(input.value).toFixed(2);
		});
		box.appendChild(label);
	}
}

function play(name) {
	state.clip = name;
	for (const m of Object.values(state.models)) {
		m.mixer.stopAllAction();
		if (name && m.actions[name]) m.actions[name].reset().play();
	}
	if (!name) {
		restPose();
		applyMorphOverrides();
	}
}

function restPose() {
	for (const m of Object.values(state.models)) {
		m.root.traverse((o) => {
			if (o.isBone && o.userData.rest) {
				o.position.copy(o.userData.rest.p);
				o.quaternion.copy(o.userData.rest.q);
			}
		});
	}
}

/** Freeze every model at time `t` of `clip` (deterministic screenshots in tests). */
function pose(clip, t) {
	state.paused = true;
	play(clip);
	for (const m of Object.values(state.models)) {
		const a = m.actions[clip];
		if (!a) continue;
		a.time = t;
		m.mixer.update(0);
	}
	applyMorphOverrides();
}

/** Sliders: exact values at rest; during a clip they add on top of the clip's own face. */
function applyMorphOverrides() {
	for (const m of Object.values(state.models)) {
		const animating = Boolean(state.clip && m.actions[state.clip]);
		for (const mesh of m.morphMeshes) {
			for (const [name, i] of Object.entries(mesh.morphTargetDictionary)) {
				const v = state.morphs[name] ?? 0;
				mesh.morphTargetInfluences[i] = animating ? Math.max(mesh.morphTargetInfluences[i], v) : v;
			}
		}
	}
}

function setWire(on) {
	state.wire = on;
	document.getElementById('wire').setAttribute('aria-pressed', String(on));
	for (const m of Object.values(state.models)) for (const mesh of m.meshes) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((mat) => (mat.wireframe = on));
}

const VIEWS = {
	both: { pos: [0.9, 1.35, 4.3], target: [0, 0.9, 0] },
	male: { pos: [-0.1, 1.3, 2.6], target: [-0.5, 0.95, 0] },
	female: { pos: [0.9, 1.25, 2.5], target: [0.5, 0.9, 0] },
	face: { pos: [0, 1.5, 2.1], target: [0, 1.47, 0] }
};
function setView(name) {
	const v = VIEWS[name];
	camera.position.set(...v.pos);
	controls.target.set(...v.target);
	controls.update();
}

function stats() {
	let triangles = 0;
	for (const m of Object.values(state.models)) {
		for (const mesh of m.meshes) {
			if (!mesh.visible) continue; // other wardrobe choices (game quality)
			const g = mesh.geometry;
			triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
		}
	}
	return {
		quality: state.quality,
		triangles,
		drawCalls: renderer.info.render.calls,
		textures: renderer.info.memory.textures,
		geometries: renderer.info.memory.geometries,
		bytes: Object.fromEntries(Object.values(state.models).map((m) => [m.name, m.bytes])),
		loadMs: Object.fromEntries(Object.values(state.models).map((m) => [m.name, Math.round(m.loadMs)])),
		fps: Math.round(fps)
	};
}

function boneWorld(model, bone) {
	const b = state.models[model]?.root.getObjectByName(bone);
	if (!b) return null;
	b.updateWorldMatrix(true, false);
	return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray();
}

// ── UI wiring ──
document.querySelectorAll('#quality button').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.q)));
document.getElementById('clip').addEventListener('change', (e) => {
	state.paused = false;
	document.getElementById('pause').setAttribute('aria-pressed', 'false');
	play(e.target.value);
});
document.getElementById('pause').addEventListener('click', (e) => {
	state.paused = !state.paused;
	e.target.setAttribute('aria-pressed', String(state.paused));
});
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.getElementById('wire').addEventListener('click', () => setWire(!state.wire));
addEventListener('resize', () => {
	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(innerWidth, innerHeight);
});

// ── Loop ──
const clock = new THREE.Clock();
let fps = 0;
let statsTimer = 0;
renderer.setAnimationLoop(() => {
	const dt = Math.min(clock.getDelta(), 0.1);
	fps = fps ? fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 60;
	if (!state.paused) for (const m of Object.values(state.models)) m.mixer.update(dt);
	if (!state.paused) applyMorphOverrides();
	controls.update();
	renderer.info.autoReset = false;
	renderer.info.reset();
	renderer.render(scene, camera);
	if ((statsTimer += dt) > 0.5) {
		statsTimer = 0;
		const s = stats();
		statsEl.textContent = `quality   ${s.quality}\ntriangles ${s.triangles.toLocaleString()}\ndraw calls ${s.drawCalls}\ntextures  ${s.textures}\nfps       ${s.fps}`;
	}
});

addEventListener('error', (e) => errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

setView('both');
const ready = setQuality(new URLSearchParams(location.search).get('quality') === 'game' ? 'game' : 'high')
	.then(() => {
		// Remember the rest pose so "A-pose" can restore it after a clip.
		for (const m of Object.values(state.models))
			m.root.traverse((o) => o.isBone && (o.userData.rest = { p: o.position.clone(), q: o.quaternion.clone() }));
	})
	.catch((e) => {
		errors.push(String(e));
		statusEl.textContent = `Failed: ${e.message}`;
		throw e;
	});

window.__viewer = {
	ready, setQuality: async (q) => {
		await setQuality(q);
		for (const m of Object.values(state.models))
			m.root.traverse((o) => o.isBone && (o.userData.rest = { p: o.position.clone(), q: o.quaternion.clone() }));
	},
	play: (n) => { state.paused = false; play(n); }, pose, setView, stats, boneWorld, errors,
	hideUI: () => document.querySelectorAll('.panel, #stats').forEach((e) => (e.style.display = 'none')),
	setMorph: (n, v) => { state.morphs[n] = v; applyMorphOverrides(); },
	clearMorphs: () => { state.morphs = {}; applyMorphOverrides(); },
	clips: clipNames, morphs: morphNames,
	morphInfluence: (model, n) => {
		const m = state.models[model];
		const mesh = m?.morphMeshes.find((x) => x.morphTargetDictionary[n] !== undefined);
		return mesh ? mesh.morphTargetInfluences[mesh.morphTargetDictionary[n]] : null;
	}
};
