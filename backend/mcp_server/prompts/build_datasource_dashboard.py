"""Prompt: build a dashboard page bound to a datasource's variables."""

from ..server import mcp_app


@mcp_app.prompt(
    name="build_datasource_dashboard",
    title="Build a datasource dashboard",
    description="Create a page that visualises the most important variables of a datasource.",
)
def build_datasource_dashboard(
    project: str, datasource: str, max_widgets: int = 12
) -> str:
    return (
        f"Build a dashboard page in project '{project}' bound to datasource "
        f"'{datasource}'.\n\n"
        "Steps:\n"
        f"1. Call `datasources_get(project='{project}', "
        f"name='{datasource}')` to see the variable tree.\n"
        f"2. Call `variables_list(project='{project}', datasource='{datasource}')`.\n"
        f"3. Pick up to {max_widgets} representative variables (mix of booleans, "
        "numeric values, and strings).\n"
        f"4. Call `pages_create(project='{project}', ...)` with a descriptive "
        "title — the server assigns a page_id; "
        "use the returned `page_id` for the next steps.\n"
        f"5. For each chosen variable, call `pages_add_widget(project='{project}', "
        "...)` with an appropriate widget type "
        "(e.g. Button for booleans with a `bValue` write field, ImageContainer for graphics).\n"
        "6. Bind each widget's `variable` struct or scalar property to `$var: { path: 'datasource:location' }`.\n"
        f"7. Call `pages_get(project='{project}', page_id=...)` to verify the layout.\n"
    )
