"""
opcua.pool — the OPC-UA connection pool.

Manages one DatasourceOpcuaEngine per opcua-client datasource.
"""

from typing import Any

from .engine import DatasourceOpcuaEngine


class OpcuaPool:
    """Manages multiple DatasourceOpcuaEngine instances."""

    def __init__(self) -> None:
        self._engines: dict[str, DatasourceOpcuaEngine] = {}
        self._datasource_manager = None
        self._status_callback = None
        self._priority_recompute_callback = None

    def set_datasource_manager(self, dm: Any) -> None:
        self._datasource_manager = dm

    def set_status_callback(self, cb: Any) -> None:
        self._status_callback = cb

    def set_priority_recompute_callback(self, cb: Any) -> None:
        self._priority_recompute_callback = cb

    def get(self, name: str) -> DatasourceOpcuaEngine | None:
        return self._engines.get(name)

    async def start(self, name: str, settings: dict) -> None:
        if name in self._engines:
            await self.stop(name)
        engine = DatasourceOpcuaEngine(name)
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

    async def restart(self, name: str, settings: dict) -> None:
        await self.stop(name)
        await self.start(name, settings)

    def connection_status(self) -> dict[str, bool]:
        """Point-in-time snapshot of connected state for all active engines.

        Read-only: callers cannot mutate pool ownership through this mapping.
        """
        return {name: engine.connected for name, engine in self._engines.items()}

    def subscription_status(self) -> dict[str, dict]:
        """Return subscription diagnostics for all active engines."""
        return {name: engine.subscription_status() for name, engine in self._engines.items()}

    async def start_all(self, datasource_manager: Any) -> None:
        """Start engines for all opcua-client datasources."""
        for name, entry in datasource_manager.datasources.items():
            if entry.ds_type == "opcua-client":
                await self.start(name, entry.config.get("settings", {}))

    async def stop_all(self) -> None:
        names = list(self._engines.keys())
        for name in names:
            await self.stop(name)


opcua_pool = OpcuaPool()
