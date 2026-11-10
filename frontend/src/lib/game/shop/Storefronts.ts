/**
 * Walk-in storefronts in the 3D city (Phase 4).
 *
 * Every active shop is a claimed unit: a real ground-floor frontage on a real street. Here we
 * open its doorway (collision gap + facade shader cut-out), hang a bilingual sign and an
 * awning, and build the interior on the unit's floor: shelves and an island table showing the
 * merchant's products (with price tags), a shopping cart by the door and a checkout counter.
 *
 * The player walks in, presses E at a product to pick it up (it appears in the avatar's hand),
 * carries it to the cart and presses E again to put it in (the server cart records it), and
 * pays at the counter. Product data always comes from the server; nothing here sets a price.
 */
import * as THREE from 'three';
import { market, money, type Cart, type Product, type Shop, type ShopDetail } from '$lib/api/market';
import type { CollisionWorld } from '$lib/game/city/collision';
import type { CityMaterials } from '$lib/game/city/materials';
import { MAX_DOORS } from '$lib/game/city/materials';
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
const CART_REACH = 1.7;
const COUNTER_REACH = 2.2;

export type Interaction =
	| { kind: 'browse'; shop: Shop; label: string }
	| { kind: 'pickup'; shop: Shop; product: Product; label: string }
	| { kind: 'cart'; shop: Shop; product: Product; label: string }
	| { kind: 'putback'; shop: Shop; product: Product; label: string }
	| { kind: 'counter'; shop: Shop; label: string };

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
	cartContents: THREE.Group;
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
	private held: { product: Product; shop: Shop; mesh: THREE.Object3D } | null = null;
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

	get holding(): Product | null {
		return this.held?.product ?? null;
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
		if (this.held && !next.has(this.held.shop.id)) this.drop();
	}
	private collisionOwners: string[] = [];

	/** Show the buyer's cart lines for each merchant inside that merchant's 3D cart. */
	setCart(cart: Cart | null): void {
		this.cart = cart;
		for (const b of this.built.values()) void this.fillCart(b);
	}

	/** Per frame, after the player moved. */
	update(px: number, pz: number, yaw: number): void {
		if (this.disposed) return;
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
		const doorShops = nearby.slice(0, MAX_DOORS).map((n) => n.shop);
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
			if (this.held) {
				if (near(inside.cart.x, inside.cart.z, CART_REACH, -0.2, 1.2) < Infinity && this.held.shop.merchant_id === shop.merchant_id)
					found = { kind: 'cart', shop, product: this.held.product, label: `Put ${this.held.product.name} in the cart` };
				else found = { kind: 'putback', shop, product: this.held.product, label: `Put ${this.held.product.name} back` };
			} else {
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
						kind: 'pickup',
						shop,
						product: best.product,
						label: best.product.in_stock
							? `Pick up ${best.product.name} · ${money(best.product.price_minor)}`
							: `${best.product.name} is sold out`
					};
				else if (near(inside.counter.x, inside.counter.z, COUNTER_REACH, -0.2, 1.4) < Infinity)
					found = { kind: 'counter', shop, label: 'Pay at the counter (demo checkout)' };
				else if (near(inside.cart.x, inside.cart.z, CART_REACH, -0.2, 1.2) < Infinity)
					found = { kind: 'counter', shop, label: 'Review your cart' };
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

	/** Take a product off the shelf: it appears in the avatar's hand. */
	async hold(shop: Shop, product: Product): Promise<void> {
		this.drop();
		const mesh = await productModel(product.model, 0.22);
		if (product.image_url) applyPhoto(mesh, product.image_url);
		this.held = { product, shop, mesh };
		if (this.wrist) {
			mesh.position.set(0, -0.12, 0.06);
			this.wrist.add(mesh);
		} else {
			mesh.position.set(0.25, 1.0, 0.35);
			this.o.avatar.add(mesh);
		}
		this.o.setHolding(true);
		this.current = null; // re-evaluate the prompt next frame
	}

	/** Put the held product back (or drop it after it went into the cart). */
	drop(): void {
		if (!this.held) return;
		this.held.mesh.removeFromParent();
		disposeOwned(this.held.mesh);
		this.held = null;
		this.o.setHolding(false);
		this.current = null;
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
			const cart = await fitting('cart');
			place(cart, layout.cart);
			const cartContents = new THREE.Group();
			const [cx, cz] = toWorld(f, layout.cart.a, layout.cart.n);
			cartContents.position.set(cx, ground + 0.62, cz);
			cartContents.rotation.y = yawFacing(f, layout.cart.fa, layout.cart.fn);
			group.add(cartContents);
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
				cartContents,
				slots: [],
				cart: { x: cx, z: cz, y: ground },
				counter: { x: kx, z: kz },
				catalog: '',
				loading: false,
				detail: null,
				token
			};
			this.built.set(shop.id, b);
			void this.fillCart(b);
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

	private async fillCart(b: Built): Promise<void> {
		for (const child of [...b.cartContents.children]) {
			child.removeFromParent();
			disposeOwned(child);
		}
		const group = this.cart?.groups.find((g) => g.merchant_id === b.shop.merchant_id);
		if (!group) return;
		const lines = group.lines.flatMap((l) => Array.from({ length: Math.min(l.quantity, 3) }, () => l)).slice(0, 8);
		for (const [i, line] of lines.entries()) {
			const mesh = await productModel(line.model, 0.16);
			if (line.image_url) applyPhoto(mesh, line.image_url);
			mesh.position.set(((i % 2) - 0.5) * 0.18, Math.floor(i / 4) * 0.12, ((Math.floor(i / 2) % 2) - 0.5) * 0.22);
			mesh.rotation.y = i * 0.7;
			b.cartContents.add(mesh);
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
		this.drop();
		for (const id of [...this.built.keys()]) this.unbuild(id);
		for (const key of this.collisionOwners) this.o.collision.removeOwner(key);
		this.o.collision.doors = [];
		this.o.materials.setDoors([]);
	}
}
