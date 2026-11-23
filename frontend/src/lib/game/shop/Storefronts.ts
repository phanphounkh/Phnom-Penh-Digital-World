/**
 * Walk-in storefronts in the 3D city (Phase 4).
 *
 * Every active shop is a claimed unit: a real ground-floor frontage on a real street. Here we
 * open its doorway (collision gap + facade shader cut-out), hang a bilingual sign and an
 * awning, and build the interior on the unit's floor: shelves and an island table showing the
 * merchant's products (with price tags), a shopping cart by the door and a checkout counter.
 *
 * The player walks in and presses E at a product: it goes into their basket (the server cart
 * records it), and the basket appears in their hand with what they picked. At the counter E
 * opens the one-step payment; once paid they carry a paper bag out. Product data always comes
 * from the server; nothing here sets a price.
 */
import * as THREE from 'three';
import { market, money, type Cart, type CartLine, type Product, type Shop, type ShopDetail } from '$lib/api/market';
import type { CollisionWorld } from '$lib/game/city/collision';
import type { CityMaterials } from '$lib/game/city/materials';
import { SHOP_DOORS } from '$lib/game/city/materials';
import type { Terrain } from '$lib/game/city/terrain';
import { applyPhoto, disposeOwned, fitting, productModel, tint } from './ShopAssets';
import {
	DOOR_HEIGHT,
	doorway,
	frameOf,
	interiorLayout,
	isInside,
	ring,
	toLocal,
	toWorld,
	yawFacing,
	type Placement,
	type ShopFrame
} from './layout';

const BUILD_RADIUS = 110; // m: build exterior + interior
const PRODUCT_RADIUS = 45; // m: fetch and show products
const REACH = 1.5; // m: products within reach
const COUNTER_REACH = 2.2;
/** How long the paper bag stays in hand after paying (ms). */
const BAG_MS = 60_000;

export type Interaction =
	| { kind: 'browse'; shop: Shop; label: string }
	| { kind: 'take'; shop: Shop; product: Product; label: string }
	| { kind: 'counter'; shop: Shop; label: string };

/** What the player picked in the shop they stand in (the cart lines from its merchant). */
export interface Basket {
	shop: Shop;
	lines: CartLine[];
	count: number;
	total_minor: number;
}

/** A mesh with its own geometry and material (freed with the carried object). */
function owned(parent: THREE.Object3D, geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number, roughness = 0.6) {
	const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness }));
	mesh.position.set(x, y, z);
	mesh.userData.ownsGeometry = true;
	mesh.userData.ownsMaterial = true;
	mesh.castShadow = true;
	parent.add(mesh);
	return mesh;
}

/** A red plastic shopping basket (open box with a handle) holding up to six of the picks.
 *  Its origin is the top of the handle, where the hand holds it; it hangs below. */
async function basketModel(lines: CartLine[]): Promise<THREE.Group> {
	const root = new THREE.Group();
	const g = new THREE.Group();
	const W = 0.34, D = 0.22, H = 0.15, T = 0.01, HANDLE = 0.12;
	g.position.y = -(H + HANDLE);
	root.add(g);
	const part = (geometry: THREE.BufferGeometry, x: number, y: number, z: number) => owned(g, geometry, '#c8322b', x, y, z, 0.55);
	part(new THREE.BoxGeometry(W, T, D), 0, T / 2, 0);
	part(new THREE.BoxGeometry(W, H, T), 0, H / 2, D / 2);
	part(new THREE.BoxGeometry(W, H, T), 0, H / 2, -D / 2);
	part(new THREE.BoxGeometry(T, H, D), W / 2, H / 2, 0);
	part(new THREE.BoxGeometry(T, H, D), -W / 2, H / 2, 0);
	part(new THREE.TorusGeometry(HANDLE, 0.008, 6, 18, Math.PI), 0, H, 0); // the handle, over the long side
	const picks = lines.flatMap((l) => Array.from({ length: Math.min(l.quantity, 3) }, () => l)).slice(0, 6);
	for (const [i, line] of picks.entries()) {
		const mesh = await productModel(line.model, 0.085);
		if (line.image_url) applyPhoto(mesh, line.image_url);
		mesh.position.set(((i % 3) - 1) * 0.1, T, (Math.floor(i / 3) - 0.5) * 0.09);
		mesh.rotation.y = i * 0.9;
		g.add(mesh);
	}
	return root;
}

/** A kraft paper shopping bag with a band in the shop's colours, hanging from its handle
 *  (the origin is the top of the handle). */
function bagModel(colors: { primary: string; accent: string }): THREE.Group {
	const g = new THREE.Group();
	const W = 0.26, D = 0.12, H = 0.3, HANDLE = 0.07;
	const top = -HANDLE;
	owned(g, new THREE.BoxGeometry(W, H, D), '#b98a56', 0, top - H / 2, 0, 0.9);
	owned(g, new THREE.BoxGeometry(W + 0.004, 0.08, D + 0.004), colors.primary, 0, top - H * 0.42, 0, 0.8);
	owned(g, new THREE.BoxGeometry(W + 0.006, 0.014, D + 0.006), colors.accent, 0, top - H * 0.42 - 0.047, 0, 0.8);
	for (const z of [-0.025, 0.025]) owned(g, new THREE.TorusGeometry(HANDLE, 0.005, 6, 16, Math.PI), '#7a5634', 0, top, z, 0.9);
	return g;
}

const upright = { parent: new THREE.Quaternion(), facing: new THREE.Quaternion() };

const THEMES: Record<string, { floor: string; wall: string; ceiling: string }> = {
	market: { floor: '#c9b08a', wall: '#f1e6cf', ceiling: '#fbf6ea' },
	cafe: { floor: '#8a6142', wall: '#efe0c6', ceiling: '#f8efe0' },
	boutique: { floor: '#e8ddd6', wall: '#f7ece8', ceiling: '#fffaf6' },
	tech: { floor: '#b9bec2', wall: '#eef1f2', ceiling: '#ffffff' },
	books: { floor: '#7b5a3c', wall: '#dfe6d4', ceiling: '#f6f4ea' }
};

interface Slot {
	x: number;
	z: number;
	y: number;
	product: Product;
	mesh: THREE.Object3D;
}

interface Built {
	shop: Shop;
	frame: ShopFrame;
	ground: number;
	group: THREE.Group;
	products: THREE.Group;
	slots: Slot[];
	cart: { x: number; z: number; y: number };
	counter: { x: number; z: number };
	catalog: string; // catalog_version shown
	loading: boolean;
	detail: ShopDetail | null;
	token: number;
}

export interface StorefrontOptions {
	scene: THREE.Scene;
	collision: CollisionWorld;
	materials: CityMaterials;
	terrain: Terrain;
	/** The avatar root (the held product attaches to its right wrist). */
	avatar: THREE.Object3D;
	setHolding(holding: boolean): void;
	onInteraction?(interaction: Interaction | null): void;
	/** The basket of the shop the player stands in changed (entered, left, picked, paid). */
	onBasket?(basket: Basket | null): void;
}

function canvasTexture(width: number, height: number, draw: (g: CanvasRenderingContext2D) => void) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	draw(canvas.getContext('2d')!);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	return texture;
}

function plane(w: number, h: number, material: THREE.Material): THREE.Mesh {
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
	mesh.userData.ownsGeometry = true;
	mesh.userData.ownsMaterial = true;
	return mesh;
}

function interiorMaterial(color: string, emissive = 0.32): THREE.MeshStandardMaterial {
	// Interiors are not shadowed (they sit under the building's roof) and glow a little so
	// they read as lit rooms by day and by night.
	const c = new THREE.Color(color);
	return new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: emissive, roughness: 0.85 });
}

function signTexture(shop: Shop) {
	const t = canvasTexture(1024, 128, (g) => {
		g.fillStyle = shop.primary_color;
		g.fillRect(0, 0, 1024, 128);
		g.fillStyle = shop.accent_color;
		g.fillRect(0, 116, 1024, 12);
		g.fillStyle = '#fffaf0';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		const km = shop.name_km;
		g.font = `700 ${km ? 50 : 62}px "Bricolage Grotesque", "Noto Sans Khmer", system-ui, sans-serif`;
		g.fillText(shop.name, 512, km ? 42 : 58, 960);
		if (km) {
			g.font = '600 38px "Noto Sans Khmer", "Kantumruy Pro", system-ui, sans-serif';
			g.fillText(km, 512, 92, 960);
		}
		if (!shop.is_open) {
			g.save();
			g.translate(900, 64);
			g.rotate(-0.12);
			g.fillStyle = '#b3261e';
			g.fillRect(-90, -26, 180, 52);
			g.fillStyle = '#fff';
			g.font = '800 34px system-ui, sans-serif';
			g.fillText('CLOSED', 0, 2);
			g.restore();
		}
	});
	return t;
}

function tagTexture(product: Product) {
	return canvasTexture(256, 72, (g) => {
		g.fillStyle = '#fffdf7';
		g.fillRect(0, 0, 256, 72);
		g.fillStyle = product.in_stock ? '#1f2a2c' : '#9a9a9a';
		g.font = '600 24px system-ui, sans-serif';
		g.textBaseline = 'top';
		g.fillText(product.name, 10, 8, 236);
		g.font = '800 28px system-ui, sans-serif';
		g.fillStyle = product.in_stock ? '#b3401f' : '#9a9a9a';
		g.fillText(product.in_stock ? money(product.price_minor) : 'Sold out', 10, 38, 236);
	});
}

export class Storefronts {
	private shops = new Map<string, Shop>();
	private built = new Map<string, Built>();
	private building = new Set<string>();
	/** What the avatar carries: the basket (in a shop, with picks) or the paper bag (paid). */
	private carried: { key: string; mesh: THREE.Object3D } | null = null;
	private carryKey = '';
	private carryToken = 0;
	private bagUntil = 0;
	private bagColors = { primary: '#123b3a', accent: '#e8a33d' };
	private stowed = false;
	private insideId: string | null = null;
	private current: Interaction | null = null;
	private doorsKey = '';
	private token = 0;
	private cart: Cart | null = null;
	private disposed = false;
	private wrist: THREE.Object3D | null;

	constructor(private o: StorefrontOptions) {
		this.wrist = o.avatar.getObjectByName('RightWrist') ?? null;
	}

	get list(): Shop[] {
		return [...this.shops.values()];
	}

	/** The basket for the shop the player stands in (null outside a shop). */
	get basket(): Basket | null {
		const shop = this.insideId ? this.shops.get(this.insideId) : undefined;
		return shop ? this.basketFor(shop) : null;
	}

	private basketFor(shop: Shop): Basket {
		const group = this.cart?.groups.find((g) => g.merchant_id === shop.merchant_id);
		const lines = group?.lines ?? [];
		return { shop, lines, count: lines.reduce((n, l) => n + l.quantity, 0), total_minor: group?.subtotal_minor ?? 0 };
	}

	/** The shop the player stands in (or at the door of). */
	shopAt(x: number, z: number, margin = 0): Shop | null {
		for (const shop of this.shops.values()) if (isInside(frameOf(shop.unit), x, z, margin)) return shop;
		return null;
	}

	/** Replace the set of storefronts (from GET /market/shops). */
	setShops(shops: Shop[]): void {
		const next = new Map(shops.map((s) => [s.id, s]));
		for (const [id, b] of this.built) {
			const s = next.get(id);
			const changed =
				!s ||
				s.name !== b.shop.name ||
				s.name_km !== b.shop.name_km ||
				s.theme !== b.shop.theme ||
				s.primary_color !== b.shop.primary_color ||
				s.accent_color !== b.shop.accent_color ||
				s.is_open !== b.shop.is_open;
			if (changed) this.unbuild(id);
			else if (s && s.catalog_version !== b.catalog) b.shop = s; // products refresh in update()
		}
		this.shops = next;
		// Collision: every active shop has an open doorway and an enclosed floor.
		for (const key of this.collisionOwners) this.o.collision.removeOwner(key);
		this.collisionOwners = [];
		const doors = [];
		for (const shop of shops) {
			const f = frameOf(shop.unit);
			const ground = this.o.terrain.height(f.ox, f.oz);
			const key = `shop:${shop.id}`;
			this.o.collision.addRing(key, ring(shop.unit), ground + shop.unit.ceiling_m);
			// Fittings block walking (but are low enough for the camera to look over).
			const layout = interiorLayout(f);
			const box = (p: Placement, halfA: number, halfN: number) => {
				const corners: [number, number][] = [[-halfA, -halfN], [halfA, -halfN], [halfA, halfN], [-halfA, halfN]].map(
					([da, dn]) => toWorld(f, p.a + da, p.n + dn)
				);
				this.o.collision.addRing(key, corners, 0);
			};
			for (const shelf of layout.shelves) box(shelf, 0.21, 1.0);
			box(layout.table, 0.4, 0.7);
			box(layout.counter, 1.0, 0.3);
			box(layout.cart, 0.3, 0.45);
			this.collisionOwners.push(key);
			doors.push(doorway(f));
		}
		this.o.collision.doors = doors;
		this.doorsKey = '';
	}
	private collisionOwners: string[] = [];

	/** The buyer's cart: each shop's lines are the basket carried in that shop. */
	setCart(cart: Cart | null): void {
		this.cart = cart;
		this.basketChanged();
	}

	private basketChanged(): void {
		this.o.onBasket?.(this.basket);
		void this.refreshCarry();
	}

	/** Paid at the counter: the basket becomes a paper bag in the shop's colours, carried for a
	 *  minute. */
	handOver(shop: Shop): void {
		this.bagColors = { primary: shop.primary_color, accent: shop.accent_color };
		this.bagUntil = performance.now() + BAG_MS;
		void this.refreshCarry();
	}

	/** Riding (or otherwise busy): put what is carried away until walking again. */
	stow(stowed: boolean): void {
		if (stowed === this.stowed) return;
		this.stowed = stowed;
		void this.refreshCarry();
	}

	/** Per frame, after the player moved. */
	update(px: number, pz: number, yaw: number): void {
		if (this.disposed) return;
		const inside = this.shopAt(px, pz, 0.2)?.id ?? null;
		if (inside !== this.insideId) {
			this.insideId = inside;
			this.basketChanged();
		}
		if (this.bagUntil && performance.now() > this.bagUntil) {
			this.bagUntil = 0;
			void this.refreshCarry();
		}
		this.keepUpright();
		const nearby: { shop: Shop; d: number }[] = [];
		for (const shop of this.shops.values()) {
			const d = Math.hypot(shop.unit.door_x - px, shop.unit.door_z - pz);
			nearby.push({ shop, d });
			if (d < BUILD_RADIUS && !this.built.has(shop.id) && !this.building.has(shop.id)) void this.build(shop);
		}
		for (const [id, b] of this.built) {
			const d = Math.hypot(b.frame.ox - px, b.frame.oz - pz);
			if (d > BUILD_RADIUS + 40) this.unbuild(id);
			else if (d < PRODUCT_RADIUS && !b.loading && b.catalog !== b.shop.catalog_version) void this.loadProducts(b);
		}
		// Facade cut-outs for the nearest doorways.
		nearby.sort((a, b) => a.d - b.d);
		const doorShops = nearby.slice(0, SHOP_DOORS).map((n) => n.shop);
		const key = doorShops.map((s) => s.id).join();
		if (key !== this.doorsKey) {
			this.doorsKey = key;
			this.o.materials.setDoors(
				doorShops.map((s) => {
					const f = frameOf(s.unit);
					const d = doorway(f);
					return { x: d.x, z: d.z, ux: d.ux, uz: d.uz, y: this.o.terrain.height(f.ox, f.oz), halfWidth: d.halfWidth };
				})
			);
		}
		this.pick(px, pz, yaw);
	}

	private pick(px: number, pz: number, yaw: number): void {
		const fx = Math.sin(yaw), fz = Math.cos(yaw);
		let found: Interaction | null = null;
		const inside = [...this.built.values()].find((b) => isInside(b.frame, px, pz, 0.2));
		if (inside) {
			const shop = inside.shop;
			// Within `close` metres facing does not matter; further away, look at the thing.
			const near = (x: number, z: number, reach: number, facing = 0.1, close = 0.5) => {
				const dx = x - px, dz = z - pz;
				const d = Math.hypot(dx, dz);
				return d <= reach && (d < close || (dx * fx + dz * fz) / d > facing) ? d : Infinity;
			};
			let best: Slot | null = null;
			let bestD = Infinity;
			for (const slot of inside.slots) {
				const d = near(slot.x, slot.z, REACH, 0.25);
				if (d < bestD) {
					bestD = d;
					best = slot;
				}
			}
			if (best)
				found = {
					kind: 'take',
					shop,
					product: best.product,
					label: !shop.is_open
						? `${shop.name} is closed`
						: best.product.in_stock
							? `Put ${best.product.name} in your basket · ${money(best.product.price_minor)}`
							: `${best.product.name} is sold out`
				};
			else if (near(inside.counter.x, inside.counter.z, COUNTER_REACH, -0.2, 1.4) < Infinity) {
				const basket = this.basketFor(shop);
				found = { kind: 'counter', shop, label: basket.count ? `Pay at the counter · ${money(basket.total_minor)}` : 'The counter' };
			}
		} else {
			for (const b of this.built.values()) {
				const [a, n] = toLocal(b.frame, px, pz);
				if (Math.abs(a) < b.frame.width / 2 + 0.5 && n > -3 && n < 0.2) {
					found = { kind: 'browse', shop: b.shop, label: `${b.shop.name}${b.shop.is_open ? '' : ' (closed)'} · browse the shop` };
					break;
				}
			}
		}
		const same =
			found?.kind === this.current?.kind &&
			found?.label === this.current?.label &&
			found?.shop.id === this.current?.shop.id;
		if (!same) {
			this.current = found;
			this.o.onInteraction?.(found);
		}
	}

	get interaction(): Interaction | null {
		return this.current;
	}

	/** Carry what the moment calls for: the basket with the picks, the paper bag, or nothing. */
	private async refreshCarry(): Promise<void> {
		if (this.disposed) return;
		const shop = this.insideId ? this.shops.get(this.insideId) : undefined;
		const basket = shop ? this.basketFor(shop) : null;
		let key = '';
		let make: (() => Promise<THREE.Object3D>) | null = null;
		if (this.stowed) key = '';
		else if (basket?.count) {
			const lines = basket.lines;
			key = `basket:${lines.map((l) => `${l.product_id}x${l.quantity}`).join(',')}`;
			make = () => basketModel(lines);
		} else if (performance.now() < this.bagUntil) {
			key = 'bag';
			const colors = this.bagColors;
			make = async () => bagModel(colors);
		}
		if (key === this.carryKey) return;
		this.carryKey = key;
		const token = ++this.carryToken;
		const mesh = make ? await make() : null;
		if (token !== this.carryToken || this.disposed) {
			if (mesh) disposeOwned(mesh);
			return;
		}
		this.removeCarried();
		if (mesh) {
			this.carried = { key, mesh };
			this.attachCarried();
		}
		this.o.setHolding(!!mesh);
	}

	private attachCarried(): void {
		if (!this.carried) return;
		const { mesh } = this.carried;
		// The handle sits in the palm; the rest hangs below it (see keepUpright).
		if (this.wrist) {
			mesh.position.set(0, -0.08, 0.03);
			this.wrist.add(mesh);
		} else {
			mesh.position.set(0.25, 0.95, 0.2);
			this.o.avatar.add(mesh);
		}
		this.keepUpright();
	}

	/** Whatever the hand's angle, a carried basket or bag hangs straight down, facing the way the
	 *  player faces. */
	private keepUpright(): void {
		const mesh = this.carried?.mesh;
		if (!mesh?.parent) return;
		mesh.parent.getWorldQuaternion(upright.parent);
		this.o.avatar.getWorldQuaternion(upright.facing);
		mesh.quaternion.copy(upright.parent.invert().multiply(upright.facing));
	}

	private removeCarried(): void {
		if (!this.carried) return;
		this.carried.mesh.removeFromParent();
		disposeOwned(this.carried.mesh);
		this.carried = null;
	}

	/** The avatar model was swapped (a new outfit): find the wrist again and move what is carried. */
	rebindAvatar(): void {
		this.wrist = this.o.avatar.getObjectByName('RightWrist') ?? null;
		if (this.carried) {
			this.carried.mesh.removeFromParent();
			this.attachCarried();
		}
	}

	/** Test and debug inspection: what the avatar carries ('basket:…', 'bag' or ''). */
	get carrying(): string {
		return this.carried?.key ?? '';
	}

	private async build(shop: Shop): Promise<void> {
		this.building.add(shop.id);
		const token = ++this.token;
		try {
			const f = frameOf(shop.unit);
			const ground = this.o.terrain.height(f.ox, f.oz);
			const theme = THEMES[shop.theme] ?? THEMES.market;
			const group = new THREE.Group();
			group.name = `shop:${shop.unit.code}`;
			const place = (obj: THREE.Object3D, p: Placement) => {
				const [x, z] = toWorld(f, p.a, p.n);
				obj.position.set(x, ground + p.y, z);
				obj.rotation.y = yawFacing(f, p.fa, p.fn);
				group.add(obj);
				return obj;
			};
			const at = (a: number, n: number, y: number) => {
				const [x, z] = toWorld(f, a, n);
				return new THREE.Vector3(x, ground + y, z);
			};

			// Room: floor, inward-facing walls, ceiling with a light panel.
			const W = f.width, D = f.depth, H = shop.unit.ceiling_m;
			const floor = plane(W - 0.02, D - 0.02, interiorMaterial(theme.floor, 0.18));
			floor.rotation.x = -Math.PI / 2;
			floor.rotation.z = yawFacing(f, 0, 1); // Rz before Rx(-90°) = a turn about world Y
			floor.position.copy(at(0, D / 2, 0.035));
			group.add(floor);
			const wallMat = interiorMaterial(theme.wall);
			const wall = (a: number, n: number, faceA: number, faceN: number, w: number, h: number, y: number) => {
				const mesh = plane(w, h, wallMat.clone());
				mesh.position.copy(at(a, n, y));
				mesh.rotation.y = yawFacing(f, faceA, faceN);
				group.add(mesh);
			};
			wall(-W / 2 + 0.01, D / 2, 1, 0, D, H, H / 2);
			wall(W / 2 - 0.01, D / 2, -1, 0, D, H, H / 2);
			wall(0, D - 0.01, 0, -1, W, H, H / 2);
			// The inside of the street wall: jambs and the lintel above the doorway.
			const jamb = (W - 5) / 2;
			wall(-W / 2 + jamb / 2, 0.02, 0, 1, jamb, H, H / 2);
			wall(W / 2 - jamb / 2, 0.02, 0, 1, jamb, H, H / 2);
			wall(0, 0.02, 0, 1, 5, H - DOOR_HEIGHT, (H + DOOR_HEIGHT) / 2);
			wallMat.dispose();
			const ceiling = plane(W, D, interiorMaterial(theme.ceiling, 0.4));
			ceiling.rotation.x = Math.PI / 2;
			ceiling.rotation.z = -yawFacing(f, 0, 1); // mirrored: Rx(+90°)
			ceiling.position.copy(at(0, D / 2, H - 0.01));
			group.add(ceiling);
			const lamp = plane(1.2, D * 0.6, new THREE.MeshBasicMaterial({ color: '#fff6dc' }));
			lamp.rotation.copy(ceiling.rotation);
			lamp.position.copy(at(0, D / 2, H - 0.03));
			group.add(lamp);

			// Outside: bilingual sign board above the doorway, and an awning.
			const signTex = signTexture(shop);
			const signMat = new THREE.MeshStandardMaterial({ map: signTex, emissive: '#ffffff', emissiveMap: signTex, emissiveIntensity: 0.35 });
			signMat.userData.ownsMap = true;
			const sign = plane(W - 0.6, (W - 0.6) / 8, signMat);
			sign.position.copy(at(0, -0.08, Math.min(H + 0.55, DOOR_HEIGHT + 0.75)));
			sign.rotation.y = f.outYaw;
			group.add(sign);
			const awningProto = await fitting('awning');
			tint(awningProto, shop.primary_color, shop.accent_color);
			for (let i = 0; i < 5; i++) {
				const a = awningProto.clone(true);
				// Models are recentred on load: the awning's middle sits ~0.55 m out from the wall.
				a.position.copy(at(-2 + i, -0.6, DOOR_HEIGHT + 0.05));
				a.rotation.y = f.outYaw;
				group.add(a);
			}

			// Fittings.
			const layout = interiorLayout(f);
			for (const s of layout.shelves) {
				const shelf = await fitting('shelf');
				tint(shelf, shop.primary_color, shop.accent_color);
				place(shelf, s);
			}
			const table = await fitting('table');
			tint(table, shop.primary_color, shop.accent_color);
			place(table, { ...layout.table, fa: 1, fn: 0 });
			place(await fitting('counter'), layout.counter);
			place(await fitting('cart'), layout.cart); // by the door, for the look of a shop
			const [cx, cz] = toWorld(f, layout.cart.a, layout.cart.n);
			const [kx, kz] = toWorld(f, layout.counter.a, layout.counter.n - 0.6);

			if (this.disposed || !this.shops.has(shop.id)) {
				disposeOwned(group);
				return;
			}
			const products = new THREE.Group();
			group.add(products);
			this.o.scene.add(group);
			const b: Built = {
				shop,
				frame: f,
				ground,
				group,
				products,
				slots: [],
				cart: { x: cx, z: cz, y: ground },
				counter: { x: kx, z: kz },
				catalog: '',
				loading: false,
				detail: null,
				token
			};
			this.built.set(shop.id, b);
		} catch (error) {
			console.warn('Storefront failed to build', shop.unit.code, error);
		} finally {
			this.building.delete(shop.id);
		}
	}

	private async loadProducts(b: Built): Promise<void> {
		b.loading = true;
		const version = b.shop.catalog_version;
		try {
			const detail = await market.shop(b.shop.id);
			if (!this.built.has(b.shop.id) || this.disposed) return;
			b.detail = detail;
			const layout = interiorLayout(b.frame);
			const products = new THREE.Group();
			const slots: Slot[] = [];
			// Facings: like a real shop, show each product several times side by side (up to 4,
			// never more than its stock) so a small catalogue still fills the shelves.
			const per = Math.max(1, Math.min(4, Math.floor(layout.slots.length / Math.max(1, detail.products.length))));
			const items: { product: (typeof detail.products)[number]; first: boolean }[] = [];
			for (const product of detail.products)
				for (let k = 0; k < Math.max(1, Math.min(per, product.stock)); k++) items.push({ product, first: k === 0 });
			items.splice(layout.slots.length);
			await Promise.all(
				items.map(async ({ product, first }, i) => {
					const p = layout.slots[i];
					const onTable = p.y > 0.7 && p.y < 0.9;
					const mesh = await productModel(product.model, onTable ? 0.26 : 0.22);
					if (product.image_url) applyPhoto(mesh, product.image_url);
					const [x, z] = toWorld(b.frame, p.a, p.n);
					mesh.position.set(x, b.ground + p.y, z);
					mesh.rotation.y = yawFacing(b.frame, p.fa, p.fn);
					products.add(mesh);
					const facing = yawFacing(b.frame, p.fa, p.fn);
					if (first) {
						// Price tag on the shelf lip (or standing on the table), facing the aisle.
						const tagMat = new THREE.MeshBasicMaterial({ map: tagTexture(product) });
						tagMat.userData.ownsMap = true;
						const tag = plane(0.34, 0.096, tagMat);
						const [tx, tz] = toWorld(b.frame, p.a + p.fa * 0.23, p.n + p.fn * 0.2);
						tag.position.set(tx, b.ground + p.y - (onTable ? -0.02 : 0.05), tz);
						tag.rotation.y = facing;
						products.add(tag);
					}
					// Customers stand in front of the slot: that is where reach is measured from.
					slots.push({ x: x + Math.sin(facing) * 0.65, z: z + Math.cos(facing) * 0.65, y: p.y, product, mesh });
				})
			);
			if (!this.built.has(b.shop.id)) {
				disposeOwned(products);
				return;
			}
			b.products.removeFromParent();
			disposeOwned(b.products);
			b.group.add(products);
			b.products = products;
			b.slots = slots;
			b.catalog = version;
			this.current = null;
		} catch (error) {
			console.warn('Shop products failed to load', b.shop.unit.code, error);
			b.catalog = version; // do not retry every frame; a 'shops' update retries
		} finally {
			b.loading = false;
		}
	}

	private unbuild(id: string): void {
		const b = this.built.get(id);
		if (!b) return;
		b.group.removeFromParent();
		disposeOwned(b.group);
		this.built.delete(id);
		this.current = null;
	}

	/** Where to stand for each product, the cart and the counter (tests, accessibility). */
	points(shopId: string) {
		const b = this.built.get(shopId);
		if (!b) return null;
		const [cartX, cartZ] = toWorld(b.frame, interiorLayout(b.frame).cart.a + 0.85, interiorLayout(b.frame).cart.n);
		return {
			door: { x: b.frame.ox, z: b.frame.oz },
			inside: (() => {
				const [x, z] = toWorld(b.frame, 0, 1.4);
				return { x, z };
			})(),
			slots: b.slots.map((s) => ({ x: s.x, z: s.z, product: s.product.name, id: s.product.id })),
			cart: { x: cartX, z: cartZ },
			counter: { x: b.counter.x, z: b.counter.z }
		};
	}

	/** Shop detail (with products) for the browse panel. */
	detail(shopId: string): ShopDetail | null {
		return this.built.get(shopId)?.detail ?? null;
	}

	dispose(): void {
		this.disposed = true;
		this.removeCarried();
		for (const id of [...this.built.keys()]) this.unbuild(id);
		for (const key of this.collisionOwners) this.o.collision.removeOwner(key);
		this.o.collision.doors = [];
		this.o.materials.setDoors([]);
	}
}
