import pytest
from core.exceptions import DatasourceValidationError
from opcua.client_pool import _resolve_security_path


@pytest.mark.parametrize("escape", [
    "../outside.pem",
    "../../etc/shadow",
    "/etc/shadow",
    "certs/../../outside.pem",
])
def test_a_path_leaving_the_project_is_refused(escape, live_project_root):
    """A cert path is a project-relative certs/... setting. Anything resolving
    outside would let the connection probe truncate a host file."""
    with pytest.raises(DatasourceValidationError):
        _resolve_security_path(escape)


def test_a_normal_project_relative_path_still_resolves(live_project_root):
    resolved = _resolve_security_path("certs/client-cert.pem")
    assert resolved.endswith("certs/client-cert.pem")
