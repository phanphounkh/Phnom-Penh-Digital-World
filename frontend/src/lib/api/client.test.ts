import { describe, expect, it } from 'vitest';
import { ApiError, parseError, readCookie } from './client';

describe('api client', () => {
	it('reads cookies by name', () => {
		const jar = 'a=1; ppw_csrf=abc%3D%3D; other=x=y';
		expect(readCookie('ppw_csrf', jar)).toBe('abc==');
		expect(readCookie('other', jar)).toBe('x=y');
		expect(readCookie('missing', jar)).toBeNull();
	});

	it('parses the backend error envelope', async () => {
		const response = new Response(
			JSON.stringify({ error: { code: 'ACCOUNT_EXISTS', message: 'Taken', details: null } }),
			{ status: 409 }
		);
		const error = await parseError(response);
		expect(error).toBeInstanceOf(ApiError);
		expect([error.status, error.code, error.message]).toEqual([409, 'ACCOUNT_EXISTS', 'Taken']);
	});

	it('survives non-JSON failures', async () => {
		const error = await parseError(new Response('Bad gateway', { status: 502 }));
		expect(error.code).toBe('HTTP_502');
	});

	it('maps validation details to field errors', () => {
		const error = new ApiError(422, 'VALIDATION_ERROR', 'Invalid', [
			{ field: 'username', message: 'Too short', type: 'x' },
			{ field: 'username', message: 'Second', type: 'x' },
			{ field: '', message: 'Provide an email address or a phone number', type: 'x' }
		]);
		expect(error.fieldErrors).toEqual({
			username: 'Too short',
			_: 'Provide an email address or a phone number'
		});
	});
});
