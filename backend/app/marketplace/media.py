"""Uploaded files: product images (public) and verification documents (private).

Product images are decoded and re-encoded as WebP (max 768 px). Re-encoding drops EXIF and
other metadata (phone photos carry GPS coordinates) and anything that is not a real image.
Verification documents are kept byte-for-byte (they are evidence), identified by their magic
bytes rather than the browser's content type, stored outside any public path, and only ever
served to administrators as attachments.
"""

from __future__ import annotations

import hashlib
import io
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile, status
from PIL import Image, UnidentifiedImageError

from app.core.config import settings
from app.core.errors import AppError, bad_request

MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
IMAGE_MAX_SIDE = 768
IMAGE_NAME = re.compile(r"^[0-9a-f]{32}\.webp$")
Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse decompression bombs

DOCUMENT_SIGNATURES: dict[bytes, tuple[str, str]] = {
    b"%PDF-": ("application/pdf", ".pdf"),
    b"\x89PNG\r\n\x1a\n": ("image/png", ".png"),
    b"\xff\xd8\xff": ("image/jpeg", ".jpg"),
}


def product_image_dir() -> Path:
    return settings.media_root / "public" / "products"


def document_dir() -> Path:
    return settings.media_root / "private" / "verifications"


async def _read_limited(upload: UploadFile, limit: int) -> bytes:
    data = await upload.read(limit + 1)
    if len(data) > limit:
        raise AppError(
            status.HTTP_413_CONTENT_TOO_LARGE,
            "FILE_TOO_LARGE",
            f"The file is larger than {limit // (1024 * 1024)} MB.",
        )
    if not data:
        raise bad_request("EMPTY_FILE", "The file is empty.")
    return data


async def save_product_image(upload: UploadFile) -> str:
    data = await _read_limited(upload, MAX_IMAGE_BYTES)
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"}:
                raise bad_request("UNSUPPORTED_IMAGE", "Use a JPEG, PNG or WebP image.")
            image.load()
            frame = image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise bad_request("UNSUPPORTED_IMAGE", "That file is not a readable image.") from exc
    frame.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))
    name = f"{uuid.uuid4().hex}.webp"
    out = product_image_dir()
    out.mkdir(parents=True, exist_ok=True)
    frame.save(out / name, "WEBP", quality=82, method=4)  # no exif/icc/xmp passed through
    return name


def product_image_path(name: str) -> Path | None:
    if not IMAGE_NAME.fullmatch(name):
        return None
    path = product_image_dir() / name
    return path if path.is_file() else None


def delete_product_image(name: str | None) -> None:
    if name and IMAGE_NAME.fullmatch(name):
        (product_image_dir() / name).unlink(missing_ok=True)


@dataclass
class StoredDocument:
    stored_name: str
    content_type: str
    size_bytes: int
    sha256: str
    original_name: str


async def save_document(upload: UploadFile) -> StoredDocument:
    data = await _read_limited(upload, MAX_DOCUMENT_BYTES)
    kind = next((v for sig, v in DOCUMENT_SIGNATURES.items() if data.startswith(sig)), None)
    if kind is None:
        raise bad_request("UNSUPPORTED_DOCUMENT", "Upload a PDF, JPEG or PNG file.")
    content_type, ext = kind
    stored = uuid.uuid4().hex + ext
    out = document_dir()
    out.mkdir(parents=True, exist_ok=True)
    (out / stored).write_bytes(data)
    original = re.sub(r"[^\w.\- ]+", "_", Path(upload.filename or "document").name)[:120]
    return StoredDocument(
        stored_name=stored,
        content_type=content_type,
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        original_name=original or "document",
    )


def document_path(stored_name: str) -> Path | None:
    if not re.fullmatch(r"[0-9a-f]{32}\.(pdf|png|jpg)", stored_name):
        return None
    path = document_dir() / stored_name
    return path if path.is_file() else None
