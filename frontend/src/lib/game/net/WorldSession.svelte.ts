/**
 * Multiplayer session for the world page: connects the socket, the city engine and the
 * remote avatars, and exposes reactive state (presence, chat, toasts, invites) to the UI.
 */
import type { CityController } from '$lib/game/city/CityEngine';
import { RemotePlayers, type RemoteSummary } from './RemotePlayers';
import { WorldSocket, type SocketStatus } from './WorldSocket';
import type { ChatChannel, EmoteName, ServerMessage } from './protocol';

export interface ChatLine {
	key: number;
	channel: ChatChannel | 'system' | 'dm';
	from?: string;
	name?: string;
	text: string;
	ts: number;
	mine?: boolean;
}

export interface Toast {
	key: number;
	text: string;
	kind: 'info' | 'invite' | 'warning';
	from?: string;
}

const SEND_INTERVAL_MS = 100;
const MAX_CHAT = 80;

export class WorldSession {
	status = $state<SocketStatus>('connecting');
	detail = $state('');
	online = $state(0);
	room = $state('');
	me = $state<{ id: number; u: string; n: string; visible: boolean } | null>(null);
	chat = $state<ChatLine[]>([]);
	nearby = $state<RemoteSummary[]>([]);
	toasts = $state<Toast[]>([]);
	rtt = $state(0);
	/** Bumped when friends/messages may have changed (the UI refetches). */
	socialVersion = $state(0);
	/** Movement the server rejected (diagnostics). */
	corrections = 0;
	lastCorrection = '';

	readonly remotes: RemotePlayers;
	private socket: WorldSocket;
	private unsubscribe: () => void = () => {};
	private seq = 0;
	private lastSent = { x: NaN, z: NaN, yaw: NaN, s: NaN, at: 0 };
	private listTimer = 0;

	constructor(private city: CityController, url?: string) {
		this.remotes = new RemotePlayers(city.scene, city.terrain);
		this.socket = new WorldSocket({
			url,
			onMessage: (m) => this.receive(m),
			onStatus: (status, detail) => {
				this.status = status;
				this.detail = detail ?? '';
				if (status !== 'open') this.remotes.clear();
			}
		});
	}

	start(): void {
		this.socket.connect();
		this.unsubscribe = this.city.onFrame((dt) => this.frame(dt));
	}

	stop(): void {
		this.unsubscribe();
		this.socket.close();
		this.remotes.clear();
	}

	// ── outgoing ──────────────────────────────────────────────────────────────────────
	private frame(dt: number) {
		this.remotes.update(dt, this.city.camera.position);
		const now = performance.now();
		const st = this.city.localState();
		const last = this.lastSent;
		if (now - last.at >= SEND_INTERVAL_MS) {
			const changed =
				Math.hypot(st.x - last.x, st.z - last.z) > 0.02 ||
				Math.abs(st.yaw - last.yaw) > 0.02 ||
				Math.abs(st.speed - last.s) > 0.2;
			if (changed || Number.isNaN(last.x)) {
				const speed = st.speed < 0.05 ? 0 : st.speed;
				if (this.socket.send({ t: 'move', x: round(st.x), z: round(st.z), yaw: round(st.yaw, 3), s: round(speed) }))
					this.lastSent = { x: st.x, z: st.z, yaw: st.yaw, s: speed, at: now };
			}
		}
		if (now - this.listTimer > 500) {
			this.listTimer = now;
			this.nearby = this.remotes.list(st.x, st.z);
			this.rtt = this.socket.rtt;
		}
	}

	sendChat(channel: ChatChannel, text: string): boolean {
		const body = text.trim();
		return !!body && this.socket.send({ t: 'chat', ch: channel, text: body });
	}

	emote(name: EmoteName): void {
		this.city.playEmote(name);
		this.socket.send({ t: 'emote', e: name });
	}

	travel(spawn: string): boolean {
		return this.socket.send({ t: 'travel', spawn });
	}

	invite(username: string): void {
		this.socket.send({ t: 'invite', to: username });
	}

	join(username: string): void {
		this.socket.send({ t: 'join', from: username });
		this.dismissFrom(username);
	}

	dismiss(key: number): void {
		this.toasts = this.toasts.filter((t) => t.key !== key);
	}

	private dismissFrom(username: string) {
		this.toasts = this.toasts.filter((t) => t.from !== username);
	}

	// ── incoming ──────────────────────────────────────────────────────────────────────
	private receive(m: ServerMessage) {
		switch (m.t) {
			case 'welcome':
				this.me = m.you;
				this.room = m.room;
				this.online = m.online;
				this.city.setPosition(m.x, m.z, m.yaw);
				this.lastSent = { x: m.x, z: m.z, yaw: m.yaw, s: 0, at: 0 };
				break;
			case 'spawn':
				this.remotes.spawn(m.p);
				break;
			case 'despawn':
				this.remotes.despawn(m.id);
				break;
			case 'state':
				this.remotes.state(m.p);
				break;
			case 'chat': {
				const mine = m.u === this.me?.u;
				this.pushChat({ channel: m.ch, from: m.u, name: m.n, text: m.text, ts: m.ts, mine });
				if (m.ch === 'nearby' && m.id !== undefined && !mine) this.remotes.say(m.id, m.text);
				break;
			}
			case 'emote':
				if (m.id !== this.me?.id) this.remotes.emote(m.id, m.e);
				break;
			case 'correct':
				this.corrections++;
				this.lastCorrection = m.why;
				this.city.setPosition(m.x, m.z);
				this.lastSent.at = 0;
				break;
			case 'teleport':
				this.city.setPosition(m.x, m.z, m.yaw);
				this.lastSent.at = 0;
				if (m.why === 'join') this.toast('You joined your friend.', 'info');
				break;
			case 'invite':
				this.toast(`${m.n} (@${m.u}) invites you to join them.`, 'invite', m.u);
				break;
			case 'notify':
				this.notify(m);
				break;
			case 'online':
				this.online = m.n;
				break;
			case 'error':
				this.pushChat({ channel: 'system', text: m.message, ts: Date.now() });
				break;
			case 'kicked':
				this.detail = {
					replaced: 'You joined the world from another tab or device.',
					suspended: 'Your account has been suspended.',
					session_ended: 'Your session has ended. Please sign in again.'
				}[m.why] ?? 'You were disconnected.';
				break;
		}
	}

	private notify(m: Extract<ServerMessage, { t: 'notify' }>) {
		const who = m.n ? `${m.n} (@${m.u})` : `@${m.u}`;
		switch (m.kind) {
			case 'friend_request':
				this.toast(`${who} sent you a friend request.`, 'info');
				break;
			case 'friend_accepted':
				this.toast(`${who} accepted your friend request.`, 'info');
				break;
			case 'friend_online':
				this.toast(`${who} is online.`, 'info');
				break;
			case 'friend_offline':
				break;
			case 'invite_sent':
				this.pushChat({ channel: 'system', text: `Invitation sent to ${who}.`, ts: Date.now() });
				break;
			case 'dm':
				this.pushChat({ channel: 'dm', from: m.u, name: m.n, text: m.text ?? '', ts: m.ts ?? Date.now() });
				this.toast(`New message from ${who}`, 'info');
				break;
			case 'moderation':
				this.toast(m.text ?? 'A moderator contacted you.', 'warning');
				break;
		}
		this.socialVersion++;
	}

	private pushChat(line: Omit<ChatLine, 'key'>) {
		this.chat = [...this.chat.slice(-(MAX_CHAT - 1)), { ...line, key: ++this.seq }];
	}

	private toast(text: string, kind: Toast['kind'], from?: string) {
		const key = ++this.seq;
		this.toasts = [...this.toasts.slice(-3), { key, text, kind, from }];
		if (kind !== 'invite') setTimeout(() => this.dismiss(key), 6000);
		else setTimeout(() => this.dismiss(key), 300_000);
	}
}

function round(v: number, digits = 2) {
	const k = 10 ** digits;
	return Math.round(v * k) / k;
}
