"""Prompt: seed alarm definitions from a datasource's boolean variables."""

from ..server import mcp_app


@mcp_app.prompt(
    name="seed_alarms_from_datasource",
    title="Seed alarms from a datasource",
    description=(
        "Walk a datasource's boolean variables and create alarm definitions "
        "for each one that names a fault condition."
    ),
)
def seed_alarms_from_datasource(
    project: str, datasource: str, group_title: str = "Auto-seeded"
) -> str:
    return (
        f"Seed alarms in project '{project}' from datasource '{datasource}'.\n\n"
        "Steps:\n"
        f"1. Call `datasources_get(project='{project}', name='{datasource}')` "
        "to see the variable tree.\n"
        "2. Filter to variables whose `data_type` is `boolean` and whose path suggests a fault "
        "(`/alarm`, `/fault`, `/trip`, `Err`, etc.).\n"
        f"3. Call `alarms_get_config(project='{project}')` to see existing groups.\n"
        f"4. Pick the `group_id` of an existing group titled '{group_title}' (or any other "
        "appropriate group). Group creation is **not** exposed over MCP — if no suitable group "
        "exists, ask the user to add one in the UI editor before continuing.\n"
        f"5. For each chosen variable, call `alarms_add(project='{project}', ...)` "
        "with `group_id`, a human-readable title, "
        "and a `trigger: { type: 'bool', source_value: { '$var': { path: 'datasource:location' } }, on_true: true }`.\n"
        f"6. Call `alarms_get_config(project='{project}')` again to verify.\n"
    )
