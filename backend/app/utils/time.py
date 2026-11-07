from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.core.config import settings


def utcnow() -> datetime:
    return datetime.now(UTC)


def local_tz() -> ZoneInfo:
    return ZoneInfo(settings.timezone)


def local_now() -> datetime:
    return utcnow().astimezone(local_tz())


def local_day_bounds(day: date) -> tuple[datetime, datetime]:
    """[start, end) of a canteen-local calendar day, as aware datetimes."""
    tz = local_tz()
    start = datetime.combine(day, time.min, tzinfo=tz)
    return start, start + timedelta(days=1)


def parse_hhmm(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))
