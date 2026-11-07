from fastapi import APIRouter, Path, Request, Response
from fastapi.responses import JSONResponse

from app.api.deps import CurrentUser, SessionDep
from app.schemas.world import WorldBootstrapOut, WorldConfigOut
from app.services import world

router = APIRouter(prefix="/world", tags=["world"])


@router.get("/config", response_model=WorldConfigOut, summary="Projection, origin and chunk index")
async def config(session: SessionDep) -> WorldConfigOut:
    return await world.config(session)


@router.get(
    "/bootstrap",
    response_model=WorldBootstrapOut,
    summary="Everything the client needs to enter the world as the signed-in player",
)
async def bootstrap(user: CurrentUser, session: SessionDep) -> WorldBootstrapOut:
    return await world.bootstrap(session, user)


@router.get(
    "/chunks/{key}",
    summary="One streamed chunk: roads, buildings, areas, landmarks (world metres)",
    responses={304: {"description": "Not modified"}},
)
async def chunk(
    request: Request,
    session: SessionDep,
    key: str = Path(pattern=r"^-?\d{1,4}_-?\d{1,4}$"),
) -> Response:
    row = await world.chunk(session, key)
    headers = world.chunk_headers(row)
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    return JSONResponse(row.payload, headers=headers)
