"""
opcua.pool — the client connection pool.

Manages one engine per client datasource: a DatasourceOpcuaEngine per
opcua-client (and per test server's paired client), a DatasourceAdsEngine per
ads-client. Both expose the same surface, so callers never ask which.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from models.datasource import CLIENT_DATASOURCE_TYPES

from .engine import DatasourceOpcuaEngine

if TYPE_CHECKING:
    from ads.engine import DatasourceAdsEngine


def _new_engine(name: str, ds_type: str) -> DatasourceOpcuaEngine | DatasourceAdsEngine:
    if ds_type == "ads-client":
        # Imported here: ads.engine imports from this package.
        from ads.engine import DatasourceAdsEngine

        return DatasourceAdsEngine(name)
    return DatasourceOpcuaEngine(name)


class OpcuaPool:
    """Manages multiple client engines, keyed by datasource name."""

    def __init__(self) -> None:
        self._engines: dict[str, DatasourceOpcuaEngine | DatasourceAdsEngine] = {}
        self._datasource_manager = None
        self._status_callback = None
        self._priority_recompute_callback = None

    def set_datasource_manager(self, dm: Any) -> None:
        self._datasource_manager = dm

    def set_status_callback(self, cb: Any) -> None:
        self._status_callback = cb

    def set_priority_recompute_callback(self, cb: Any) -> None:
        self._priority_recompute_callback = cb

    def get(self, name: str) -> DatasourceOpcuaEngine | DatasourceAdsEngine | None:
        return self._engines.get(name)

    async def start(self, name: str, settings: dict, ds_type: str = "opcua-client") -> None:
        if name in self._engines:
            await self.stop(name)
        engine = _new_engine(name, ds_type)
        engine.set_datasource_manager(self._datasource_manager)
        if self._status_callback:
            engine.set_status_callback(self._status_callback)
        if self._priority_recompute_callback:
            engine.set_priority_recompute_callback(self._priority_recompute_callback)
        self._engines[name] = engine
        await engine.connect(settings)

    async def stop(self, name: str) -> None:
        engine = self._engines.pop(name, None)
        if engine:
            await engine.disconnect()

    async def restart(self, name: str, settings: dict, ds_type: str = "opcua-client") -> None:
        await self.stop(name)
        await self.start(name, settings, ds_type)

    def connection_status(self) -> dict[str, bool]:
        """Point-in-time snapshot of connected state for all active engines.

        Read-only: callers cannot mutate pool ownership through this mapping.
        """
        return {name: engine.connected for name, engine in self._engines.items()}

    def subscription_status(self) -> dict[str, dict]:
        """Return subscription diagnostics for all active engines."""
        return {name: engine.subscription_status() for name, engine in self._engines.items()}

    async def start_all(self, datasource_manager: Any) -> None:
        """Start engines for all client datasources."""
        for name, entry in datasource_manager.datasources.items():
            if entry.ds_type in CLIENT_DATASOURCE_TYPES:
                await self.start(name, entry.config.get("settings", {}), entry.ds_type)

    async def stop_all(self) -> None:
        names = list(self._engines.keys())
        for name in names:
            await self.stop(name)


opcua_pool = OpcuaPool()
