/** WebSocket protocol types (see backend/app/multiplayer/protocol.py). */
import type { Avatar } from '$lib/api/types';

export const EMOTES = ['wave', 'sampeah', 'cheer', 'dance'] as const;
export type EmoteName = (typeof EMOTES)[number];
export type ChatChannel = 'nearby' | 'world';

export interface PlayerCard {
	id: number;
	u: string;
	n: string;
	av: Avatar;
	x: number;
	z: number;
	yaw: number;
}

/** [id, x, z, yaw, speed] */
export type PlayerState = [number, number, number, number, number];

export type ServerMessage =
	| { t: 'welcome'; room: string; tick: number; you: { id: number; u: string; n: string; visible: boolean }; x: number; z: number; yaw: number; online: number }
	| { t: 'spawn'; p: PlayerCard }
	| { t: 'despawn'; id: number; why: string }
	| { t: 'state'; ts: number; p: PlayerState[] }
	| { t: 'chat'; id?: number; u: string; n: string; ch: ChatChannel; text: string; ts: number }
	| { t: 'emote'; id: number; e: EmoteName }
	| { t: 'teleport'; x: number; z: number; yaw: number; why: string }
	| { t: 'correct'; x: number; z: number; why: string }
	| { t: 'invite'; u: string; n: string }
	| { t: 'notify'; kind: string; u?: string; n?: string; text?: string; ts?: number }
	| { t: 'online'; n: number }
	| { t: 'pong'; c: number; s: number }
	| { t: 'error'; code: string; message: string }
	| { t: 'kicked'; why: string };

export type ClientMessage =
	| { t: 'move'; x: number; z: number; yaw: number; s: number }
	| { t: 'chat'; ch: ChatChannel; text: string }
	| { t: 'emote'; e: EmoteName }
	| { t: 'travel'; spawn: string }
	| { t: 'invite'; to: string }
	| { t: 'join'; from: string }
	| { t: 'ping'; c: number };

/** Close codes that mean "do not reconnect automatically". */
export const FINAL_CLOSE_CODES: Record<number, string> = {
	4401: 'Your session has ended. Please sign in again.',
	4403: 'This page is not allowed to join the world.',
	4409: 'Finish setting up your account first.',
	4003: 'Your account has been suspended.',
	4009: 'You joined the world from another tab or device.'
};
