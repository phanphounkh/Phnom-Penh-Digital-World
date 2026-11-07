import { writable } from "svelte/store";
export const cartStore = writable([]);
export const totalCents = (items) =>
  items.reduce((sum, item) => sum + Math.round(item.price * 100), 0);
export const groupItems = (items) =>
  Object.values(
    items.reduce((groups, item) => {
      if (!groups[item.id]) groups[item.id] = { ...item, quantity: 0 };
      groups[item.id].quantity++;
      return groups;
    }, {}),
  );
export function makeReceipt(items, sequence, now = new Date()) {
  return {
    id: "CE-" + String(sequence).padStart(4, "0"),
    date: now.toISOString(),
    items: items.map((i) => ({ ...i })),
    total: totalCents(items) / 100,
    points: Math.floor(totalCents(items) / 10),
  };
}

// LAN-hosted mobile pages may not expose randomUUID outside a secure context.
export function newItemId(source = globalThis.crypto) {
  return (
    source?.randomUUID?.() ??
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
  );
}
