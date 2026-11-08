import { describe, expect, it, vi } from 'vitest';
import { WorldSocket, worldSocketUrl } from './WorldSocket';

class FakeSocket {
	readyState = 0;
	sent: string[] = [];
	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.(new Event('open'));
	}
	receive(msg: unknown) {
		this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
	}
	drop(code: number) {
		this.readyState = 3;
		this.onclose?.({ code } as CloseEvent);
	}
}

function setup() {
	const sockets: FakeSocket[] = [];
	const scheduled: { fn: () => void; ms: number }[] = [];
	const messages: unknown[] = [];
	const statuses: string[] = [];
	const socket = new WorldSocket({
		url: 'ws://test/api/v1/world/ws',
		create: () => {
			const s = new FakeSocket();
			sockets.push(s);
			return s;
		},
		schedule: (fn, ms) => scheduled.push({ fn, ms }),
		onMessage: (m) => messages.push(m),
		onStatus: (s, d) => statuses.push(d ? `${s}: ${d}` : s)
	});
	return { socket, sockets, scheduled, messages, statuses };
}

describe('WorldSocket', () => {
	it('builds same-origin ws/wss URLs', () => {
		expect(worldSocketUrl({ protocol: 'https:', host: 'world.example.com' })).toBe('wss://world.example.com/api/v1/world/ws');
		expect(worldSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/v1/world/ws');
	});

	it('delivers messages and only sends while open', () => {
		vi.useFakeTimers();
		const { socket, sockets, messages } = setup();
		socket.connect();
		expect(socket.send({ t: 'emote', e: 'wave' })).toBe(false);
		sockets[0].open();
		expect(socket.send({ t: 'emote', e: 'wave' })).toBe(true);
		sockets[0].receive({ t: 'online', n: 3 });
		expect(messages).toEqual([{ t: 'online', n: 3 }]);
		socket.close();
		vi.useRealTimers();
	});

	it('reconnects with exponential backoff after network drops', () => {
		vi.useFakeTimers();
		const { socket, sockets, scheduled } = setup();
		socket.connect();
		sockets[0].drop(1006);
		expect(scheduled.map((s) => s.ms)).toEqual([1000]);
		scheduled[0].fn();
		sockets[1].drop(1006);
		expect(scheduled.map((s) => s.ms)).toEqual([1000, 2000]);
		scheduled[1].fn();
		sockets[2].open();
		sockets[2].drop(1006);
		expect(scheduled[2].ms).toBe(1000); // success resets the backoff
		socket.close();
		vi.useRealTimers();
	});

	it('does not reconnect after final close codes', () => {
		const { socket, sockets, scheduled, statuses } = setup();
		socket.connect();
		sockets[0].drop(4009);
		expect(scheduled).toEqual([]);
		expect(socket.status).toBe('rejected');
		expect(statuses.at(-1)).toContain('another tab');
	});
});
