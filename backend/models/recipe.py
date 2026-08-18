"""Recipe (parameter dataset) configuration and runtime state models.

A project defines one or more *dataset types*. Each type owns a list of
*parameters* — each parameter binds to a writable variable and carries a data
type (inferred from the variable, no value). Under a type live any number of
*saved datasets*: named value sets holding one value per parameter of that type.

Config is persisted in ``recipes.json``; the loaded-dataset-per-type pointer is
persisted separately in ``recipe_state.json``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from models.binding import resolve_var_binding, resolve_var_index

# Canonical simple-type vocabulary (mirrors the binding-picker filter) + arrays.
RecipeDataType = Literal[
    "boolean", "integer", "float", "string", "datetime",
    "boolean[]", "integer[]", "float[]", "string[]", "datetime[]",
]

DownloadResultKind = Literal["success", "partial", "failed"]


# ── Configuration models (persisted in recipes.json) ──────────────────────────


class RecipeParameter(BaseModel):
    """A single parameter definition shared by every dataset of its type."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = ""  # slug assigned by the service layer
    label: str = ""
    # Binding to a writable variable: { "$var": { "path": "datasource:location" } }
    binding: Any = None
    # Inferred from the bound variable when the parameter is added.
    data_type: RecipeDataType = Field(default="float", alias="dataType")

    def resolve_datasource_path(self) -> tuple[str, str]:
        """Extract (datasource, location) from the binding's $var source."""
        return resolve_var_binding(self.binding)

    def resolve_index(self) -> int | None:
        """Return the array element index from the binding, or None."""
        return resolve_var_index(self.binding)


class RecipeDataset(BaseModel):
    """A saved value set for one dataset type: one value per parameter."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = ""  # slug assigned by the service layer
    name: str = ""
    description: str = ""
    values: dict[str, Any] = Field(default_factory=dict)  # parameterId -> value
    updated_at: str = Field(default="", alias="updatedAt")
    updated_by: str = Field(default="", alias="updatedBy")
    loaded_at: str = Field(default="", alias="loadedAt")


class RecipeDatasetType(BaseModel):
    """An independent axis: parameters + the saved datasets holding their values."""

    model_config = ConfigDict(extra="forbid")

    id: str = ""  # slug assigned by the service layer
    name: str = ""
    parameters: list[RecipeParameter] = Field(default_factory=list)
    datasets: list[RecipeDataset] = Field(default_factory=list)


class RecipeConfig(BaseModel):
    """Top-level recipe configuration document."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: int = 1
    dataset_types: list[RecipeDatasetType] = Field(
        default_factory=list, alias="datasetTypes"
    )


# ── Runtime state models (persisted in recipe_state.json) ─────────────────────


class LoadedDataset(BaseModel):
    """Pointer to the dataset currently loaded for a type."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    dataset_id: str = Field(alias="datasetId")
    loaded_at: str = Field(default="", alias="loadedAt")


class RecipeState(BaseModel):
    """Persisted runtime state: the loaded dataset per type."""

    model_config = ConfigDict(extra="forbid")

    # datasetTypeId -> LoadedDataset
    loaded: dict[str, LoadedDataset] = Field(default_factory=dict)


# ── Response models ───────────────────────────────────────────────────────────


class DownloadFailure(BaseModel):
    """Per-parameter download failure."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    parameter_id: str = Field(alias="parameterId")
    reason: str = ""


class DownloadResult(BaseModel):
    """Outcome of a dataset download (write to variables)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    result: DownloadResultKind = "success"
    dataset_id: str = Field(default="", alias="datasetId")
    written: int = 0
    total: int = 0
    verified: bool = False
    failures: list[DownloadFailure] = Field(default_factory=list)
