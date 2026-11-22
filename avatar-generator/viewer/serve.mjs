// Tiny static server for the avatar viewer (no dependencies).
//   node viewer/serve.mjs [port]        → http://127.0.0.1:5190/viewer/
// Serves the avatar-generator folder, and /three/* from the game's own Three.js install
// (frontend/node_modules/three, r180) so the viewer uses exactly the engine the game ships.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const three = resolve(process.env.THREE_DIR ?? join(root, '..', 'frontend', 'node_modules', 'three'));
const port = Number(process.argv[2] ?? process.env.PORT ?? 5190);
const types = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg',
	'.css': 'text/css', '.wasm': 'application/wasm'
};

if (!existsSync(join(three, 'build', 'three.module.js'))) {
	console.error(`Three.js not found at ${three}. Run "npm install" in frontend/ or set THREE_DIR.`);
	process.exit(1);
}

createServer((req, res) => {
	const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	const [base, rel] = url.startsWith('/three/') ? [three, url.slice(7)] : [root, url.slice(1) || 'viewer/index.html'];
	let file = normalize(join(base, rel));
	if (!file.startsWith(base)) return res.writeHead(403).end();
	if (existsSync(file) && statSync(file).isDirectory()) {
		// "/viewer" → "/viewer/", so the page's relative imports (./main.js) resolve.
		if (!url.endsWith('/')) return res.writeHead(301, { location: url + '/' }).end();
		file = join(file, 'index.html');
	}
	if (!existsSync(file)) return res.writeHead(404).end('not found');
	res.writeHead(200, {
		'content-type': types[extname(file)] ?? 'application/octet-stream',
		'content-length': statSync(file).size,
		'cache-control': 'no-cache'
	});
	createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`avatar viewer: http://127.0.0.1:${port}/viewer/`));
