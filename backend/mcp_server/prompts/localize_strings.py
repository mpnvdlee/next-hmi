"""Prompt: extract static strings on a page into a dictionary."""

from ..server import mcp_app


@mcp_app.prompt(
    name="localize_strings",
    title="Localize a page's strings",
    description=(
        "Extract static strings on a page into a translation dictionary and "
        "rewrite the page to use $loc bindings."
    ),
)
def localize_strings(
    project: str, page_id: str, dict_name: str = "Default"
) -> str:
    return (
        f"Localize strings on page '{page_id}' in project '{project}' into "
        f"dictionary '{dict_name}'.\n\n"
        "Steps:\n"
        f"1. Call `pages_get(project='{project}', page_id='{page_id}')` and "
        "identify properties whose value is a static string "
        "literal or `$static` source containing a translatable phrase.\n"
        f"2. Call `translations_get(project='{project}', dict_name='{dict_name}')` "
        "to see which keys already exist.\n"
        f"3. For each new string, call `translations_add_key(project='{project}', "
        "...)` with a descriptive key, then "
        f"`translations_set_cell(project='{project}', ...)` for each language "
        "column you can populate.\n"
        f"4. Rewrite the page property via `pages_set_widget_property(project="
        f"'{project}', ...)` with `{{ \"$loc\": \"<key>\" }}` "
        "(the payload is the translation key as a plain string — not a nested object).\n"
        f"5. Call `pages_get(project='{project}', page_id='{page_id}')` again to "
        "verify all properties resolve.\n"
    )
