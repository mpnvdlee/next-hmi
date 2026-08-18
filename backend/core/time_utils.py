from datetime import UTC, datetime


def iso_now(precision: str = "seconds") -> str:
    """UTC ISO-8601 with trailing 'Z'. ``precision`` is passed as ``timespec``."""
    return datetime.now(UTC).isoformat(timespec=precision).replace("+00:00", "Z")
