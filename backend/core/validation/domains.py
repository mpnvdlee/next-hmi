"""Cross-reference validation for the config domains outside the page tree.

Pydantic already rejects a structurally broken ``alarms.json`` / ``recipes.json``
/ ``users.json`` when the services load it. What it cannot see is whether the
things those files *point at* still exist: a ``$var`` binding whose variable was
deleted, a ``$loc`` key that was renamed, an ack group that no longer exists.
Those are exactly the build diagnostics the editor surfaces, so they are checked
here with the same helpers the widget walk uses.

Every finding rides in ``report.warnings`` (blocking or not is the write API's
call, and these never block a save) and carries a catalog ``code``.
"""

from __future__ import annotations

from typing import Any, get_args

from models.recipe import RecipeDataType

from .report import ValidationReport
from .structure import ValidationContext, validate_property_value, validate_var_ref

_STRING_FIELD = {"type": "string"}

_ALARM_LEVELS = ("error", "warning", "info")
_ALARM_TRIGGER_TYPES = ("value_range", "bool")
# Localizable prose on an alarm — plain strings, `$static` or `$loc` keys.
_ALARM_TEXT_FIELDS = ("title", "description", "image")

# Straight from the model so the two can't drift — the editor infers `datetime`
# and the `[]` variants too (see `RecipeTable/paramBinding.ts`).
_RECIPE_DATA_TYPES = get_args(RecipeDataType)

# Every sample is stored as a REAL, so only variables that coerce to a number
# can be logged (see `historian_manager.on_variable_change`).
_HISTORIAN_FIELD = {"type": ["Integer", "Float", "Boolean"]}


def _dicts(value: Any) -> list[dict]:
    """The dict entries of a list, ignoring anything else — a hand-edited file
    can hold junk, and that is the loader's problem to report, not ours."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _element_index(composite: str) -> int | None:
    """The `[N]` index a historian key ends with, or None when it names a whole
    variable."""
    if not composite.endswith("]"):
        return None
    start = composite.rfind("[")
    if start < 0:
        return None
    try:
        return int(composite[start + 1 : -1])
    except ValueError:
        return None


def _check_groups(
    groups: Any,
    ctx: ValidationContext,
    path: str,
    report: ValidationReport,
    subject: str,
    groups_known: bool = False,
) -> None:
    """Every entry of a user-group id list must name a group in users.json.

    An empty ``ctx.user_groups`` is ambiguous: users.json may genuinely define
    no groups, or it may simply not have been loaded into this context. Callers
    that built the set themselves pass ``groups_known=True`` so the empty case
    still reports; the rest skip rather than flag every membership.
    """
    if not isinstance(groups, list):
        return
    if not ctx.user_groups and not groups_known:
        return
    for i, group in enumerate(groups):
        if isinstance(group, str) and group and group not in ctx.user_groups:
            report.warn(
                f"{path}/{i}",
                f"{subject} references unknown user group '{group}'",
                severity="error",
                code="user-group-unknown",
            )


def validate_alarms(alarms: Any, ctx: ValidationContext) -> ValidationReport:
    """Alarm definitions: trigger bindings, localizable text, level/type enums
    and acknowledgement groups."""
    report = ValidationReport()
    if not isinstance(alarms, dict):
        return report
    for gi, group in enumerate(_dicts(alarms.get("groups"))):
        for ai, alarm in enumerate(_dicts(group.get("alarms"))):
            base = f"/groups/{gi}/alarms/{ai}"

            level = alarm.get("level")
            if level is not None and level not in _ALARM_LEVELS:
                report.warn(
                    f"{base}/level",
                    f"unknown alarm level '{level}' — expected one of {', '.join(_ALARM_LEVELS)}",
                    severity="error",
                    code="alarm-level-unknown",
                )

            for field_name in _ALARM_TEXT_FIELDS:
                if field_name in alarm:
                    validate_property_value(
                        alarm[field_name], _STRING_FIELD, ctx, f"{base}/{field_name}", report
                    )
            for ri, resolution in enumerate(alarm.get("resolutions") or []):
                validate_property_value(
                    resolution, _STRING_FIELD, ctx, f"{base}/resolutions/{ri}", report
                )

            _check_groups(alarm.get("ack_groups"), ctx, f"{base}/ack_groups", report, "alarm")

            trigger = alarm.get("trigger")
            if not isinstance(trigger, dict):
                continue
            trigger_type = trigger.get("type")
            if trigger_type is not None and trigger_type not in _ALARM_TRIGGER_TYPES:
                report.warn(
                    f"{base}/trigger/type",
                    f"unknown trigger type '{trigger_type}' — expected one of "
                    f"{', '.join(_ALARM_TRIGGER_TYPES)}",
                    severity="error",
                    code="alarm-trigger-type-unknown",
                )
            source_value = trigger.get("source_value")
            if source_value is None or source_value == "":
                report.warn(
                    f"{base}/trigger/source_value",
                    "alarm has no variable to watch",
                    severity="warning",
                    code="alarm-trigger-unbound",
                )
            else:
                validate_property_value(
                    source_value, None, ctx, f"{base}/trigger/source_value", report
                )
            # Thresholds accept a plain number, `$static` or a `$var` — the
            # float schema type-checks the literal and filters the binding.
            for bound in ("min", "max"):
                if trigger.get(bound) is not None:
                    validate_property_value(
                        trigger[bound], {"type": "float"}, ctx, f"{base}/trigger/{bound}", report
                    )
    return report


def validate_recipes(recipes: Any, ctx: ValidationContext) -> ValidationReport:
    """Recipe dataset types: each parameter's write-back binding and data type."""
    report = ValidationReport()
    if not isinstance(recipes, dict):
        return report
    for ti, dataset_type in enumerate(_dicts(recipes.get("datasetTypes"))):
        for pi, parameter in enumerate(_dicts(dataset_type.get("parameters"))):
            base = f"/datasetTypes/{ti}/parameters/{pi}"
            data_type = parameter.get("dataType")
            if data_type is not None and data_type not in _RECIPE_DATA_TYPES:
                report.warn(
                    f"{base}/dataType",
                    f"unknown parameter type '{data_type}' — expected one of "
                    f"{', '.join(_RECIPE_DATA_TYPES)}",
                    severity="error",
                    code="recipe-data-type-unknown",
                )
            binding = parameter.get("binding")
            if binding is None:
                report.warn(
                    f"{base}/binding",
                    "recipe parameter is not bound to a variable",
                    severity="warning",
                    code="recipe-parameter-unbound",
                )
                continue
            # A parameter writes to its variable, so the declared dataType is
            # also the binding filter — an unknown one falls back to no filter.
            schema = {"type": data_type} if data_type in _RECIPE_DATA_TYPES else None
            validate_property_value(binding, schema, ctx, f"{base}/binding", report)
    return report


def validate_historian(config: Any, ctx: ValidationContext) -> ValidationReport:
    """Logged variables. Keys are ``datasource:path`` composites rather than
    `$var` objects, so they are checked through the same resolver by wrapping
    them back into one."""
    report = ValidationReport()
    if not isinstance(config, dict):
        return report
    variables = config.get("variables")
    if not isinstance(variables, dict):
        return report
    for composite, settings in variables.items():
        if not isinstance(composite, str):
            continue
        path = f"/variables/{composite.replace('~', '~0').replace('/', '~1')}"
        ref: dict[str, Any] = {"path": composite}
        # An element key (`ds:Tags[2]`) resolves to its array's type, so it needs
        # the same index hint a `$var` binding carries or the type check would
        # compare a scalar slot against the whole array.
        index = _element_index(composite)
        if index is not None:
            ref["index"] = index
        validate_var_ref(ref, ctx, path, report, _HISTORIAN_FIELD)
        if not isinstance(settings, dict):
            continue
        for key in ("minInterval", "retention"):
            value = settings.get(key)
            if value is not None and (not isinstance(value, (int, float)) or value < 0):
                report.warn(
                    f"{path}/{key}",
                    f"{key} must be a non-negative number",
                    severity="error",
                    code="historian-setting-invalid",
                )
    return report


def validate_users(users: Any, ctx: ValidationContext) -> ValidationReport:
    """Group membership and the settings that name a user or group.

    Checked against the file's own ``groups`` list rather than ``ctx`` — this
    validator *is* what defines that list, so reading it from the context would
    make every finding vacuously true.
    """
    report = ValidationReport()
    if not isinstance(users, dict):
        return report
    known_groups = {
        g["id"]
        for g in _dicts(users.get("groups"))
        if isinstance(g.get("id"), str) and g["id"]
    }
    local = ValidationContext(widget_schemas={}, user_groups=frozenset(known_groups))

    usernames = set()
    for ui, user in enumerate(_dicts(users.get("users"))):
        _check_groups(
            user.get("groups"), local, f"/users/{ui}/groups", report, "user", groups_known=True
        )
        name = user.get("username")
        if isinstance(name, str) and name:
            if name in usernames:
                report.warn(
                    f"/users/{ui}/username",
                    f"duplicate username '{name}' — only one of them can ever sign in",
                    severity="error",
                    code="user-duplicate",
                )
            usernames.add(name)

    settings = users.get("settings")
    if not isinstance(settings, dict):
        return report
    _check_groups(
        settings.get("configAccessGroups"),
        local,
        "/settings/configAccessGroups",
        report,
        "config access",
        groups_known=True,
    )
    auto_login = settings.get("autoLoginName")
    if isinstance(auto_login, str) and auto_login and auto_login not in usernames:
        report.warn(
            "/settings/autoLoginName",
            f"auto-login user '{auto_login}' does not exist",
            severity="error",
            code="user-unknown",
        )
    return report
