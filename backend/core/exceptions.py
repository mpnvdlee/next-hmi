"""
Domain exceptions for NEXT HMI — thin wrappers used by API and service layers.

FastAPI exception handlers convert these to consistent HTTP error shapes:
  NotFoundError    -> 404  { "detail": "<message>" }
  ConflictError    -> 409  { "detail": "<message>" }
  ValidationError  -> 422  { "detail": "<message>" }

Usage in a route:
    from core.exceptions import NotFoundError
    entry = datasource_manager.get(name)
    if entry is None:
        raise NotFoundError(f"Datasource '{name}' not found")
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class NextHmiError(Exception):
    """Base class for all NEXT HMI domain errors."""
    status_code: int = 500

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class NotFoundError(NextHmiError):
    """The requested resource does not exist."""
    status_code = 404


class ConflictError(NextHmiError):
    """The operation conflicts with existing state (e.g. duplicate name)."""
    status_code = 409


class ValidationError(NextHmiError):
    """The request payload fails domain validation."""
    status_code = 422


class RateLimitError(NextHmiError):
    """The caller is temporarily throttled (e.g. too many failed logins)."""
    status_code = 429


# --- Domain-specific subclasses ---
# Subclass, never base-class, when raising from a specific domain.
# Existing `except ValidationError / NotFoundError / ConflictError` catches
# continue to work because subclasses satisfy isinstance() checks.

class AlarmValidationError(ValidationError): ...
class AlarmNotFoundError(NotFoundError): ...

class ConfigValidationError(ValidationError): ...
class ConfigNotFoundError(NotFoundError): ...
class ConfigConflictError(ConflictError): ...

class DatasourceValidationError(ValidationError): ...
class DatasourceNotFoundError(NotFoundError): ...
class DatasourceConflictError(ConflictError): ...

class UserValidationError(ValidationError): ...
class UserNotFoundError(NotFoundError): ...
class UserConflictError(ConflictError): ...

class ComponentValidationError(ValidationError): ...
class ComponentNotFoundError(NotFoundError): ...
class ComponentConflictError(ConflictError): ...

class ThemeValidationError(ValidationError): ...
class ThemeNotFoundError(NotFoundError): ...
class ThemeConflictError(ConflictError): ...

class RecipeNotFoundError(NotFoundError): ...


def register_exception_handlers(app: FastAPI) -> None:
    """Register NextHmiError -> JSONResponse handlers on the given FastAPI app."""

    @app.exception_handler(NextHmiError)
    async def _nexthmi_error_handler(request: Request, exc: NextHmiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.message},
        )

    # Imported here (not at module top) so importing core.exceptions stays
    # cheap — storage drags in pydantic + the manifest model.
    from core.storage import NoLiveProjectError

    @app.exception_handler(NoLiveProjectError)
    async def _no_live_project_handler(request: Request, exc: NoLiveProjectError) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={"detail": str(exc), "code": exc.code},
        )
