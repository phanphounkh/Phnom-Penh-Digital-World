"""Public marketplace data: shop units for the claim map, storefronts for the 3D city,
product categories, product images, and disputes about a claim."""

import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.deps import ClientIP, CurrentUser, SessionDep
from app.core.errors import bad_request, not_found
from app.core.rate_limit import rate_limit
from app.marketplace import catalog, claims, media
from app.models import GeographicRegion
from app.schemas.common import Message
from app.schemas.market import CategoryOut, DisputeIn, ShopDetailOut, ShopOut, UnitOut

router = APIRouter(prefix="/market", tags=["marketplace"])
media_router = APIRouter(prefix="/media", tags=["marketplace"])


@router.get("/units", response_model=list[UnitOut])
async def units(
    session: SessionDep,
    bbox: str = Query(description="west,south,east,north (WGS84)", max_length=120),
    available: bool = False,
) -> list[UnitOut]:
    try:
        west, south, east, north = (float(v) for v in bbox.split(","))
    except ValueError as exc:
        raise bad_request("INVALID_BBOX", "bbox must be west,south,east,north") from exc
    return await claims.list_units(session, (west, south, east, north), available)


@router.get("/units/{code}", response_model=UnitOut)
async def unit(code: str, session: SessionDep) -> UnitOut:
    return await claims.unit_detail(session, code)


@router.get("/categories", response_model=list[CategoryOut])
async def categories(session: SessionDep) -> list[CategoryOut]:
    return await catalog.categories(session)


@router.get("/shops", response_model=list[ShopOut])
async def shops(session: SessionDep, region: str | None = Query(default=None, max_length=64)):
    region_id = None
    if region:
        region_id = await session.scalar(
            select(GeographicRegion.id).where(GeographicRegion.slug == region)
        )
        if region_id is None:
            raise not_found("Region")
    return await catalog.world_shops(session, region_id)


@router.get("/shops/{shop_id}", response_model=ShopDetailOut)
async def shop(shop_id: uuid.UUID, session: SessionDep) -> ShopDetailOut:
    return await catalog.shop_detail(session, shop_id)


@router.post(
    "/disputes",
    response_model=Message,
    status_code=201,
    dependencies=[Depends(rate_limit("dispute", 5, 86400))],
)
async def dispute(data: DisputeIn, user: CurrentUser, session: SessionDep, ip: ClientIP) -> Message:
    await claims.open_dispute(session, user, data, ip)
    return Message(message="Dispute received. An administrator will review it.")


@media_router.get("/products/{name}")
async def product_image(name: str) -> FileResponse:
    path = media.product_image_path(name)
    if path is None:
        raise not_found("Image")
    # Content-addressed by a random name: cache for a long time.
    return FileResponse(
        path,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
