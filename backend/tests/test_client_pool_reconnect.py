"""Tests for DatasourceOpcuaEngine connect/reconnect state handling (§2.4, §2.5)."""

import asyncio

import opcua.client_pool as client_pool_module
import pytest
from opcua.client_pool import DatasourceOpcuaEngine


class _FakeAsyncuaClient:
    def __init__(self, url: str) -> None:
        self.url = url
        self.disconnected = False

    def set_user(self, _username: str) -> None: ...
    def set_password(self, _password: str) -> None: ...

    async def connect(self) -> None:
        return None

    async def disconnect(self) -> None:
        self.disconnected = True

    async def get_namespace_array(self):
        return []

    def get_node(self, _node_id: str):
        return object()

    def get_objects_node(self):
        return object()


@pytest.mark.asyncio
async def test_do_connect_resets_connected_state_on_subscription_setup_failure(monkeypatch):
    """§2.4: a failure in _setup_subscriptions must reset _connected so the
    reconnect loop actually retries instead of reporting a healthy connection
    with zero working subscriptions forever."""
    monkeypatch.setattr(client_pool_module, "Client", lambda url: _FakeAsyncuaClient(url))

    engine = DatasourceOpcuaEngine("DS")
    engine._config = {"server_url": "opc.tcp://fake:4840"}

    call_count = 0

    async def flaky_setup():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("simulated subscription setup failure")

    monkeypatch.setattr(engine, "_setup_subscriptions", flaky_setup)

    with pytest.raises(RuntimeError):
        await engine._do_connect()

    assert engine._connected is False
    assert engine._client is None

    # Recovers on the next attempt.
    await engine._do_connect()
    assert engine._connected is True
    assert call_count == 2


# ── §2.5: concurrent close calls coalesce; disconnect() cancels the status task


@pytest.mark.asyncio
async def test_concurrent_close_calls_coalesce_into_one_execution(monkeypatch):
    """A status-change close and the reconnect loop's own close, triggered
    together, must run the actual teardown exactly once — not race each
    other through _client/_connected independently."""
    engine = DatasourceOpcuaEngine("DS")
    engine._client = _FakeAsyncuaClient("opc.tcp://fake:4840")
    engine._connected = True

    impl_calls = 0
    real_impl = engine._close_client_impl

    async def counting_impl():
        nonlocal impl_calls
        impl_calls += 1
        await asyncio.sleep(0)  # yield, so the two callers actually overlap
        await real_impl()

    monkeypatch.setattr(engine, "_close_client_impl", counting_impl)

    await asyncio.gather(engine._close_client(), engine._close_client())

    assert impl_calls == 1
    assert engine._connected is False
    assert engine._close_task is None


@pytest.mark.asyncio
async def test_disconnect_cancels_pending_status_close_task():
    """disconnect() must cancel a still-pending status-change close instead of
    leaving it to run against the torn-down engine afterward."""
    engine = DatasourceOpcuaEngine("DS")
    engine._client = _FakeAsyncuaClient("opc.tcp://fake:4840")
    engine._connected = True

    ran = False

    async def slow_close():
        nonlocal ran
        await asyncio.sleep(10)  # never actually completes in this test
        ran = True

    engine._status_close_task = asyncio.create_task(slow_close())
    await asyncio.sleep(0)  # let the task start

    await engine.disconnect()

    assert ran is False
    assert engine._status_close_task is None
    assert engine._connected is False


# ── §2.8: reconnect_interval_s validated/clamped like the other intervals ─────


@pytest.mark.asyncio
async def test_reconnect_loop_survives_non_numeric_interval():
    """A blank/non-numeric reconnect_interval_s must not raise — it falls
    back to the default via get_config_float instead of a bare float()."""
    engine = DatasourceOpcuaEngine("DS")
    engine._config = {"reconnect_interval_s": "not-a-number"}
    engine._shutdown = True  # loop body never runs; only the interval line does

    await engine._reconnect_loop()  # must not raise


@pytest.mark.asyncio
async def test_reconnect_loop_survives_zero_interval():
    engine = DatasourceOpcuaEngine("DS")
    engine._config = {"reconnect_interval_s": 0}
    engine._shutdown = True

    await engine._reconnect_loop()  # must not raise / spin
