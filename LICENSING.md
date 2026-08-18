# NEXT HMI — Licensing

Copyright (C) 2026 Mark van der Lee

## Source code

Every file in this repository is licensed under the GNU Affero General Public
License, version 3.0 (AGPL-3.0) — no carve-outs, no per-directory exceptions.
Full text: [LICENSE](LICENSE).

> This program is free software: you can redistribute it and/or modify it under
> the terms of the GNU Affero General Public License as published by the Free
> Software Foundation, either version 3 of the License, or (at your option) any
> later version.
>
> This program is distributed in the hope that it will be useful, but WITHOUT
> ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
> FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
> details.
>
> You should have received a copy of the GNU Affero General Public License along
> with this program. If not, see <https://www.gnu.org/licenses/>.

Two notes sit alongside the AGPL and do not modify it:

- Project content you author — pages, themes, translations, datasource
  configurations, custom widgets — is your own work, not a derivative of
  NEXT HMI. See [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md).
- Two dependencies, `asyncua` and `zeroconf`, are LGPL and ship as replaceable
  packages. See [NOTICE](NOTICE).

## Release binaries

The licence follows the artifact, not the buyer.

- **AGPL-3.0** — the public downloads `nexthmi-macos-arm64.zip`,
  `nexthmi-windows-x64.zip`, `nexthmi-docker-linux-<arch>.zip`. A per-unit
  commercial licensee gets this same byte-identical build under these same
  terms.
- **NEXT HMI Commercial License** — the `nexthmi-enterprise-<os>-<arch>` builds,
  which contain proprietary modules that are not in this repository. Its terms
  are not committed here, because nothing here is licensed under them; request
  them from <licensing@next-hmi.com>.

## Commercial licensing

The AGPL never requires payment. A commercial licence is the alternative to
complying with its source-disclosure terms — relevant to machine builders,
integrators, and SaaS vendors that redistribute or network-serve modified
builds. An enterprise module subscription is also available. See
[COMMERCIAL.md](COMMERCIAL.md) for who each option is for and how to buy.
