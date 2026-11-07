import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * The browser only ever talks to this origin. Requests to /api are forwarded to the FastAPI
 * backend, so the session cookie stays first-party and no CORS is needed.
 */
const API_URL = (env.API_INTERNAL_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const PROXIED = /^\/api\//;

// Hop-by-hop headers must not be forwarded by a proxy.
const HOP_BY_HOP = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
	'content-length'
];

async function proxy(event: Parameters<Handle>[0]['event']): Promise<Response> {
	const { request, url } = event;
	const headers = new Headers(request.headers);
	for (const name of HOP_BY_HOP) headers.delete(name);
	// Overwrite (never append to) any client-supplied value so it cannot be spoofed.
	headers.set('x-forwarded-for', event.getClientAddress());
	headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
	headers.set('x-forwarded-host', url.host);
	headers.delete('accept-encoding');

	const hasBody = !['GET', 'HEAD'].includes(request.method);
	let upstream: Response;
	try {
		upstream = await fetch(`${API_URL}${url.pathname}${url.search}`, {
			method: request.method,
			headers,
			body: hasBody ? await request.arrayBuffer() : undefined,
			redirect: 'manual'
		});
	} catch {
		return new Response(
			JSON.stringify({
				error: {
					code: 'API_UNAVAILABLE',
					message: 'The Phnom Penh Digital World server is not reachable. Please try again.',
					details: null
				}
			}),
			{ status: 503, headers: { 'content-type': 'application/json' } }
		);
	}
	const responseHeaders = new Headers(upstream.headers);
	responseHeaders.delete('content-encoding');
	responseHeaders.delete('content-length');
	responseHeaders.delete('transfer-encoding');
	return new Response(upstream.status === 304 ? null : upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	if (PROXIED.test(event.url.pathname)) return proxy(event);
	const response = await resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'content-type'
	});
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	// Geolocation stays off: avatar positions are never derived from real-world GPS.
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	return response;
};
