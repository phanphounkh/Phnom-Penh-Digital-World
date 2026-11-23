import { describe, expect, it } from "vitest";
import { WorldProjection } from "$lib/geo/projection";
import { ago, offset, type Here } from "./types";

describe("ago", () => {
  const now = Date.parse("2026-11-23T10:00:00Z");
  it("says how long ago, in the largest whole unit", () => {
    expect(ago("2026-11-23T09:59:30Z", now)).toBe("now");
    expect(ago("2026-11-23T09:56:00Z", now)).toBe("4 min");
    expect(ago("2026-11-23T08:00:00Z", now)).toBe("2 h");
    expect(ago("2026-11-20T10:00:00Z", now)).toBe("3 d");
  });
  it("treats a time in the future as now", () => {
    expect(ago("2026-11-23T10:05:00Z", now)).toBe("now");
  });
});

describe("offset", () => {
  const projection = new WorldProjection(491_000, 1_280_000);
  const at = (lat: number, lon: number): Here => {
    const w = projection.toWorld(lat, lon);
    return { ...w, lat, lon, toWorld: (la, lo) => projection.toWorld(la, lo) };
  };
  const me = at(11.5696, 104.9213);

  it("measures metres on the ground", () => {
    const north = offset(me, 11.5696 + 0.0009, 104.9213); // ~100 m north
    expect(north.distance).toBeGreaterThan(95);
    expect(north.distance).toBeLessThan(105);
  });
  it("gives the compass heading clockwise from north", () => {
    expect(offset(me, 11.5706, 104.9213).heading).toBeCloseTo(0, 0);
    expect(
      Math.round(offset(me, 11.5696, 104.9223).heading),
    ).toBeGreaterThanOrEqual(89);
    expect(
      Math.round(offset(me, 11.5696, 104.9223).heading),
    ).toBeLessThanOrEqual(91);
    expect(Math.round(offset(me, 11.5686, 104.9213).heading)).toBe(180);
    expect(
      Math.round(offset(me, 11.5696, 104.9203).heading),
    ).toBeGreaterThanOrEqual(269);
  });
  it("returns the world position of the point", () => {
    const o = offset(me, 11.57, 104.922);
    const w = projection.toWorld(11.57, 104.922);
    expect(o.x).toBeCloseTo(w.x, 6);
    expect(o.z).toBeCloseTo(w.z, 6);
  });
});
