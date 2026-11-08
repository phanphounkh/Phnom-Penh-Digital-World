/**
 * The world WebSocket: same-origin, cookie-authenticated, with automatic reconnection
 * (exponential backoff) except after "final" close codes such as a suspended account.
 */
import { FINAL_CLOSE_CODES, type ClientMessage, type ServerMessage } from './protocol';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'rejected';

type WebSocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
	onopen: ((ev: Event) => void) | null;
	onmessage: ((ev: MessageEvent) => void) | null;
	onclose: ((ev: CloseEvent) => void) | null;
	onerror: ((ev: Event) => void) | null;
};

export interface WorldSocketOptions {
	url?: string;
	onMessage: (msg: ServerMessage) => void;
	onStatus?: (status: SocketStatus, detail?: string) => void;
	create?: (url: string) => WebSocketLike;
	schedule?: (fn: () => void, ms: number) => unknown;
}

export function worldSocketUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
	return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/v1/world/ws`;
}

export class WorldSocket {
	status: SocketStatus = 'closed';
	rtt = 0;
	private ws: WebSocketLike | null = null;
	private attempt = 0;
	private stopped = false;
	private pingTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private options: WorldSocketOptions) {}

	connect(): void {
		this.stopped = false;
		this.setStatus(this.attempt ? 'reconnecting' : 'connecting');
		const create = this.options.create ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
		const ws = create(this.options.url ?? worldSocketUrl());
		this.ws = ws;
		ws.onopen = () => {
			this.attempt = 0;
			this.setStatus('open');
			clearInterval(this.pingTimer);
			this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 5000);
		};
		ws.onmessage = (event) => {
			let msg: ServerMessage;
			try {
				msg = JSON.parse(event.data as string);
			} catch {
				return;
			}
			if (msg.t === 'pong') this.rtt = Math.round(performance.now() - msg.c);
			this.options.onMessage(msg);
		};
		ws.onclose = (event) => {
			clearInterval(this.pingTimer);
			if (this.ws !== ws) return;
			this.ws = null;
			if (this.stopped) return this.setStatus('closed');
			const final = FINAL_CLOSE_CODES[event.code];
			if (final) {
				this.stopped = true;
				return this.setStatus('rejected', final);
			}
			const delay = Math.min(15000, 1000 * 2 ** this.attempt++);
			this.setStatus('reconnecting', `Reconnecting in ${Math.round(delay / 1000)} s`);
			(this.options.schedule ?? setTimeout)(() => {
				if (!this.stopped) this.connect();
			}, delay);
		};
		ws.onerror = () => {
			/* onclose follows */
		};
	}

	send(msg: ClientMessage): boolean {
		if (!this.ws || this.ws.readyState !== 1) return false;
		this.ws.send(JSON.stringify(msg));
		return true;
	}

	close(): void {
		this.stopped = true;
		clearInterval(this.pingTimer);
		this.ws?.close(1000);
		this.ws = null;
		this.setStatus('closed');
	}

	private setStatus(status: SocketStatus, detail?: string) {
		this.status = status;
		this.options.onStatus?.(status, detail);
	}
}
