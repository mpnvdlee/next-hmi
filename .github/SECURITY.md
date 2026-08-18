# Security Policy

## Supported versions

NEXT HMI ships from a single release line. Security fixes land on the latest
release; there are no maintained back-branches. Always run the most recent
release before reporting an issue.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Anything older | ❌ — upgrade first |

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** A public issue
containing a working exploit exposes every deployment until a fix ships.

Report privately through either channel:

1. **GitHub private vulnerability reporting** (preferred) — the
   **Report a vulnerability** button under this repository's **Security** tab.
   This opens a private advisory visible only to you and the maintainers.
2. **Email** — info@next-hmi.com. Mark the subject line **SECURITY** and do not
   include exploit details in an unencrypted attachment you would not want a
   general inbox to hold; the GitHub channel above is preferred for anything
   sensitive.

Please include:

- affected version and how it was installed (Docker, portable binary, source),
- steps to reproduce or a proof of concept,
- the impact you believe it has,
- any suggested remediation.

## Response

- **Acknowledgement** within 3 business days.
- **Initial assessment** (severity, whether it reproduces) within 7 days.
- Fix timelines follow the triage SLA in
  [docs/dev/operations/dependency-policy.md](../docs/dev/operations/dependency-policy.md):
  critical issues are patched within 7 days, high within 14.

We will keep you informed through the advisory, credit you in the release notes
unless you prefer to stay anonymous, and coordinate a disclosure date once a fix
is available.

## Deployment scope and threat model

NEXT HMI is an operator-technology (OT) tool that reads and **writes** to PLCs
over OPC-UA. Its security model assumes a trusted network. Before reporting,
check whether the behaviour is in scope:

- **Keep it on the OT/plant network, behind a VPN. Never expose the manager or
  a project instance directly to the public Internet.** The full network
  placement and threat model is documented in
  [docs/dev/operations/deploy.md](../docs/dev/operations/deploy.md#network-placement-and-threat-model).
- **Editor access is code execution.** Authoring custom widgets compiles TSX on
  the server and runs it in the browser — editor access is a privileged role by
  design, not a low-privilege one. See
  [docs/dev/reference/custom-widgets.md](../docs/dev/reference/custom-widgets.md#security-editor-access-is-code-execution).
- Misconfiguration explicitly warned against in the deployment docs (for
  example serving over plain HTTP on `0.0.0.0`, or setting
  `NEXTHMI_FORWARDED_ALLOW_IPS=*` on an untrusted network) is a deployment
  error, not a vulnerability in the software.
