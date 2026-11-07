from typing import Any

from fastapi import status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, not_found
from app.geography.projection import default_projection
from app.geography.regions import WORLD_ORIGIN
from app.models import AvatarCustomization, User, WorldChunk
from app.schemas.me import AvatarIn
from app.schemas.world import (
    PlayableRegion,
    WorldBootstrapOut,
    WorldBounds,
    WorldConfigOut,
    WorldPlayer,
)
from app.services import geo

ATTRIBUTION = "Map data © OpenStreetMap contributors (ODbL)"


async def config(session: AsyncSession) -> WorldConfigOut:
    projection = default_projection()
    regions = []
    for region in await geo.regions(session, playable_only=True):
        keys = (
            await session.scalars(
                text("""SELECT c.key FROM world_chunks c JOIN geographic_regions r
                    ON r.id = c.region_id WHERE r.slug = :slug ORDER BY c.iz, c.ix"""),
                {"slug": region.slug},
            )
        ).all()
        s, w, n, e = region.bbox
        corners = [projection.to_world(lat, lon) for lat in (s, n) for lon in (w, e)]
        xs, zs = [c[0] for c in corners], [c[1] for c in corners]
        regions.append(
            PlayableRegion(
                slug=region.slug,
                name=region.name,
                name_km=region.name_km,
                bbox=region.bbox,
                world_bounds=WorldBounds(
                    min_x=min(xs), min_z=min(zs), max_x=max(xs), max_z=max(zs)
                ),
                chunk_keys=list(keys),
                dataset=region.dataset,
            )
        )
    return WorldConfigOut(
        crs=projection.crs,
        origin=WORLD_ORIGIN,
        origin_easting=projection.origin_easting,
        origin_northing=projection.origin_northing,
        chunk_size=projection.chunk_size,
        axes="x = east (m), y = up (m), z = -north (m), relative to origin",
        attribution=ATTRIBUTION,
        regions=regions,
    )


async def chunk(session: AsyncSession, key: str) -> WorldChunk:
    row = await session.get(WorldChunk, key)
    if row is None:
        raise not_found("Chunk")
    return row


async def bootstrap(session: AsyncSession, user: User) -> WorldBootstrapOut:
    if user.onboarding_completed_at is None:
        raise AppError(
            status.HTTP_409_CONFLICT,
            "ONBOARDING_INCOMPLETE",
            "Finish setting up your account before entering the world.",
        )
    avatar = await session.scalar(
        select(AvatarCustomization).where(AvatarCustomization.user_id == user.id)
    )
    spawn = await geo.spawn_point(session, user.profile.spawn_point_id)
    if avatar is None or spawn is None:
        raise AppError(
            status.HTTP_409_CONFLICT,
            "ONBOARDING_INCOMPLETE",
            "Choose an avatar and a spawn area first.",
        )
    return WorldBootstrapOut(
        player=WorldPlayer(
            id=user.id,
            username=user.username,
            display_name=user.profile.display_name,
            world_visible=bool(user.profile.world_visible),
            avatar=AvatarIn.model_validate(avatar, from_attributes=True),
        ),
        spawn=spawn,
        config=await config(session),
    )


def chunk_headers(row: WorldChunk) -> dict[str, Any]:
    return {"ETag": f'"{row.etag}"', "Cache-Control": "public, max-age=300"}
