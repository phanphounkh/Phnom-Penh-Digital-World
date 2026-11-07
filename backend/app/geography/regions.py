"""Geographic constants shared by the OSM fetch tool (tools/gis) and the backend importer.

The world uses UTM zone 48N (EPSG:32648), the standard metric projection for Phnom Penh.
World coordinates are metres relative to WORLD_ORIGIN:  x = east, y = up, z = -north
(Three.js convention: the camera looks down -Z, so north is "forward").
"""

# Phsar Thmei (Central Market) dome — the origin of the playable world.
WORLD_ORIGIN = {"lat": 11.56955, "lon": 104.92115, "name": "Phsar Thmei (Central Market)"}
WORLD_CRS = "EPSG:32648"
CHUNK_SIZE_M = 200

# Playable neighbourhoods. bbox = (south, west, north, east) in WGS84 degrees.
NEIGHBORHOODS = {
    "daun-penh-central": {
        "name": "Daun Penh — Central Market, Wat Phnom & Riverside",
        "name_km": "ដូនពេញ — ផ្សារធំថ្មី វត្តភ្នំ និងមាត់ទន្លេ",
        "bbox": (11.5650, 104.9165, 11.5790, 104.9330),
    },
}

# Fallback service area if the official boundary snapshot is unavailable (approximate).
PHNOM_PENH_FALLBACK_BBOX = (11.40, 104.70, 11.75, 105.05)


# Curated PUBLIC spawn areas. lat/lon name the landmark itself; the importer places the avatar
# on the nearest open ground (>= 14 m from any building or water) and faces it towards the
# landmark. `heading_deg` is only a fallback. Never a private address.
SPAWN_POINTS = [
    {
        "slug": "central-market",
        "name": "Phsar Thmei (Central Market)",
        "name_km": "ផ្សារធំថ្មី",
        "description": "The 1937 Art Deco market hall at the heart of Daun Penh.",
        "lat": 11.56955,
        "lon": 104.92115,
        "heading_deg": 270,
    },
    {
        "slug": "wat-phnom",
        "name": "Wat Phnom",
        "name_km": "វត្តភ្នំ",
        "description": "The hilltop pagoda that gives Phnom Penh its name.",
        "lat": 11.57615,
        "lon": 104.92320,
        "heading_deg": 0,
    },
    {
        "slug": "riverside",
        "name": "Sisowath Quay Riverside",
        "name_km": "មាត់ទន្លេស៊ីសុវត្ថិ",
        "description": "The riverside promenade along the Tonle Sap.",
        # West-bank promenade between Sisowath Quay and the river, facing the water.
        "lat": 11.57000,
        "lon": 104.93050,
        "heading_deg": 90,
    },
    {
        "slug": "canadia-garden",
        "name": "Canadia Garden",
        "name_km": "សួនកាណាឌីយ៉ា",
        "description": "A shaded garden between the market district and Wat Phnom.",
        "lat": 11.57200,
        "lon": 104.92100,
        "heading_deg": 180,
    },
    {
        "slug": "veal-preah-meru",
        "name": "Veal Preah Meru (near the Royal Palace)",
        "name_km": "វាលព្រះមេរុ",
        "description": "The open ground north of the Royal Palace by the river.",
        "lat": 11.56590,
        "lon": 104.93030,
        "heading_deg": 0,
    },
]
