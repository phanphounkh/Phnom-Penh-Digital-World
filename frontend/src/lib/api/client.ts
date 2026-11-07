/**
 * Typed fetch wrapper for the FastAPI backend.
 *
 * The browser only talks to this origin: SvelteKit's server hook proxies /api to the API, so
 * the HTTP-only session cookie stays first-party. Unsafe requests echo the readable CSRF
 * cookie in X-CSRF-Token (double-submit), matching the backend middleware.
 */

export const API_BASE = '/api/v1';
const CSRF_COOKIE = 'ppw_csrf';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type FieldError = { field: string; message: string; type: string };

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details: unknown = null
	) {
		super(message);
		this.name = 'ApiError';
	}

	/** Validation errors keyed by field name (first message wins). */
	get fieldErrors(): Record<string, string> {
		if (this.code !== 'VALIDATION_ERROR' || !Array.isArray(this.details)) return {};
		const out: Record<string, string> = {};
		for (const d of this.details as FieldError[]) {
			const key = d.field || '_';
			out[key] ??= d.message;
		}
		return out;
	}
}

export function readCookie(name: string, cookieString?: string): string | null {
	const source = cookieString ?? (typeof document === 'undefined' ? '' : document.cookie);
	for (const part of source.split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return decodeURIComponent(v.join('='));
	}
	return null;
}

export async function parseError(response: Response): Promise<ApiError> {
	let body: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
	try {
		body = await response.json();
	} catch {
		/* non-JSON error (e.g. proxy failure) */
	}
	const error = body?.error;
	return new ApiError(
		response.status,
		error?.code ?? `HTTP_${response.status}`,
		error?.message ?? `Request failed (${response.status})`,
		error?.details ?? null
	);
}

export type RequestOptions = {
	method?: string;
	body?: unknown;
	query?: Record<string, string | number | boolean | undefined | null>;
	fetch?: typeof fetch;
	signal?: AbortSignal;
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const method = (options.method ?? 'GET').toUpperCase();
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (options.body !== undefined) headers['Content-Type'] = 'application/json';
	if (UNSAFE.has(method)) {
		const csrf = readCookie(CSRF_COOKIE);
		if (csrf) headers['X-CSRF-Token'] = csrf;
	}
	let url = `${API_BASE}${path}`;
	if (options.query) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(options.query)) {
			if (v !== undefined && v !== null) params.set(k, String(v));
		}
		const qs = params.toString();
		if (qs) url += `?${qs}`;
	}
	const response = await (options.fetch ?? fetch)(url, {
		method,
		headers,
		body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
		credentials: 'same-origin',
		signal: options.signal
	});
	if (!response.ok) throw await parseError(response);
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}
