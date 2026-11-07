"""Small in-memory sliding-window rate limiter for sensitive endpoints.

It is per-process: with several workers or hosts, swap the store for Redis.
"""

import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import Request, status

from app.core.config import settings
from app.core.errors import AppError


def client_ip(request: Request) -> str:
    if settings.trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self.enabled = True

    def hit(self, key: str, limit: int, window_seconds: int) -> int | None:
        """Record a hit. Returns seconds to wait if the limit is exceeded, else None."""
        if not self.enabled:
            return None
        now = time.monotonic()
        hits = self._hits[key]
        while hits and hits[0] <= now - window_seconds:
            hits.popleft()
        if len(hits) >= limit:
            return max(1, int(hits[0] + window_seconds - now) + 1)
        hits.append(now)
        return None

    def reset(self) -> None:
        self._hits.clear()


limiter = RateLimiter()


def rate_limit(scope: str, limit: int, window_seconds: int) -> Callable[[Request], None]:
    """FastAPI dependency: `dependencies=[Depends(rate_limit("login", 10, 60))]`."""

    def dependency(request: Request) -> None:
        retry_after = limiter.hit(f"{scope}:{client_ip(request)}", limit, window_seconds)
        if retry_after is not None:
            raise AppError(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Too many requests. Please wait a moment and try again.",
                headers={"Retry-After": str(retry_after)},
            )

    return dependency
