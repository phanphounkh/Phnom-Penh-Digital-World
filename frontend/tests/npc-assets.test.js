import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const folder = new URL('../static/models/characters/', import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('NPC faces have different body/face geometry and retain the player-compatible rig and actions', async () => {
	for (const kind of ['male', 'female']) {
		const positions = [];
		for (const face of ['broad', 'slender']) {
			const bytes = await readFile(new URL(`npcs/${kind}-${face}.glb`, folder));
			assert.ok(bytes.length < 2300000, 'NPC download budget');
			const doc = await io.readBinary(bytes),
				root = doc.getRoot();
			const clips = root.listAnimations().map((a) => a.getName());
			for (const clip of ['Idle', 'Walk', 'Run', 'Jump', 'Fall', 'Land', 'Sit', 'Talk', 'Greet'])
				assert.ok(clips.includes(clip), clip);
			assert.equal(root.listSkins()[0].listJoints().length, 52);
			const body = root.listMeshes().find((m) => m.getName() === `${kind}.game.body`);
			assert.ok(body, 'same material/wardrobe contract');
			positions.push(digest(body.listPrimitives()[0].getAttribute('POSITION').getArray()));
		}
		const original = await io.readBinary(await readFile(new URL(`realistic/${kind}.glb`, folder)));
		positions.push(
			digest(
				original
					.getRoot()
					.listMeshes()
					.find((m) => m.getName() === `${kind}.game.body`)
					.listPrimitives()[0]
					.getAttribute('POSITION')
					.getArray()
			)
		);
		assert.equal(new Set(positions).size, 3, 'NPCs must differ geometrically from each other and the player');
	}
});

test('player model files and customization manifest remain unchanged by NPC generation', async () => {
	const hashes = {
		'male.glb': '2b0d50572f3158888614d2cd0c93814ff6bfaf68a9938fa6f2dbcda67af22e8d',
		'female.glb': 'fbf4c4772be5815ce81574e76751e98211434c16f691dc8f81dfd1df1089209e',
		'manifest.json': '6512eec993b559dbca7411229b4c5c2222b8cb49a905016ce59d4819940e5d07'
	};
	for (const [file, hash] of Object.entries(hashes))
		assert.equal(digest(await readFile(new URL(`realistic/${file}`, folder))), hash, file);
});
