"""Recipe manager — parameter datasets: load/save config, download (write a
dataset's values to variables), upload (read live values back into a dataset).

Config (dataset types + parameters + saved datasets) is persisted in
``recipes.json``; the loaded-dataset-per-type pointer lives in
``recipe_state.json``. Downloads and uploads go through the shared
``write_service`` so they share one coerce/dispatch/verify path with client
writes.

Thread-safety: a ``threading.Lock`` guards config/state. The async download /
upload methods never hold the lock across an ``await`` — they snapshot under the
lock, perform the writes/reads, then re-acquire to record results. An
``asyncio.Lock`` additionally serializes whole download/upload operations so
concurrent ones can't interleave their writes and leave the loaded pointer out
of sync with the values actually on the variables.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable
from typing import Any

from core.ids import slug_id
from core.storage import (
    active_recipe_state_path,
    active_recipes_config_path,
    load_json_or_default,
    write_json,
)
from core.time_utils import iso_now
from models.recipe import (
    DownloadFailure,
    DownloadResult,
    LoadedDataset,
    RecipeConfig,
    RecipeDataset,
    RecipeDatasetType,
    RecipeState,
)

from services import write_service

logger = logging.getLogger(__name__)


def _assign_config_ids(config: RecipeConfig) -> None:
    """Backfill slug IDs for any type / parameter / dataset lacking one (in place).

    Type IDs are unique among types. Parameter and dataset IDs are unique within
    their own type (values maps and loaded-state pointers are type-scoped).
    """
    type_ids: set[str] = {t.id for t in config.dataset_types if t.id}
    for dtype in config.dataset_types:
        if not dtype.id:
            dtype.id = slug_id(dtype.name or "type", type_ids)
            type_ids.add(dtype.id)
        param_ids: set[str] = {p.id for p in dtype.parameters if p.id}
        for param in dtype.parameters:
            if not param.id:
                param.id = slug_id(param.label or "parameter", param_ids)
                param_ids.add(param.id)
        dataset_ids: set[str] = {d.id for d in dtype.datasets if d.id}
        for dataset in dtype.datasets:
            if not dataset.id:
                dataset.id = slug_id(dataset.name or "dataset", dataset_ids)
                dataset_ids.add(dataset.id)


class RecipeManager:
    """Singleton recipe config/state store and download/upload engine."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._op_lock = asyncio.Lock()
        self._config: RecipeConfig = RecipeConfig()
        self._state: RecipeState = RecipeState()
        self._last_result: DownloadResult | None = None
        self._broadcast_callback: Callable[..., Any] | None = None
        self._datasource_manager: Any = None
        self._opcua_pool: Any = None

    # ── Wiring ────────────────────────────────────────────────────────────────

    def set_datasource_manager(self, dm: Any) -> None:
        self._datasource_manager = dm

    def set_opcua_pool(self, pool: Any) -> None:
        self._opcua_pool = pool

    def set_broadcast_callback(self, fn: Callable[..., Any]) -> None:
        self._broadcast_callback = fn

    # ── Load / Save ───────────────────────────────────────────────────────────

    def load(self) -> None:
        with self._lock:
            self._config = load_json_or_default(
                active_recipes_config_path(), RecipeConfig, RecipeConfig.model_validate,
            )
            self._state = load_json_or_default(
                active_recipe_state_path(), RecipeState, RecipeState.model_validate,
            )

    def _save_config(self) -> None:
        write_json(active_recipes_config_path(), self._config.model_dump(by_alias=True))

    def _save_state(self) -> None:
        write_json(active_recipe_state_path(), self._state.model_dump(by_alias=True))

    # ── Config accessors ──────────────────────────────────────────────────────

    def get_config(self) -> RecipeConfig:
        with self._lock:
            return self._config.model_copy(deep=True)

    def set_config(self, config: RecipeConfig) -> None:
        with self._lock:
            _assign_config_ids(config)
            self._preserve_loaded_stamps(config)
            self._config = config
            self._save_config()
        logger.info("Recipe config updated (%d dataset types)", len(config.dataset_types))
        self._request_broadcast()

    def _preserve_loaded_stamps(self, incoming: RecipeConfig) -> None:
        """Carry runtime-owned ``loaded_at`` stamps from the current config onto
        *incoming* (in place). Lock held by caller.

        ``loaded_at`` is set only by ``download`` and has no editor UI, so a
        config PUT always carries an empty value for it — without this a save
        from the editor would revert the last-loaded stamp shown by
        ``$recipeList``.
        """
        stored: dict[tuple[str, str], str] = {}
        for dtype in self._config.dataset_types:
            for dataset in dtype.datasets:
                if dataset.loaded_at:
                    stored[(dtype.id, dataset.id)] = dataset.loaded_at
        if not stored:
            return
        for dtype in incoming.dataset_types:
            for dataset in dtype.datasets:
                if not dataset.loaded_at:
                    dataset.loaded_at = stored.get((dtype.id, dataset.id), "")

    def get_state(self) -> dict[str, LoadedDataset]:
        with self._lock:
            return {k: v.model_copy() for k, v in self._state.loaded.items()}

    def get_parameter_paths_by_datasource(self) -> dict[str, set[str]]:
        """Return {datasource: set-of-paths} for every parameter binding.

        Feeds the priority (fast) subscription set so live values used by Upload
        and ``parametersChanged`` stay fresh.
        """
        with self._lock:
            result: dict[str, set[str]] = {}
            for dtype in self._config.dataset_types:
                for param in dtype.parameters:
                    ds, path = param.resolve_datasource_path()
                    if ds and path:
                        result.setdefault(ds, set()).add(path)
            return result

    # ── Lookups ───────────────────────────────────────────────────────────────

    def _locate(
        self, dataset_id: str,
    ) -> tuple[RecipeDatasetType, RecipeDataset] | None:
        """Return the (type, dataset) references for a dataset id. Lock held by caller."""
        for dtype in self._config.dataset_types:
            for dataset in dtype.datasets:
                if dataset.id == dataset_id:
                    return dtype, dataset
        return None

    # ── Download (write a dataset's stored values to variables) ────────────────

    async def download(
        self,
        dataset_id: str,
        *,
        verify: bool = False,
        permission_check: Callable[[str, str], bool] | None = None,
    ) -> DownloadResult | None:
        """Write every parameter's stored value to its variable.

        Continues on error, collecting per-parameter failures. On success or
        partial success, records the dataset as loaded for its type (replacing
        any prior load for that type) and stamps the dataset's own `loaded_at`.
        Returns None when the dataset id is unknown.

        ``permission_check(datasource, path)`` — when supplied — gates each write;
        a parameter it rejects becomes a ``permission_denied`` failure and is not
        written. Callers with a client identity (the recipe WS handler) pass one
        so recipe downloads honour the same per-variable write ACL as direct
        client writes.
        """
        async with self._op_lock:
            with self._lock:
                located = self._locate(dataset_id)
                if located is None:
                    return None
                dtype, dataset = located
                type_id = dtype.id
                params = [p.model_copy(deep=True) for p in dtype.parameters]
                values = dict(dataset.values)

            failures: list[DownloadFailure] = []
            written = 0
            total = len(params)
            for param in params:
                ds_name, path = param.resolve_datasource_path()
                if not ds_name or not path:
                    failures.append(DownloadFailure(parameterId=param.id, reason="unbound"))
                    continue
                if param.id not in values:
                    failures.append(DownloadFailure(parameterId=param.id, reason="no_value"))
                    continue
                if permission_check is not None and not permission_check(ds_name, path):
                    failures.append(
                        DownloadFailure(parameterId=param.id, reason="permission_denied")
                    )
                    continue
                idx = param.resolve_index()
                write_path = f"{path}[{idx}]" if idx is not None else path
                outcome = await write_service.write_value(
                    self._datasource_manager, self._opcua_pool,
                    ds_name, write_path, values[param.id], verify=verify,
                )
                if outcome.ok:
                    written += 1
                else:
                    failures.append(
                        DownloadFailure(parameterId=param.id, reason=outcome.reason or "write_failed")
                    )

            kind = "success" if not failures else ("failed" if written == 0 else "partial")
            result = DownloadResult(
                result=kind, datasetId=dataset_id, written=written,
                total=total, verified=verify, failures=failures,
            )

            with self._lock:
                if kind in ("success", "partial"):
                    now = iso_now()
                    self._state.loaded[type_id] = LoadedDataset(datasetId=dataset_id, loadedAt=now)
                    self._save_state()
                    located = self._locate(dataset_id)
                    if located is not None:
                        located[1].loaded_at = now
                        self._save_config()
                self._last_result = result

        logger.info(
            "Recipe download '%s': %s (%d/%d written%s)",
            dataset_id, kind, written, total, ", verified" if verify else "",
        )
        self._request_broadcast()
        return result

    # ── Upload (read live values into a dataset, overwrite in place) ───────────

    async def upload_into(self, dataset_id: str, *, username: str = "") -> RecipeConfig | None:
        """Read current live values for a dataset's type and overwrite the
        dataset's stored values in place. Returns None when the id is unknown.

        A parameter whose live value can't be read (``read_value`` returns None)
        keeps its previously-stored value rather than being overwritten with
        null, so a transient read blip doesn't corrupt the saved dataset."""
        async with self._op_lock:
            with self._lock:
                located = self._locate(dataset_id)
                if located is None:
                    return None
                _dtype, dataset = located
                params = [p.model_copy(deep=True) for p in _dtype.parameters]
                new_values = dict(dataset.values)

            for param in params:
                ds_name, path = param.resolve_datasource_path()
                if not ds_name or not path:
                    continue
                idx = param.resolve_index()
                read_path = f"{path}[{idx}]" if idx is not None else path
                value = await write_service.read_value(
                    self._datasource_manager, self._opcua_pool, ds_name, read_path,
                )
                if value is not None:
                    new_values[param.id] = value

            with self._lock:
                located = self._locate(dataset_id)
                if located is None:
                    return None
                _dtype, dataset = located
                dataset.values = new_values
                dataset.updated_at = iso_now()
                dataset.updated_by = username
                self._save_config()
                config_copy = self._config.model_copy(deep=True)

        logger.info("Recipe upload into '%s' by %s", dataset_id, username or "unknown")
        self._request_broadcast()
        return config_copy

    # ── Broadcast helpers ─────────────────────────────────────────────────────

    def _payload_data(self) -> dict[str, Any]:
        """Shared config + loaded-per-type + last-result data. Call under the lock."""
        return {
            "config": self._config.model_dump(by_alias=True),
            "loaded": {k: v.model_dump(by_alias=True) for k, v in self._state.loaded.items()},
            "lastResult": self._last_result.model_dump(by_alias=True) if self._last_result else None,
        }

    def _request_broadcast(self) -> None:
        if self._broadcast_callback is None:
            return
        with self._lock:
            payload = {"type": "recipe_update", **self._payload_data()}
        try:
            self._broadcast_callback(payload)
        except Exception:
            logger.exception("Failed to broadcast recipe update")

    def build_snapshot_payload(self) -> dict[str, Any]:
        """Full recipe snapshot for newly connected clients."""
        with self._lock:
            return {"type": "recipe_snapshot", **self._payload_data()}


# Singleton instance
recipe_manager = RecipeManager()
