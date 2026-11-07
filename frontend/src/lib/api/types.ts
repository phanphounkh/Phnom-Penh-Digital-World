/** Mirrors backend/app/schemas. Keep in sync with the OpenAPI document at /api/docs. */

export type Language = 'en' | 'km';
export type RoleName = 'visitor' | 'buyer' | 'seller' | 'driver' | 'admin';
export type RoleStatus = 'active' | 'pending' | 'rejected' | 'revoked';
export type OnboardingStep = 'verify' | 'avatar' | 'role' | 'location' | 'complete' | 'world';

export interface Role {
	role: RoleName;
	status: RoleStatus;
	requested_at: string;
	decided_at: string | null;
	decision_reason: string | null;
}

export interface Onboarding {
	verified: boolean;
	avatar: boolean;
	roles: boolean;
	location: boolean;
	needs_address: boolean;
	completed: boolean;
	next_step: OnboardingStep;
}

export interface Me {
	id: string;
	username: string;
	display_name: string;
	email: string | null;
	phone: string | null;
	email_verified: boolean;
	phone_verified: boolean;
	preferred_language: Language;
	world_visible: boolean | null;
	roles: Role[];
	active_roles: RoleName[];
	onboarding: Onboarding;
	created_at: string;
}

export interface Verification {
	channel: 'email' | 'phone';
	destination: string;
	expires_at: string;
	resend_after_seconds: number;
	dev_code: string | null;
}

export interface SessionResponse {
	user: Me;
	csrf_token: string;
	expires_at: string;
	verification: Verification | null;
}

export type HairStyle = 'short' | 'long' | 'bun' | 'buzz';
export type Accessory = 'cap' | 'glasses' | 'backpack' | 'krama';

export interface Avatar {
	avatar_name: string;
	body: 'a' | 'b';
	skin_tone: string;
	hair_style: HairStyle;
	hair_color: string;
	top_style: 'hoodie' | 'tee';
	top_color: string;
	bottom_style: 'trousers' | 'shorts';
	bottom_color: string;
	shoe_color: string;
	accent_color: string;
	accessories: Accessory[];
}

export interface Address {
	id: string;
	label: string;
	lat: number;
	lon: number;
	address_line: string;
	details: string | null;
	is_default: boolean;
	created_at: string;
}

export interface SpawnPoint {
	id: string;
	slug: string;
	name: string;
	name_km: string | null;
	description: string;
	lat: number;
	lon: number;
	x: number;
	z: number;
	heading_deg: number;
	region: string;
}

export interface SearchResult {
	kind: string;
	name: string;
	name_en: string | null;
	name_km: string | null;
	lat: number;
	lon: number;
	in_playable_area: boolean;
	in_service_area: boolean;
}

export interface ReverseResult {
	lat: number;
	lon: number;
	street: string | null;
	street_km: string | null;
	area: string | null;
	area_kind: string | null;
	in_playable_area: boolean;
	in_service_area: boolean;
	world: { x: number; z: number } | null;
}

export interface WorldBounds {
	min_x: number;
	min_z: number;
	max_x: number;
	max_z: number;
}

export interface PlayableRegion {
	slug: string;
	name: string;
	name_km: string | null;
	bbox: [number, number, number, number];
	world_bounds: WorldBounds;
	chunk_keys: string[];
	dataset: Record<string, unknown>;
}

export interface WorldConfig {
	crs: string;
	origin: { lat: number; lon: number; name: string };
	origin_easting: number;
	origin_northing: number;
	chunk_size: number;
	axes: string;
	attribution: string;
	regions: PlayableRegion[];
}

export interface WorldBootstrap {
	player: {
		id: string;
		username: string;
		display_name: string;
		world_visible: boolean;
		avatar: Avatar;
	};
	spawn: SpawnPoint;
	config: WorldConfig;
}

/* Streamed chunk payload (world metres; z = -north). */
export type XZ = [number, number];
export type PolygonRings = XZ[][]; // [outer, ...holes]

export interface ChunkRoad {
	id: number | null;
	name: string | null;
	name_en?: string | null;
	name_km: string | null;
	cls: string;
	w: number;
	oneway: boolean;
	bridge: boolean;
	layer: number;
	pts: XZ[];
}

export interface ChunkBuilding {
	id: number | null;
	name: string | null;
	name_km: string | null;
	kind: string;
	h: number;
	min_h: number;
	hs: 'osm' | 'levels' | 'estimated';
	colour: string | null;
	polys: PolygonRings[];
}

export interface ChunkArea {
	kind: string;
	name: string | null;
	polys: PolygonRings[];
}

export interface ChunkLandmark {
	name: string;
	name_en: string | null;
	name_km: string | null;
	cat: string;
	sub: string;
	imp: number;
	p: XZ;
}

export interface ChunkPayload {
	key: string;
	ix: number;
	iz: number;
	size: number;
	roads: ChunkRoad[];
	buildings: ChunkBuilding[];
	areas: ChunkArea[];
	landmarks: ChunkLandmark[];
	features: { k: string; p: XZ }[];
}

export interface RoleRequest {
	id: string;
	user_id: string;
	username: string;
	display_name: string;
	role: RoleName;
	status: RoleStatus;
	note: string | null;
	requested_at: string;
	decided_at: string | null;
	decision_reason: string | null;
}
