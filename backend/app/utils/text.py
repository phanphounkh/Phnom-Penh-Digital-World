import re
import unicodedata


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    return slug[:80]


def normalize_phone(value: str) -> str:
    """Keep a leading + and digits only: '+855 12-345 678' -> '+85512345678'."""
    value = value.strip()
    digits = re.sub(r"\D", "", value)
    return f"+{digits}" if value.startswith("+") else digits


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
