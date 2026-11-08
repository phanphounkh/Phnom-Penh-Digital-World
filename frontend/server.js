// Production entry: the SvelteKit app (adapter-node) plus a WebSocket pass-through for the
// world socket. SvelteKit's /api proxy uses fetch, which cannot carry WebSocket upgrades.
//   node server.js   (PORT, HOST, ORIGIN, API_INTERNAL_URL as for adapter-node)
import { createServer } from 'node:http';
import net from 'node:net';
import { handler } from './build/handler.js';

const api = new URL(process.env.API_INTERNAL_URL || 'http://127.0.0.1:8000');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const WS_PATH = '/api/v1/world/ws';

const server = createServer(handler);

server.on('upgrade', (req, socket, head) => {
	if (!req.url || !req.url.startsWith(WS_PATH)) {
		socket.destroy();
		return;
	}
	const upstream = net.connect(Number(api.port || 80), api.hostname, () => {
		const headers = { ...req.headers, host: api.host };
		// Overwrite, never append, so clients cannot spoof their address.
		headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
		let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
		for (const [name, value] of Object.entries(headers)) {
			for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) raw += `${name}: ${v}\r\n`;
		}
		upstream.write(raw + '\r\n');
		if (head?.length) upstream.write(head);
		socket.pipe(upstream).pipe(socket);
	});
	const close = () => {
		socket.destroy();
		upstream.destroy();
	};
	upstream.on('error', close);
	socket.on('error', close);
	upstream.on('end', () => socket.end());
	socket.on('end', () => upstream.end());
});

server.listen(port, host, () => console.log(`Phnom Penh Digital World on http://${host}:${port}`));
