"""Read-only snapshot coverage and preflight; no database or network access.

Coverage means a downloaded bounding box, not a surveyed or fully modelled city.
Keep this separate from importer.py so a broken dataset can be audited offline.
"""

import json
from collections import Counter
from pathlib import Path

from shapely.geometry import box
from shapely.ops import unary_union

from app.geography import osm
from app.geography.projection import default_projection
from app.geography.regions import NEIGHBORHOODS


def region_cells(bbox: tuple) -> set[str]:
    projection = default_projection()
    south, west, north, east = bbox
    region = projection.geometry_to_world(box(west, south, east, north))
    x0, z0, x1, z1 = region.bounds
    ix0, iz0 = projection.chunk_of(x0, z0)
    ix1, iz1 = projection.chunk_of(x1, z1)
    return {
        f"{ix}_{iz}"
        for ix in range(ix0, ix1 + 1)
        for iz in range(iz0, iz1 + 1)
        if region.intersection(box(*projection.chunk_bounds(ix, iz))).area > 0
    }


def audit_snapshots(data_dir: Path, slugs: list[str] | None = None, *, regions=None) -> dict:
    regions = NEIGHBORHOODS if regions is None else regions
    selected = list(dict.fromkeys(slugs)) if slugs else list(regions)
    errors: list[str] = []
    projection = default_projection()
    report = {
        "crs": projection.crs,
        "chunk_size_m": projection.chunk_size,
        "coverage_definition": (
            "Downloaded region bounding boxes intersected with the OSM city boundary; "
            "not completeness or live database state."
        ),
        "regions": [],
        "errors": errors,
    }
    try:
        manifest = json.loads((data_dir / "manifest.json").read_text())
        if not isinstance(manifest, dict):
            raise ValueError("manifest must be an object")
    except (OSError, ValueError) as exc:
        errors.append(f"Cannot read manifest: {exc}")
        return report
    downloaded = []
    for slug in selected:
        if slug not in regions:
            errors.append(f"Unknown region: {slug}")
            continue
        name = f"neighborhood-{slug}"
        meta = manifest.get(name, {})
        if not isinstance(meta, dict):
            errors.append(f"{slug}: invalid manifest entry")
            continue
        before = len(errors)
        try:
            data = json.loads((data_dir / f"{name}.json").read_text())
            if not isinstance(data, dict):
                raise ValueError("snapshot must be an object")
            elements = data["elements"]
            if not isinstance(elements, list) or not elements:
                raise ValueError("elements must be a non-empty list")
            if any(
                not isinstance(e, dict)
                or not isinstance(e.get("id"), int)
                or e.get("type") not in {"node", "way", "relation"}
                for e in elements
            ):
                raise ValueError("invalid OSM element identity")
        except (OSError, ValueError, KeyError) as exc:
            errors.append(f"{slug}: invalid or missing snapshot: {exc}")
            continue
        if data.get("remark"):
            errors.append(f"{slug}: Overpass reported {data['remark']}")
        if meta.get("bbox") != list(regions[slug]["bbox"]):
            errors.append(f"{slug}: manifest bbox differs from configured region")
        if meta.get("elements") != len(elements):
            errors.append(f"{slug}: manifest element count differs from snapshot")
        if not meta.get("source") or not meta.get("licence"):
            errors.append(f"{slug}: source attribution or licence is missing")
        timestamp = data.get("osm3s", {}).get("timestamp_osm_base")
        if not timestamp or timestamp != meta.get("osm_base_timestamp"):
            errors.append(f"{slug}: missing or mismatched OSM timestamp")
        ids = [(e.get("type"), e.get("id")) for e in elements]
        if len(set(ids)) != len(ids):
            errors.append(f"{slug}: duplicate OSM identities in snapshot")

        def valid_geometry(geometry):
            return (
                isinstance(geometry, list)
                and bool(geometry)
                and all(
                    isinstance(p, dict)
                    and isinstance(p.get("lat"), (int, float))
                    and isinstance(p.get("lon"), (int, float))
                    and -90 <= p["lat"] <= 90
                    and -180 <= p["lon"] <= 180
                    for p in geometry
                )
            )

        for e in elements:
            if e["type"] == "way" and not e.get("geometry"):
                errors.append(f"{slug}: missing way geometry for {e['id']}")
            geometries = [e["geometry"]] if "geometry" in e else []
            geometries += [m["geometry"] for m in e.get("members", []) if "geometry" in m]
            if any(not valid_geometry(g) for g in geometries):
                errors.append(
                    f"{slug}: incomplete/invalid geometry for {e.get('type')}/{e.get('id')}"
                )
        if len(errors) != before:
            continue
        south, west, north, east = regions[slug]["bbox"]
        boundary = box(west, south, east, north)
        parsed = osm.parse_area(elements)
        buildings = [
            b for b in parsed.buildings if boundary.contains(b.geom.representative_point())
        ]
        roads = [r for r in parsed.roads if boundary.intersects(r.geom)]
        areas = [a for a in parsed.areas if boundary.intersects(a.geom)]
        downloaded.append(projection.geometry_to_world(boundary))
        report["regions"].append(
            {
                "slug": slug,
                "bbox": list(regions[slug]["bbox"]),
                "osm_base_timestamp": timestamp,
                "source": meta["source"],
                "licence": meta["licence"],
                "elements": len(elements),
                "chunk_cells": len(region_cells(regions[slug]["bbox"])),
                "buildings": len(buildings),
                "building_height_sources": dict(Counter(b.height_source for b in buildings)),
                "roads": len(roads),
                "road_width_sources": dict(Counter(r.width_source for r in roads)),
                "water_features": sum(a.kind == "water" for a in areas),
                "snapshot_bbox_area_km2": round(downloaded[-1].area / 1e6, 4),
            }
        )
    # WorldChunk.key is global, but each row has one region_id. Refuse unsafe
    # expansion until shared cells have a canonical merge/ownership implementation.
    owners: dict[str, str] = {}
    collisions: set[tuple[str, str]] = set()
    for slug, region in regions.items():
        for key in region_cells(region["bbox"]):
            if key in owners and (slug in selected or owners[key] in selected):
                collisions.add(tuple(sorted((slug, owners[key]))))
            owners[key] = slug
    for a, b in sorted(collisions):
        shared = region_cells(regions[a]["bbox"]) & region_cells(regions[b]["bbox"])
        errors.append(
            f"Regions {a} and {b} share {len(shared)} global chunk cells; "
            "merge ownership is required before import"
        )
    city_path = data_dir / "city-boundary.json"
    if city_path.exists():
        try:
            city = osm.boundary_multipolygon(json.loads(city_path.read_text())["elements"])
        except (ValueError, KeyError, TypeError):
            errors.append("Invalid city boundary snapshot; coverage cannot be measured")
            city = None
        if city is not None and not city.is_empty:
            city_world = projection.geometry_to_world(city)
            covered = unary_union(downloaded).intersection(city_world)
            report.update(
                city_boundary_area_km2=round(city_world.area / 1e6, 4),
                downloaded_coverage_km2=round(covered.area / 1e6, 4),
                downloaded_coverage_percent=round(100 * covered.area / city_world.area, 4),
            )
        elif not errors:
            errors.append("City boundary geometry is missing; coverage cannot be measured")
    return report


def require_importable(data_dir: Path, slugs: list[str] | None = None) -> dict:
    report = audit_snapshots(data_dir, slugs)
    if report["errors"]:
        raise ValueError("Geographic import preflight failed:\n" + "\n".join(report["errors"]))
    return report
