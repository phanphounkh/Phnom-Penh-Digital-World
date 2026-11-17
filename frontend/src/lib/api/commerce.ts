import { api } from './client';

export type DeliveryJob = {
	id: string;
	order_id: string;
	number: string;
	status: string;
	order_status: string;
	shop_name: string;
	pickup: { x: number; z: number };
	dropoff: { x: number; z: number; label: string };
	fee_minor: number;
	is_demo: boolean;
	driver_online: boolean;
	position: { x: number; z: number } | null;
};
export type DriverDashboard = {
	online: boolean;
	vehicle_kind: 'bicycle' | 'motorbike';
	jobs: DeliveryJob[];
	offers: DeliveryJob[];
};
export type Wallet = {
	balance_minor: number;
	currency: string;
	is_demo: boolean;
	transactions: {
		id: string;
		kind: string;
		amount_minor: number;
		created_at: string;
	}[];
};
export const delivery = {
	dashboard: () => api<DriverDashboard>('/driver'),
	availability: (online: boolean, vehicle_kind: 'bicycle' | 'motorbike') =>
		api('/driver/availability', {
			method: 'PUT',
			body: { online, vehicle_kind }
		}),
	accept: (id: string) => api<DeliveryJob>(`/driver/jobs/${id}/accept`, { method: 'POST' }),
	advance: (id: string, action: 'pickup' | 'start' | 'deliver' | 'release') =>
		api<DeliveryJob>(`/driver/jobs/${id}/${action}`, { method: 'POST' }),
	tracking: (id: string) => api<DeliveryJob>(`/orders/${id}/delivery`)
};
export const wallet = {
	get: () => api<Wallet>('/wallet'),
	credit: (amount_minor: number, key: string) =>
		api<Wallet>('/wallet/credits', {
			method: 'POST',
			body: { amount_minor },
			headers: { 'Idempotency-Key': key }
		})
};
