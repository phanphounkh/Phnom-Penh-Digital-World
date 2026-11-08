import math
from datetime import timedelta
from typing import Any

from fastapi import status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, not_found
from app.geography.projection import default_projection
from app.geography.regions import WORLD_ORIGIN
from app.geography.terrain import default_mounds
from app.models import (
    AvatarCustomization,
    GeographicRegion,
    PlayerSession,
    User,
    WorldChunk,
    WorldRoom,
)
from app.schemas.me import AvatarIn
from app.schemas.world import (
    PlayableRegion,
    StartPosition,
    TerrainFeature,
    WorldBootstrapOut,
    WorldBounds,
    WorldConfigOut,
    WorldPlayer,
)
from app.services import geo
from app.utils.time import utcnow

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
        terrain=[
            TerrainFeature(kind="mound", **{k: v for k, v in vars(m).items()})
            for m in default_mounds()
        ],
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
        start=await start_position(session, user, spawn),
        config=await config(session),
    )


async def start_position(session: AsyncSession, user: User, spawn: Any) -> StartPosition:
    """Resume a recent session's virtual position, else the chosen spawn point."""
    yaw = math.pi - math.radians(spawn.heading_deg)
    minutes = settings.world_resume_minutes
    last = (
        await session.execute(
            select(PlayerSession.last_x, PlayerSession.last_z)
            .join(WorldRoom, WorldRoom.id == PlayerSession.room_id)
            .join(GeographicRegion, GeographicRegion.id == WorldRoom.region_id)
            .where(
                PlayerSession.user_id == user.id,
                PlayerSession.last_x.is_not(None),
                GeographicRegion.slug == spawn.region,
                func.coalesce(PlayerSession.disconnected_at, PlayerSession.last_seen_at)
                > utcnow() - timedelta(minutes=minutes),
            )
            .order_by(PlayerSession.connected_at.desc())
            .limit(1)
        )
    ).first()
    if minutes and last is not None:
        return StartPosition(
            x=round(last.last_x, 2), z=round(last.last_z, 2), yaw=yaw, resumed=True
        )
    return StartPosition(x=spawn.x, z=spawn.z, yaw=yaw, resumed=False)


def chunk_headers(row: WorldChunk) -> dict[str, Any]:
    return {"ETag": f'"{row.etag}"', "Cache-Control": "public, max-age=300"}
