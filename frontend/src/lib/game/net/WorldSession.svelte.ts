/**
 * Multiplayer session for the world page: connects the socket, the city engine and the
 * remote avatars, and exposes reactive state (presence, chat, toasts, invites) to the UI.
 */
import type { CityController } from '$lib/game/city/CityEngine';
import { MODES } from '$lib/game/vehicles/specs';
import { ParkedVehicles } from './ParkedVehicles';
import { RemotePlayers, type RemoteSummary } from './RemotePlayers';
import { WorldSocket, type SocketStatus } from './WorldSocket';
import type { ChatChannel, EmoteName, ParkedCard, ServerMessage } from './protocol';

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
	/** Bumped when storefronts changed (a shop opened, closed or restocked). */
	shopsVersion = $state(0);
	/** Bumped when one of my orders (as buyer or merchant) changed. */
	ordersVersion = $state(0);
	/** Phase 5: bumped when my vehicles changed (mounted, parked, moved). */
	vehiclesVersion = $state(0);
	/** My parked vehicle within reach (F to ride), refreshed with the nearby list. */
	reachable = $state<ParkedCard | null>(null);
	/** Waiting for the server to answer a mount or dismount. */
	pendingRide = $state(false);
	/** Movement the server rejected (diagnostics). */
	corrections = 0;
	lastCorrection = '';

	readonly remotes: RemotePlayers;
	readonly parked: ParkedVehicles;
	private socket: WorldSocket;
	private unsubscribe: () => void = () => {};
	private seq = 0;
	private lastSent = { x: NaN, z: NaN, yaw: NaN, s: NaN, at: 0 };
	private listTimer = 0;

	constructor(private city: CityController, url?: string) {
		this.remotes = new RemotePlayers(city.scene, city.terrain);
		this.parked = new ParkedVehicles(city.scene, city.terrain, city.collision);
		this.socket = new WorldSocket({
			url,
			onMessage: (m) => this.receive(m),
			onStatus: (status, detail) => {
				this.status = status;
				this.detail = detail ?? '';
				if (status !== 'open') {
					this.remotes.clear();
					this.parked.clearAll();
				}
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
		this.parked.dispose();
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
			const reach = this.city.riding ? null : this.parked.mineWithin(st.x, st.z);
			if (reach?.id !== this.reachable?.id) this.reachable = reach;
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

	/** Fast travel to the pavement in front of a shop (the server places you). */
	travelToShop(shopId: string): boolean {
		return this.socket.send({ t: 'travel', shop: shopId });
	}

	/** Get on my vehicle (the server checks ownership and distance). */
	mount(vehicleId: string): boolean {
		if (this.pendingRide) return false;
		const sent = this.socket.send({ t: 'mount', v: vehicleId });
		this.pendingRide = sent;
		return sent;
	}

	/** Park here (the server pulls over to the nearest legal spot within a few metres). */
	dismount(): boolean {
		if (this.pendingRide) return false;
		const sent = this.socket.send({ t: 'dismount' });
		this.pendingRide = sent;
		return sent;
	}

	/** Where parking would put the vehicle on the client's map (null: pull over first). */
	parkingSpot() {
		const riding = this.city.riding;
		if (!riding) return null;
		const gap = MODES[riding.kind].parkingSpacing;
		return this.city.parkingSpot((x, z) => this.parked.clear(x, z, gap));
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
				if (['TOO_FAR', 'VEHICLE_NOT_FOUND', 'ALREADY_RIDING', 'NOT_RIDING', 'PARKING_NOT_ALLOWED'].includes(m.code)) {
					this.pendingRide = false;
					this.toast(m.message, 'warning');
					break;
				}
				this.pushChat({ channel: 'system', text: m.message, ts: Date.now() });
				break;
			case 'shops':
				this.shopsVersion++;
				break;
			case 'order': {
				const what: Record<string, string> = {
					paid: 'New order',
					merchant_accepted: 'accepted by the shop',
					preparing: 'being prepared',
					ready_for_pickup: 'ready for pickup',
					completed: 'completed',
					refunded: 'cancelled and refunded (demo)'
				};
				this.toast(
					m.status === 'paid' ? `New order ${m.number} (demo payment)` : `Order ${m.number} is ${what[m.status] ?? m.status}.`,
					'info'
				);
				this.ordersVersion++;
				break;
			}
			case 'ride':
				if (m.id === this.me?.id) {
					this.pendingRide = false;
					this.city.setRiding(
						m.v ? { id: m.v.id, kind: m.v.k, color: m.v.c } : null,
						m.x ?? this.city.localState().x,
						m.z ?? this.city.localState().z,
						m.yaw ?? this.city.localState().yaw
					);
					this.lastSent.at = 0;
					this.vehiclesVersion++;
				} else this.remotes.ride(m.id, m.v);
				break;
			case 'vspawn':
				this.parked.spawn(m.v);
				if (m.v.mine) this.vehiclesVersion++;
				break;
			case 'vdespawn':
				this.parked.despawn(m.id);
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
			case 'vehicle_parked':
				this.toast(m.text ?? 'Your vehicle is parked.', 'info');
				this.vehiclesVersion++;
				return;
		}
		this.socialVersion++;
	}

	private pushChat(line: Omit<ChatLine, 'key'>) {
		this.chat = [...this.chat.slice(-(MAX_CHAT - 1)), { ...line, key: ++this.seq }];
	}

	/** Show a toast from the page (shopping feedback uses the same stack). */
	say(text: string, kind: Toast['kind'] = 'info') {
		this.toast(text, kind);
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
