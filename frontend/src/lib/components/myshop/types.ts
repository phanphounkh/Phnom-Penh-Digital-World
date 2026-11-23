/** The tabs of the in-game "My shop" panel. */
export type Tab =
  "today" | "orders" | "products" | "look" | "spot" | "business";

/** Where the player stands: world metres (for distances in the city) and map position. */
export interface Here {
  x: number;
  z: number;
  lat: number;
  lon: number;
  /** World position of a map point (the city's projection). */
  toWorld: (lat: number, lon: number) => { x: number; z: number };
}

/** Time since an ISO date, in words ("now", "4 min", "2 h", "3 d"). */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Where a map point is from the player: its world position, distance (m) and compass heading (°). */
export function offset(
  here: Here,
  lat: number,
  lon: number,
): { x: number; z: number; distance: number; heading: number } {
  const w = here.toWorld(lat, lon);
  const dx = w.x - here.x;
  const dz = w.z - here.z;
  // World z points south, so north is -z; the heading turns clockwise from north.
  const heading = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return { x: w.x, z: w.z, distance: Math.hypot(dx, dz), heading };
}
