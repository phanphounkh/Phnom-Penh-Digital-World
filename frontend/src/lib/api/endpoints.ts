import { api } from './client';
import type {
	Address,
	Avatar,
	ChunkPayload,
	Conversation,
	DirectMessage,
	Friend,
	PlayerReport,
	ReportReason,
	Language,
	Me,
	Onboarding,
	ReverseResult,
	RoleRequest,
	SearchResult,
	SessionResponse,
	SpawnPoint,
	Verification,
	WorldBootstrap,
	WorldConfig
} from './types';

type F = { fetch?: typeof fetch };

export const auth = {
	me: (o: F = {}) => api<Me>('/auth/me', o),
	register: (body: {
		username: string;
		email?: string | null;
		phone?: string | null;
		password: string;
		display_name: string;
		preferred_language: Language;
		accept_terms: boolean;
		accept_privacy: boolean;
	}) => api<SessionResponse>('/auth/register', { method: 'POST', body }),
	login: (identifier: string, password: string) =>
		api<SessionResponse>('/auth/login', { method: 'POST', body: { identifier, password } }),
	logout: () => api<{ message: string }>('/auth/logout', { method: 'POST' }),
	sendCode: (channel?: 'email' | 'phone') =>
		api<Verification>('/auth/verification/send', { method: 'POST', body: { channel } }),
	confirmCode: (code: string) =>
		api<Me>('/auth/verification/confirm', { method: 'POST', body: { code } })
};

export const me = {
	updateProfile: (body: Partial<{ display_name: string; preferred_language: Language }>) =>
		api<Me>('/me/profile', { method: 'PATCH', body }),
	avatar: (o: F = {}) => api<Avatar & { model: string }>('/me/avatar', o),
	saveAvatar: (body: Avatar) => api<Avatar>('/me/avatar', { method: 'PUT', body }),
	chooseRoles: (body: { roles: string[]; seller_note?: string; driver_note?: string }) =>
		api<Me>('/me/roles', { method: 'POST', body }),
	addresses: (o: F = {}) => api<Address[]>('/me/addresses', o),
	addAddress: (body: {
		label: string;
		lat: number;
		lon: number;
		address_line: string;
		details?: string | null;
		is_default?: boolean;
	}) => api<Address>('/me/addresses', { method: 'POST', body }),
	deleteAddress: (id: string) => api(`/me/addresses/${id}`, { method: 'DELETE' }),
	chooseSpawn: (spawn_point_id: string, world_visible: boolean) =>
		api<Me>('/me/spawn', { method: 'PUT', body: { spawn_point_id, world_visible } }),
	completeOnboarding: () => api<Onboarding>('/me/onboarding/complete', { method: 'POST' })
};

export const geo = {
	spawnPoints: (o: F = {}) => api<SpawnPoint[]>('/geo/spawn-points', o),
	search: (q: string, signal?: AbortSignal) =>
		api<SearchResult[]>('/geo/search', { query: { q, limit: 8 }, signal }),
	reverse: (lat: number, lon: number) =>
		api<ReverseResult>('/geo/reverse', { query: { lat, lon } }),
	serviceArea: () => api<GeoJSON.Feature>('/geo/service-area')
};

export const world = {
	config: (o: F = {}) => api<WorldConfig>('/world/config', o),
	bootstrap: (o: F = {}) => api<WorldBootstrap>('/world/bootstrap', o),
	chunk: (key: string, signal?: AbortSignal) =>
		api<ChunkPayload>(`/world/chunks/${key}`, { signal })
};

const enc = encodeURIComponent;

export const social = {
	friends: () => api<Friend[]>('/social/friends'),
	addFriend: (username: string) => api<{ message: string }>('/social/friends', { method: 'POST', body: { username } }),
	accept: (u: string) => api(`/social/friends/${enc(u)}/accept`, { method: 'POST' }),
	decline: (u: string) => api(`/social/friends/${enc(u)}/decline`, { method: 'POST' }),
	unfriend: (u: string) => api(`/social/friends/${enc(u)}`, { method: 'DELETE' }),
	relations: () => api<{ blocked: string[]; muted: string[] }>('/social/relations'),
	block: (u: string) => api(`/social/blocks/${enc(u)}`, { method: 'POST' }),
	unblock: (u: string) => api(`/social/blocks/${enc(u)}`, { method: 'DELETE' }),
	mute: (u: string) => api(`/social/mutes/${enc(u)}`, { method: 'POST' }),
	unmute: (u: string) => api(`/social/mutes/${enc(u)}`, { method: 'DELETE' }),
	conversations: () => api<Conversation[]>('/social/conversations'),
	thread: (u: string) => api<DirectMessage[]>(`/social/messages/${enc(u)}`),
	sendMessage: (u: string, text: string) =>
		api<DirectMessage>(`/social/messages/${enc(u)}`, { method: 'POST', body: { text } }),
	report: (username: string, reason: ReportReason, details?: string) =>
		api<{ message: string }>('/social/reports', { method: 'POST', body: { username, reason, details } })
};

export const admin = {
	roleRequests: (status = 'pending') =>
		api<RoleRequest[]>('/admin/role-requests', { query: { status } }),
	approve: (id: string, reason?: string) =>
		api<RoleRequest>(`/admin/role-requests/${id}/approve`, { method: 'POST', body: { reason } }),
	reject: (id: string, reason?: string) =>
		api<RoleRequest>(`/admin/role-requests/${id}/reject`, { method: 'POST', body: { reason } }),
	reports: (status = 'open') => api<PlayerReport[]>('/admin/reports', { query: { status } }),
	resolve: (id: string, action: 'dismiss' | 'warn' | 'chat_mute' | 'suspend', hours = 24, note?: string) =>
		api<{ message: string }>(`/admin/reports/${id}/resolve`, { method: 'POST', body: { action, hours, note } })
};
