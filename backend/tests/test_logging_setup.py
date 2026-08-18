import logging

from core.logging_setup import _ClientDisconnectFilter, _silence_client_disconnect_noise


def _record(message: str, exc: BaseException | None) -> logging.LogRecord:
    """A record shaped like asyncio's default exception handler emits."""
    return logging.LogRecord(
        name="asyncio",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=(),
        exc_info=(type(exc), exc, exc.__traceback__) if exc is not None else None,
    )


PROACTOR_MESSAGE = (
    "Exception in callback _ProactorBasePipeTransport._call_connection_lost()\n"
    "handle: <Handle _ProactorBasePipeTransport._call_connection_lost()>"
)


def test_drops_connection_reset_from_connection_lost():
    filt = _ClientDisconnectFilter()
    exc = ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host")
    assert filt.filter(_record(PROACTOR_MESSAGE, exc)) is False


def test_keeps_other_exceptions_from_the_same_callback():
    filt = _ClientDisconnectFilter()
    assert filt.filter(_record(PROACTOR_MESSAGE, ValueError("boom"))) is True


def test_keeps_connection_reset_from_other_callbacks():
    filt = _ClientDisconnectFilter()
    message = "Exception in callback SomeService._poll()"
    assert filt.filter(_record(message, ConnectionResetError())) is True


def test_keeps_records_without_exception_info():
    filt = _ClientDisconnectFilter()
    assert filt.filter(_record(PROACTOR_MESSAGE, None)) is True


def test_installs_once():
    asyncio_logger = logging.getLogger("asyncio")
    before = list(asyncio_logger.filters)
    try:
        _silence_client_disconnect_noise()
        _silence_client_disconnect_noise()
        installed = [f for f in asyncio_logger.filters if isinstance(f, _ClientDisconnectFilter)]
        assert len(installed) == 1
    finally:
        asyncio_logger.filters = before
