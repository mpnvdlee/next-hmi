# Vendor and Dependency Maintenance Policy

Implements maintenance-backlog item 23 / R55. Covers bundled vendor source
(files committed directly into this repo) and package-managed dependencies
(`backend/requirements.txt`, `frontend/package.json`).

## Vendored files

No third-party source is vendored directly into this public tree. The
dev/example libraries that used to be committed here — three.js and uPlot,
both MIT, used only by the example custom widgets — moved with
`project-testbench/` into a separate private dev/test-project repository, which
tracks their provenance and checksums there. The trial site's PHPMailer sources
moved with `promotion-website/` into the private enterprise repository. None are
part of this AGPL tree.

## Package-managed dependencies

`backend/requirements.txt` (pip) and `frontend/package.json` (npm) are covered
by automated scanning, not by this table — their versions are pinned in those
manifests directly.

## Scan, report, and review cadence

- **On-demand scan** — run locally; there is no scanning workflow in CI.
  `pip-audit -r backend/requirements.txt` for the backend, `npm audit` from
  `frontend/` for the frontend.
- **Monthly report** — whoever holds dependency-maintenance responsibility for
  the release runs both scans once a month, reviews the output, and records new
  findings, false positives, and open remediation.
- **Quarterly upgrade review** — package-managed dependencies are reviewed for
  available upgrades once a quarter, independent of whether a vulnerability was
  reported.
- **Triage SLA** — once a finding is confirmed (not a false positive):
  - **Critical** severity: triaged within 48 hours, patched within 7 days.
  - **High** severity: patched within 14 days, with integration coverage for
    the affected path (the relevant backend/frontend test suite for the
    affected dependency) before the fix is considered complete.
  - Lower severities are tracked at the next monthly report, not on the SLA
    clock.
- Vendor source is never reformatted, minified further, or refactored as part
  of ordinary application cleanup — only a version bump touches these files.
