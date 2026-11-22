/**
 * Doors, windows, lights and appliances shared between players.
 *
 * A change is shown at once where it was made and sent to the server, which keeps it for the
 * room and sends it to everyone around, the sender too ("mine"), all in one order, so every
 * client ends where the server did. While one of my own changes to a thing is on its way, what
 * the server sends about that thing is older than my change (the server handled it first) and
 * is skipped, so the thing does not flick back to a stale state; my change coming back settles
 * it.
 */
import type { ClientMessage, ServerMessage, SwitchKind } from './protocol';

type BuildingState = Extract<ServerMessage, { t: 'bstate' }>;

export class BuildingSync {
	/** My changes on their way, per "building|kind:id". */
	private pending = new Map<string, number>();

	constructor(private send: (message: ClientMessage) => boolean) {}

	/** The player opened or closed a door or window, or switched a light or an appliance. */
	set(building: string, kind: SwitchKind, id: string, on: boolean): void {
		if (!this.send({ t: 'bset', b: building, k: kind, id, on })) return;
		const key = `${building}|${kind}:${id}`;
		this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
	}

	/** What players changed in a building (asked when it is loaded). */
	ask(building: string): boolean {
		return this.send({ t: 'bget', b: building });
	}

	/** The values of a server message to show here. */
	receive(message: BuildingState): Record<string, boolean> {
		const out: Record<string, boolean> = {};
		for (const [part, on] of Object.entries(message.s)) {
			const key = `${message.b}|${part}`;
			const waiting = this.pending.get(key) ?? 0;
			if (message.mine && waiting > 0) {
				if (waiting > 1) {
					this.pending.set(key, waiting - 1);
					continue; // a newer change of mine is still on its way
				}
				this.pending.delete(key);
			} else if (waiting > 0) continue; // older than my change on its way
			out[part] = on;
		}
		return out;
	}

	/** Is a change of mine to this part ("door:front") on its way? */
	waiting(building: string, part: string): boolean {
		return (this.pending.get(`${building}|${part}`) ?? 0) > 0;
	}

	/** After a reconnect nothing is on its way any more. */
	reset(): void {
		this.pending.clear();
	}
}
