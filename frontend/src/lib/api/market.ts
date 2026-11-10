/** Marketplace types and endpoints (Phase 4). Money is integer US cents (`*_minor`). */
import { api } from './client';

export type MerchantStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export const BUSINESS_CATEGORIES = {
	food_drink: 'Food & drink',
	grocery: 'Grocery',
	fashion: 'Fashion',
	electronics: 'Electronics',
	crafts: 'Crafts & souvenirs',
	books: 'Books & stationery',
	beauty: 'Beauty',
	home: 'Home & kitchen',
	services: 'Services',
	other: 'Other'
} as const;
export type BusinessCategory = keyof typeof BUSINESS_CATEGORIES;
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Hours = Partial<Record<(typeof DAYS)[number], [string, string][]>>;

export interface MerchantDocument {
	id: string;
	kind: string;
	original_name: string;
	content_type: string;
	size_bytes: number;
	status: string;
	created_at: string;
}

export interface Merchant {
	id: string;
	business_name: string;
	business_name_km: string | null;
	category: BusinessCategory;
	description: string | null;
	contact_phone: string | null;
	contact_email: string | null;
	business_address: string | null;
	operating_hours: Hours;
	status: MerchantStatus;
	decision_reason: string | null;
	created_at: string;
	documents: MerchantDocument[];
	seller_role: string | null;
}

export interface AdminMerchant extends Merchant {
	owner_username: string;
	owner_display_name: string;
}

export type MerchantInput = Pick<
	Merchant,
	'business_name' | 'business_name_km' | 'category' | 'description' | 'contact_phone' | 'contact_email' | 'business_address' | 'operating_hours'
>;

export interface Unit {
	code: string;
	street_name: string | null;
	street_name_km: string | null;
	lat: number;
	lon: number;
	corners_ll: [number, number][];
	width_m: number;
	depth_m: number;
	requires_verification: boolean;
	real_business_name: string | null;
	status: 'available' | 'claimed' | 'pending' | 'inactive';
	shop_name: string | null;
}

export interface Claim {
	id: string;
	unit: Unit;
	status: 'pending' | 'approved' | 'rejected' | 'released' | 'expired' | 'revoked' | 'transferred';
	evidence_note: string | null;
	decision_reason: string | null;
	created_at: string;
	decided_at: string | null;
	starts_at: string | null;
	expires_at: string | null;
	ended_at: string | null;
	shop_id: string | null;
	merchant_name: string | null;
	merchant_username: string | null;
	document: MerchantDocument | null;
}

export interface Transfer {
	id: string;
	unit_code: string;
	from_merchant: string;
	to_merchant: string;
	status: string;
	created_at: string;
	direction: 'incoming' | 'outgoing';
}

export interface Dispute {
	id: string;
	unit_code: string;
	real_business_name: string | null;
	claim_id: string | null;
	claimed_by: string | null;
	disputer: string;
	reason: string;
	contact: string | null;
	status: string;
	resolution_note: string | null;
	created_at: string;
}

export type ShopTheme = 'market' | 'cafe' | 'boutique' | 'tech' | 'books';

export interface ShopUnitWorld {
	code: string;
	corners: [number, number][];
	door_x: number;
	door_z: number;
	heading: number;
	width_m: number;
	depth_m: number;
	ceiling_m: number;
	street_name: string | null;
}

export interface Shop {
	id: string;
	name: string;
	name_km: string | null;
	tagline: string | null;
	theme: ShopTheme;
	primary_color: string;
	accent_color: string;
	is_open: boolean;
	status: string;
	merchant_id: string;
	merchant_name: string;
	owner_username: string;
	category: BusinessCategory;
	unit: ShopUnitWorld;
	operating_hours: Hours;
	catalog_version: string;
}

export const DISPLAY_MODELS = [
	'box', 'bag', 'bottle', 'book', 'jar', 'shirt', 'phone', 'basket',
	'burger', 'cake', 'coffee', 'drink', 'fries', 'noodles', 'pizza', 'rice'
] as const;
export type DisplayModel = (typeof DISPLAY_MODELS)[number];

export interface Category {
	id: number;
	slug: string;
	name: string;
	name_km: string | null;
	policy: 'allowed' | 'restricted' | 'prohibited';
	policy_note: string | null;
	min_age: number | null;
}

export interface Product {
	id: string;
	merchant_id: string;
	name: string;
	name_km: string | null;
	description: string | null;
	category: string;
	category_name: string;
	min_age: number | null;
	price_minor: number;
	currency: string;
	image_url: string | null;
	model: DisplayModel;
	status: 'active' | 'hidden' | 'pending_review' | 'rejected' | 'archived';
	review_note: string | null;
	fulfillment: string[];
	stock: number;
	in_stock: boolean;
	sort_order: number;
}

export interface AdminProduct extends Product {
	merchant_name: string;
}

export interface ShopDetail extends Shop {
	products: Product[];
}

export interface CartLine {
	product_id: string;
	name: string;
	name_km: string | null;
	image_url: string | null;
	model: DisplayModel;
	quantity: number;
	unit_price_minor: number;
	quoted_price_minor: number;
	price_changed: boolean;
	line_total_minor: number;
	available: boolean;
	problem: string | null;
	stock: number;
	min_age: number | null;
	shop_id: string | null;
}

export interface Cart {
	groups: { merchant_id: string; merchant_name: string; lines: CartLine[]; subtotal_minor: number }[];
	item_count: number;
	total_minor: number;
	currency: string;
	needs_age_confirmation: boolean;
	can_checkout: boolean;
}

export type OrderStatus =
	| 'draft' | 'pending_payment' | 'paid' | 'merchant_accepted' | 'preparing' | 'ready_for_pickup'
	| 'assigned_to_driver' | 'picked_up' | 'in_transit' | 'delivered' | 'completed' | 'cancelled' | 'refunded';

export interface Order {
	id: string;
	number: string;
	status: OrderStatus;
	fulfillment: string;
	merchant_id: string;
	merchant_name: string;
	buyer_username: string | null;
	pickup_shop: string | null;
	pickup_unit: string | null;
	subtotal_minor: number;
	delivery_fee_minor: number;
	total_minor: number;
	currency: string;
	note: string | null;
	cancel_reason: string | null;
	payment_intent_id: string;
	payment_status: string;
	created_at: string;
	paid_at: string | null;
	completed_at: string | null;
	items: { product_id: string | null; name: string; name_km: string | null; unit_price_minor: number; quantity: number; line_total_minor: number }[];
	events: { from_status: string | null; to_status: string; actor_role: string; note: string | null; at: string }[];
	refunded_minor: number;
	allowed: OrderStatus[];
}

export interface Payment {
	id: string;
	status: 'requires_confirmation' | 'succeeded' | 'cancelled' | 'expired';
	amount_minor: number;
	currency: string;
	provider: string;
	is_demo: boolean;
	reference: string | null;
	expires_at: string;
	succeeded_at: string | null;
	orders: Order[];
	already_confirmed: boolean;
}

export interface Revenue {
	days: { day: string; orders: number; revenue_minor: number }[];
	total_orders: number;
	total_revenue_minor: number;
	refunded_minor: number;
	open_orders: number;
	currency: string;
	is_demo: boolean;
}

export const ORDER_LABEL: Record<OrderStatus, string> = {
	draft: 'Draft',
	pending_payment: 'Awaiting payment',
	paid: 'Paid',
	merchant_accepted: 'Accepted',
	preparing: 'Preparing',
	ready_for_pickup: 'Ready for pickup',
	assigned_to_driver: 'Driver assigned',
	picked_up: 'Picked up',
	in_transit: 'On the way',
	delivered: 'Delivered',
	completed: 'Completed',
	cancelled: 'Cancelled',
	refunded: 'Refunded'
};

/** "$2.50" from 250 cents. Demo money: never call it anything else in the UI. */
export function money(minor: number, currency = 'USD'): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

/** "2.50" (user input) → 250. Returns NaN for invalid input. */
export function toMinor(text: string): number {
	const t = text.trim().replace(/^\$/, '');
	if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return NaN;
	const [whole, frac = ''] = t.split('.');
	return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

function form(fields: Record<string, string | Blob>): FormData {
	const data = new FormData();
	for (const [k, v] of Object.entries(fields)) data.append(k, v);
	return data;
}

export const market = {
	units: (bbox: [number, number, number, number], available = false) =>
		api<Unit[]>('/market/units', { query: { bbox: bbox.join(','), available } }),
	unit: (code: string) => api<Unit>(`/market/units/${encodeURIComponent(code)}`),
	categories: () => api<Category[]>('/market/categories'),
	shops: (region?: string) => api<Shop[]>('/market/shops', { query: { region } }),
	shop: (id: string, signal?: AbortSignal) => api<ShopDetail>(`/market/shops/${id}`, { signal }),
	dispute: (unit_code: string, reason: string, contact?: string) =>
		api<{ message: string }>('/market/disputes', { method: 'POST', body: { unit_code, reason, contact } })
};

export const seller = {
	merchant: () => api<Merchant>('/merchant'),
	apply: (body: MerchantInput) => api<Merchant>('/merchant', { method: 'POST', body }),
	update: (body: MerchantInput) => api<Merchant>('/merchant', { method: 'PUT', body }),
	uploadDocument: (file: File, kind: string) =>
		api<MerchantDocument>('/merchant/documents', { method: 'POST', form: form({ file, kind }) }),
	claims: () => api<Claim[]>('/merchant/claims'),
	claim: (unit_code: string, evidence_note?: string, document_id?: string) =>
		api<Claim>('/merchant/claims', { method: 'POST', body: { unit_code, evidence_note, document_id } }),
	release: (id: string) => api<{ message: string }>(`/merchant/claims/${id}/release`, { method: 'POST' }),
	renew: (id: string) => api<Claim>(`/merchant/claims/${id}/renew`, { method: 'POST' }),
	transfer: (id: string, to_username: string) =>
		api<{ message: string }>(`/merchant/claims/${id}/transfer`, { method: 'POST', body: { to_username } }),
	transfers: () => api<Transfer[]>('/merchant/transfers'),
	respondTransfer: (id: string, action: 'accept' | 'decline' | 'cancel') =>
		api<{ message: string }>(`/merchant/transfers/${id}/${action}`, { method: 'POST' }),
	shops: () => api<Shop[]>('/merchant/shops'),
	updateShop: (id: string, body: Partial<Pick<Shop, 'name' | 'name_km' | 'tagline' | 'theme' | 'primary_color' | 'accent_color' | 'is_open'>>) =>
		api<Shop>(`/merchant/shops/${id}`, { method: 'PATCH', body }),
	products: () => api<Product[]>('/merchant/products'),
	createProduct: (body: { name: string; name_km?: string | null; description?: string | null; category: string; price_minor: number; model: DisplayModel; stock: number; visible?: boolean; fulfillment?: string[] }) =>
		api<Product>('/merchant/products', { method: 'POST', body }),
	updateProduct: (id: string, body: Partial<{ name: string; name_km: string | null; description: string | null; category: string; price_minor: number; model: DisplayModel; visible: boolean; sort_order: number }>) =>
		api<Product>(`/merchant/products/${id}`, { method: 'PATCH', body }),
	setStock: (id: string, on_hand: number) =>
		api<Product>(`/merchant/products/${id}/stock`, { method: 'PUT', body: { on_hand } }),
	uploadImage: (id: string, file: File) =>
		api<Product>(`/merchant/products/${id}/image`, { method: 'POST', form: form({ file }) }),
	archiveProduct: (id: string) => api<{ message: string }>(`/merchant/products/${id}`, { method: 'DELETE' }),
	orders: (status?: string) => api<Order[]>('/merchant/orders', { query: { status } }),
	transition: (id: string, to: OrderStatus, reason?: string) =>
		api<Order>(`/merchant/orders/${id}/transition`, { method: 'POST', body: { to, reason } }),
	revenue: (days = 30) => api<Revenue>('/merchant/revenue', { query: { days } })
};

export const shopping = {
	cart: () => api<Cart>('/cart'),
	add: (product_id: string, quantity = 1, shop_id?: string) =>
		api<Cart>('/cart/items', { method: 'POST', body: { product_id, quantity, shop_id } }),
	setQuantity: (product_id: string, quantity: number) =>
		api<Cart>(`/cart/items/${product_id}`, { method: 'PATCH', body: { quantity } }),
	remove: (product_id: string) => api<Cart>(`/cart/items/${product_id}`, { method: 'DELETE' }),
	checkout: (key: string, body: { expected_total_minor: number; note?: string; age_confirmed?: boolean }) =>
		api<Payment>('/checkout', { method: 'POST', body: { fulfillment: 'pickup', ...body }, headers: { 'Idempotency-Key': key } }),
	payment: (id: string) => api<Payment>(`/payments/${id}`),
	confirm: (id: string) => api<Payment>(`/payments/${id}/confirm`, { method: 'POST' }),
	cancelPayment: (id: string) => api<Payment>(`/payments/${id}/cancel`, { method: 'POST' }),
	orders: () => api<Order[]>('/orders'),
	order: (id: string) => api<Order>(`/orders/${id}`),
	cancel: (id: string, reason?: string) => api<Order>(`/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
	received: (id: string) => api<Order>(`/orders/${id}/received`, { method: 'POST' })
};

export const marketAdmin = {
	merchants: (status = 'pending') => api<AdminMerchant[]>('/admin/merchants', { query: { status } }),
	decideMerchant: (id: string, action: 'approve' | 'reject' | 'suspend', reason?: string) =>
		api<{ message: string }>(`/admin/merchants/${id}/${action}`, { method: 'POST', body: { reason } }),
	documentUrl: (id: string) => `/api/v1/admin/documents/${id}`,
	claims: (status = 'pending') => api<Claim[]>('/admin/claims', { query: { status } }),
	decideClaim: (id: string, action: 'approve' | 'reject' | 'revoke', reason?: string) =>
		api<{ message: string }>(`/admin/claims/${id}/${action}`, { method: 'POST', body: { reason } }),
	disputes: (status = 'open') => api<Dispute[]>('/admin/disputes', { query: { status } }),
	resolveDispute: (id: string, uphold: boolean, note?: string) =>
		api<{ message: string }>(`/admin/disputes/${id}/resolve`, { method: 'POST', body: { uphold, note } }),
	products: (status = 'pending_review') => api<AdminProduct[]>('/admin/products', { query: { status } }),
	reviewProduct: (id: string, action: 'approve' | 'reject', reason?: string) =>
		api<{ message: string }>(`/admin/products/${id}/${action}`, { method: 'POST', body: { reason } })
};
