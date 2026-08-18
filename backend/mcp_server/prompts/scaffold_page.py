"""Prompt: scaffold a new page from a brief description."""

from ..server import mcp_app


@mcp_app.prompt(
    name="scaffold_page",
    title="Scaffold a new page",
    description="Create a new page record with a starter widget tree from a short description.",
)
def scaffold_page(project: str, brief: str, layout: str = "single-column") -> str:
    return (
        f"You are scaffolding a new NEXT HMI page in project '{project}'.\n\n"
        f"Brief: {brief}\n"
        f"Layout hint: {layout}\n\n"
        "Steps:\n"
        f"1. Call `pages_create(project='{project}', ...)` with a descriptive "
        "title — the server assigns a page_id.\n"
        "2. Use the returned `page_id` for the remaining steps.\n"
        f"3. Call `widgets_get_schemas(project='{project}')` to confirm which "
        "widget types you'll use.\n"
        f"4. Add widgets via `pages_add_widget(project='{project}', ...)` against the new page.\n"
        f"5. Wire any variable bindings via `pages_set_widget_property(project="
        f"'{project}', ...)` with a `$var` source.\n"
        f"6. Call `pages_get(project='{project}', page_id=...)` to verify the final tree.\n"
    )
