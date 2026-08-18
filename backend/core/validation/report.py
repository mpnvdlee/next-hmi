from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field


@dataclass
class ValidationFinding:
    path: str
    message: str
    # 'error' | 'warning'. Only meaningful for entries in `warnings` — build
    # diagnostics render red (error) or orange (warning) from this field.
    # Entries in `findings` are always blocking regardless of this value.
    severity: str = "warning"
    # Catalog code (e.g. 'var-unknown', 'if-condition-empty') — the contract
    # consumers key off of; `message` is human-readable prose only.
    code: str = ""


@dataclass
class ValidationReport:
    findings: list[ValidationFinding] = field(default_factory=list)
    warnings: list[ValidationFinding] = field(default_factory=list)

    def add(self, path: str, message: str) -> None:
        """Blocking structural failure — rejects the write with a 422."""
        self.findings.append(ValidationFinding(path=path, message=message, severity="error"))

    def warn(self, path: str, message: str, *, severity: str = "warning", code: str = "") -> None:
        """Non-blocking build diagnostic — `severity` is 'error' or 'warning'.

        Even a 'error'-severity catalog code (e.g. var-unknown) rides here, not
        in `findings` — it never blocks a save, only marks the property red.
        """
        self.warnings.append(
            ValidationFinding(path=path, message=message, severity=severity, code=code)
        )

    def extend(self, other: ValidationReport) -> None:
        self.findings.extend(other.findings)
        self.warnings.extend(other.warnings)

    @property
    def ok(self) -> bool:
        return not self.findings

    def to_dict(self) -> dict:
        return {
            "findings": [
                {"path": f.path, "message": f.message, "severity": f.severity, "code": f.code}
                for f in self.findings
            ],
            "warnings": [
                {"path": w.path, "message": w.message, "severity": w.severity, "code": w.code}
                for w in self.warnings
            ],
        }

    def to_message(self) -> str:
        """One-line aggregated message — used as the detail on raised 422s.

        Only errors contribute to the head message (warnings don't block a
        write), but the warning count is appended so callers can see at a
        glance that non-blocking issues exist.
        """
        warn_suffix = f" [{len(self.warnings)} warning(s)]" if self.warnings else ""
        if not self.findings:
            return f"ok{warn_suffix}"
        head = self.findings[0]
        if len(self.findings) == 1:
            return f"{head.path}: {head.message}{warn_suffix}"
        extra = len(self.findings) - 1
        return f"{head.path}: {head.message} (+{extra} more){warn_suffix}"

    def __iter__(self) -> Iterable[ValidationFinding]:
        return iter(self.findings)

    def __len__(self) -> int:
        return len(self.findings)
