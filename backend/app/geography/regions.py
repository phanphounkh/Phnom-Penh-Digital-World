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

# Terrain features. Phnom Penh is flat (about 10 m above sea level) except Wat Phnom, the
# man-made hill the city is named after. It is modelled as a smooth mound: a flat top that
# holds the vihara and stupa, falling to street level along the mapped staircases. The height
# (~27 m) is the commonly published figure; the shape is an approximation, not a survey.
TERRAIN_FEATURES = [
    {
        "slug": "wat-phnom-hill",
        "kind": "mound",
        "lat": 11.57613,
        "lon": 104.92322,
        "height_m": 27.0,
        "top_radius_m": 24.0,
        "base_radius_m": 68.0,
        "source": "Height: published ~27 m. Shape: fitted to the OSM stupa, vihara and "
        "staircase positions; not surveyed.",
    },
]

# Per-building corrections for landmarks, keyed by (osm_type, osm_id). Anything not in OSM is
# labelled: "reference" = a published figure, "estimated" = our approximation.
LANDMARK_OVERRIDES: dict[tuple[str, int], dict] = {
    # Phsar Thmei (Central Market), 1937. The X-shaped wings, the central domed hall
    # (rendered with a Blender dome model) and two footprints that duplicate them in OSM.
    ("way", 859466535): {
        "height_m": 10.0,
        "height_source": "estimated",
        "note": "Phsar Thmei wings; height estimated from photographs",
    },
    ("way", 859469220): {
        "model": "phsar-thmei-dome",
        "height_m": 26.0,
        "base_height_m": 10.0,
        "height_source": "reference",
        "note": "Phsar Thmei central dome; commonly published as 26 m high",
    },
    ("way", 842087292): {"hide": True, "note": "Centre piece inside the dome model"},
    ("way", 1034727803): {"hide": True, "note": "Duplicate of way 859466535 (0.3 m apart)"},
    # Wat Phnom: the hilltop vihara (Khmer roof) and the stupa of King Ponhea Yat.
    ("way", 269798573): {
        "roof": "khmer",
        "height_m": 6.0,
        "height_source": "estimated",
        "note": "Wat Phnom vihara walls; tiered Khmer roof added on top",
    },
    ("way", 487758678): {
        "model": "stupa",
        "height_m": 18.0,
        "height_source": "estimated",
        "note": "Wat Phnom stupa; height estimated as ~2x its mapped base diameter",
    },
}

# Building types that get a tiered Khmer roof.
KHMER_ROOF_KINDS = {"temple", "pagoda", "religious", "monastery", "shrine"}
