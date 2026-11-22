import { describe, expect, it } from 'vitest';
import { BuildingSync } from './BuildingSync';
import type { ClientMessage, ServerMessage } from './protocol';

type State = Extract<ServerMessage, { t: 'bstate' }>;
const B = 'osm:308';
const state = (s: Record<string, boolean>, extra: Partial<State> = {}): State => ({ t: 'bstate', b: B, s, ...extra });

describe('sharing doors, lights and appliances', () => {
	it('sends a change and settles on it when it comes back', () => {
		const sent: ClientMessage[] = [];
		const sync = new BuildingSync((m) => (sent.push(m), true));
		sync.set(B, 'door', 'front', true);
		expect(sent).toEqual([{ t: 'bset', b: B, k: 'door', id: 'front', on: true }]);
		expect(sync.receive(state({ 'door:front': true }, { mine: true }))).toEqual({ 'door:front': true });
		// Nothing of mine on its way any more: other players' changes show.
		expect(sync.receive(state({ 'door:front': false }))).toEqual({ 'door:front': false });
	});

	it("skips what the server handled before my change, and only mine settles it", () => {
		const sync = new BuildingSync(() => true);
		sync.set(B, 'light', 'living', true);
		// Someone else's change, sent before mine was handled: mine comes after it.
		expect(sync.receive(state({ 'light:living': false, 'door:front': true }))).toEqual({ 'door:front': true });
		expect(sync.receive(state({ 'light:living': true }, { mine: true }))).toEqual({ 'light:living': true });
	});

	it('with two of my changes on their way, the first one back is skipped', () => {
		const sync = new BuildingSync(() => true);
		sync.set(B, 'door', 'front', true);
		sync.set(B, 'door', 'front', false);
		expect(sync.receive(state({ 'door:front': true }, { mine: true }))).toEqual({});
		expect(sync.receive(state({ 'door:front': false }, { mine: true }))).toEqual({ 'door:front': false });
	});

	it('a building loaded meanwhile takes the server state, except what I just changed', () => {
		const sync = new BuildingSync(() => true);
		sync.set(B, 'app', 'tv', true);
		expect(sync.waiting(B, 'app:tv')).toBe(true);
		expect(sync.waiting(B, 'door:front')).toBe(false);
		expect(sync.receive(state({ 'app:tv': false, 'door:front': true }, { all: true }))).toEqual({ 'door:front': true });
	});

	it('nothing is waiting for a change that was not sent, or after reconnecting', () => {
		let open = false;
		const sync = new BuildingSync(() => open);
		sync.set(B, 'door', 'front', true); // offline: not sent
		expect(sync.receive(state({ 'door:front': false }))).toEqual({ 'door:front': false });
		open = true;
		sync.set(B, 'door', 'front', true);
		sync.reset();
		expect(sync.receive(state({ 'door:front': false }, { all: true }))).toEqual({ 'door:front': false });
	});

	it('players switching the same light at once all end where the server did, without flicker', () => {
		// Two clients and a server that handles their messages in an arbitrary order but sends
		// its answers in the order it handled them (one socket each).
		let seed = 7;
		const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		let contested = 0;
		for (let round = 0; round < 200; round++) {
			const server: Record<string, boolean> = {};
			const inbox: State[][] = [[], []];
			const outbox: { from: number; m: ClientMessage }[] = [];
			const shown: Record<string, boolean>[] = [{}, {}];
			const handled: number[] = [];
			// Presses whose echo has not come back yet, and the last press, per client.
			const inFlight = [0, 0];
			const last: boolean[] = [false, false];
			const clients = [0, 1].map((i) => new BuildingSync((m) => (outbox.push({ from: i, m }), true)));
			const press = (i: number) => {
				const on = !(shown[i]['light:living'] ?? false);
				shown[i]['light:living'] = on; // shown at once
				clients[i].set(B, 'light', 'living', on);
				inFlight[i]++;
				last[i] = on;
			};
			const handle = () => {
				// Either client's oldest message (each socket keeps its own order).
				const pick = random() < 0.5 ? 0 : 1;
				const at = outbox.findIndex((x) => x.from === pick);
				const { from, m } = outbox.splice(at >= 0 ? at : 0, 1)[0];
				if (m.t !== 'bset') return;
				server[`${m.k}:${m.id}`] = m.on;
				handled.push(from);
				for (const i of [0, 1]) inbox[i].push(state({ [`${m.k}:${m.id}`]: m.on }, i === from ? { mine: true } : {}));
			};
			const deliver = (i: number) => {
				const m = inbox[i].shift();
				if (!m) return;
				Object.assign(shown[i], clients[i].receive(m));
				if (m.mine) inFlight[i]--;
				// While a press of mine is on its way, I keep seeing it (no stale state back).
				if (inFlight[i] > 0) expect(shown[i]['light:living']).toBe(last[i]);
			};
			for (let step = 0; step < 12; step++) {
				const r = random();
				if (r < 0.3) press(r < 0.15 ? 0 : 1);
				else if (r < 0.6 && outbox.length) handle();
				else deliver(r < 0.8 ? 0 : 1);
			}
			while (outbox.length) handle();
			while (inbox[0].length || inbox[1].length) {
				deliver(0);
				deliver(1);
			}
			if (!('light:living' in server)) continue;
			if (new Set(handled).size > 1) contested++;
			expect(shown[0]['light:living']).toBe(server['light:living']);
			expect(shown[1]['light:living']).toBe(server['light:living']);
		}
		expect(contested).toBeGreaterThan(30); // rounds where both players switched it
	});
});
