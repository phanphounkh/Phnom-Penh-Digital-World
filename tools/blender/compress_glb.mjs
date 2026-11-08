// Meshopt-compress the Phnom Penh Digital World GLBs in place (run after the Blender scripts).
// The original CampusEats GLBs are left uncompressed: the legacy /mall loader has no decoder.
//   cd frontend && npm run assets:compress
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../frontend/static/models/', import.meta.url).pathname;
const targets = [
	...['city', 'landmarks'].flatMap((dir) =>
		readdirSync(join(root, dir)).filter((f) => f.endsWith('.glb')).map((f) => join(root, dir, f))
	),
	join(root, 'characters', 'avatar.glb')
];
for (const file of targets) {
	const before = statSync(file).size;
	const tmp = file.replace(/\.glb$/, '.tmp.glb');
	execFileSync('npx', ['gltf-transform', 'meshopt', file, tmp], { stdio: 'pipe' });
	renameSync(tmp, file);
	const after = statSync(file).size;
	console.log(`${file.replace(root, '')}: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
}
