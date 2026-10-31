# Shipping it on a machine

What to sort out before NEXT HMI leaves your building on a machine or panel PC you deliver to a customer. Running it in your own plant needs none of this.

## 1. Decide which build ships

| You ship | Build | What it asks of you |
|---|---|---|
| The official build, unmodified, with the product boot screen | Open-source | Pass the licence along and give your customer the source of that release — see [Does the AGPL ask anything of me?](licence.md#does-the-agpl-ask-anything-of-me) |
| A build you modified | Open-source | Give your customer the source of what you shipped, your changes included |
| Your own logo on the boot screen, a signed build, or no source obligation for you or your customer | Enterprise | One licence per installation, once — see [COMMERCIAL.md](../../COMMERCIAL.md) |

Your pages, themes, translations and custom widgets are yours in every row; [Your project content is yours](licence.md#your-project-content-is-yours) says why.

## 2. Pick hardware with a stable identity

Enterprise only. The enterprise build is activated with a key bound to the machine it runs on. A panel PC or industrial PC is the simple choice. A container or virtual machine works too once its identity is pinned: Docker on a Linux host with the host's network and machine-id, a VM with a static MAC address and activated after cloning.<!-- ee-only --> [In Docker or a virtual machine](../../enterprise/docs/user/licensing.md#in-docker-or-a-virtual-machine) has the steps.<!-- /ee-only -->

## 3. Activate on the commissioning bench

Enterprise only. Start the enterprise build; it opens on an activation screen. Press **Copy Device ID**, send it to licensing@next-hmi.com, and paste the key you get back. The key is checked when a project starts, never against one already serving screens, and a replacement after a hardware failure is free.<!-- ee-only --> [Licensing](../../enterprise/docs/user/licensing.md) covers the activation screen in full.<!-- /ee-only -->

## 4. Lock it down

- **Device-admin password.** It guards the Manager dashboard and the editor; keep it to the people who engineer the system. The live screens stay open to anyone who can reach the panel — see [How this relates to the device-admin password](users.md#how-this-relates-to-the-device-admin-password).
- **Usage reporting.** If your customer's network allows no outgoing connections, ship with `NEXTHMI_TELEMETRY=off` — see [Usage reporting](install.md#usage-reporting).
- **HTTPS.** Turn it on when the panel is reached over a network you do not control — see [HTTPS](install.md#https).
- **Start on boot.** The portable build runs in the foreground; wrap it in `launchd`, Task Scheduler or a systemd unit — see [Limitations](install.md#limitations). The offline Docker installer restarts the container with the host on its own — see [Docker](install.md#docker).

## 5. Hand it over

- **Export the project** from the Manager dashboard and keep a copy yourself — see [Managing projects](projects.md).
- **Leave the licence files in place.** `LICENSE`, `NOTICE` and the `lgpl/` directory travel inside every build; they are part of what lets your customer use it.
