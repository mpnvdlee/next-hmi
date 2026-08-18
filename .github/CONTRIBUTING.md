# Contributing to NEXT HMI

Bug fixes, features, docs, and issue reports are all welcome. Participation is
governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Issues, discussions, and feedback need no agreement of any kind. Code needs one
extra step — a sign-off.

## Sign off your commits

```bash
git commit -s        # appends: Signed-off-by: Your Name <you@example.com>
```

That line means you agree to the [Contributor License Agreement](CLA.md), once,
for this and every future contribution. Nothing to email, nothing to paste into
the pull request.

Every commit needs it, and CI checks each one, so a pull request with an
unsigned commit fails. Forgot on commits you already pushed? Add the trailer to
all of them with `git rebase --signoff <base>` and force-push.

In short: you keep the copyright in your work and can still use it anywhere
else; NEXT HMI gets the right to ship it under both AGPL-3.0 and a commercial
licence. That dual licence is why the CLA exists.

Contributing on behalf of a company? An authorised signatory emails a completed
[CLA-ENTITY.md](CLA-ENTITY.md) to <licensing@next-hmi.com> once, then employees just
sign off as above.

**Code you did not write yourself** — vendored files, snippets from a blog or
another project, generated output — must be named in the pull request with its
source and licence, and kept in its own file or block. It has to be compatible
with AGPL-3.0 *and* commercial redistribution: MIT, BSD, and Apache-2.0 are
usually fine, copyleft usually is not. Ask in the pull request if unsure.

## Setup

Requires **Python 3.14** (>=3.14.2, <3.15) and **Node 22+**.

```bash
git clone https://github.com/mpnvdlee/next-hmi.git
cd next-hmi

python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd frontend && npm install && cd ..

python start-dev.py            # stop with: python start-dev.py --stop
```

Backend <http://localhost:8000>, frontend <http://localhost:5173>.
Architecture and deployment: [docs/dev/INDEX.md](../docs/dev/INDEX.md).

## Checks

CI runs these on your pull request; running them locally is the fast way to find
a failure.

```bash
# repo root, venv active
pytest backend/tests
ruff check backend

# from frontend/
npm test
npm run lint
npm run format:check
npm run build            # also type-checks
```

## Conventions

- Keep diffs small and scoped — no refactoring adjacent code unless the change
  needs it.
- Comments explain a non-obvious *why*; identifiers carry the *what*.
- Prefer editing existing files. No new docs (`*.md`) unless the change needs
  them.
- Match the surrounding code's naming and idiom.
- Cover new behaviour with tests.

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/) —
`type(scope): summary`, imperative. Types in use: `feat`, `fix`, `refactor`,
`docs`, `perf`, `chore`, `ci`. Scope is the area touched (`opcua`, `hmi`,
`deps`, …). Put the *why* in the body when the subject doesn't carry it.

```
feat(opcua): reconnect the client pool on transport drop
fix(hmi): clamp gauge value to the configured range
```

## Issues and security

Bugs and features: [GitHub issues](https://github.com/mpnvdlee/next-hmi/issues).
For bugs include version, OS, install method, and PLC/OPC-UA vendor.

Vulnerabilities: never a public issue — follow [SECURITY.md](SECURITY.md).
