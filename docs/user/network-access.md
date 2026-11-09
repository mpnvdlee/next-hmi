# What is reachable without a password

NEXT HMI has one password for the people who engineer the system, the
**device-admin password**, and none for the operator screens. This page lists
what someone who can reach the device on the network can see and do with no
password at all, what each credential adds on top, and how to place the device
so that is what you want.

## In short

- **Anyone who can reach the device can do everything a running project's
  screens can do.** They can see every live value, write every writable
  variable, load and save recipes and acknowledge alarms, whether or not
  anyone is signed in. Signing in on a screen changes what the screens show and
  who an action is recorded as. It does not change what the server accepts.
- **Everything else needs a credential**: the dashboard, the editor, the
  project's settings, users and tokens, the datasource settings, the API and
  the MCP endpoint.
- **So the network is the fence.** On an isolated machine network that is
  exactly what an operator panel needs. On a network shared with office PCs,
  laptops or visitors, every device on it gets the operator's reach.

## When it matters

| The device sits on | What that means |
|---|---|
| An isolated OT or machine network: the panels, the PLCs, an engineering PC | The open screens are what you want. Nothing else can reach them. |
| A plant or office network shared with other PCs, laptops or Wi-Fi | Every device on that network can write setpoints the way a panel can. Give the HMI its own network segment (see [Network advice](#network-advice)). |
| The public Internet | Never. Use a VPN for remote access. |

## Open to anyone who can reach the device

### A running project's screens

Everything under `/runtime/<project>/`, while that project runs:

| What | Someone can |
|---|---|
| Pages, dialogs, components, themes, texts and translations | Read the complete screen design, including which variable each widget shows or writes. |
| The project's `assets`, `custom-widgets` and `external-libraries` folders | Download any file in them, the source of your custom widgets included. Keep nothing secret there. |
| The live connection | See the list of the project's enabled variables, their live values, the active alarms and the recipes with their saved values. A tag browsed but not enabled is never read. |
| Variables | Write every enabled variable marked writable in its datasource, and switch a Boolean. A read-only or disabled variable is refused for everyone. See [What the server enforces](users.md#what-the-server-enforces). |
| Recipes | Load a saved recipe to the PLC, or save the live values over a recipe. |
| Alarms | Acknowledge active alarms, and read the alarm history, including who acknowledged each alarm. |
| Historian | Read the recorded history of every variable the historian logs. |
| Users | Read the usernames and the group names, not who is in which group, and not whether an account has a password. Sign in with a username and its password; five wrong passwords lock that username for a minute. |
| HTTP sources (`$http`) | Have the device send any `GET` or `POST` request, with any path, headers and body, to a server that the project's HTTP sources name or that is on the project's list under **Admin › HTTP sources**. Whatever such a server lets you change, anyone who reaches the panel can change through the device, so list only servers whose every endpoint you would open to the panel. See [Which servers a URL can reach](properties.md#which-servers-a-url-can-reach). |
| Device info | Learn the address the device sees them connect from, and that address's host name and network-card address when the device can look them up. It only ever looks up the caller's own address. |

**Anyone who can reach the panel can write the writable variables.** There is
no per-variable list of who may write. To stop someone changing a value, block
or hide the button that writes it for their group (see
[Gate what a group can see and do](users.md#gate-what-a-group-can-see-and-do)),
and mark a variable read-only in its datasource when no screen needs to write
it. A blocked button stops the person at the panel, not a script on the
network.

**A sign-in sent to a panel name goes to whoever opens that name.** When another
system signs an operator in on a named panel over the API, every screen opened
with that `?panel=<name>` receives the sign-in. The name proves nothing about
which screen it is. See [Panels: sign users in and out](api.md#panels-sign-users-in-and-out).

### The manager

The manager is the device's front door, at the address without
`/runtime/…`. With no password, someone can:

- open the sign-in page, the user guide at `/help`, and the health check at
  `/api/health`;
- open the default project's screens: the bare address goes there when a
  default project is set and running;
- see whether a device-admin password has been set;
- try the device-admin password: on the sign-in page, when pairing an MCP
  client or another NEXT HMI device, or over the API. Five wrong passwords
  lock all of them for a minute;
- see that the device exists: it announces itself on the local network so
  other NEXT HMI devices can find it for a project transfer.

> [!IMPORTANT]
> **On a new install, whoever enters the setup code first sets the device-admin
> password.** The device prints the code in its console and its log until a
> password is set, so anyone who can read either can claim the install. See
> [Installing](install.md#installing).

## What needs a credential

| Credential | Opens |
|---|---|
| **Device-admin password**, signed in on the dashboard | The dashboard, every project's editor and Test mode, the editor's Admin area with its HTTP sources, the Settings page with its tokens, and the [MCP endpoint](mcp.md) for every project from that browser. Values written from the editor are recorded as `engineer`. |
| **Device-admin password** over HTTP Basic | [API v1](api.md) on every project, with every scope. |
| **API token** | [API v1](api.md) on every project, limited to the scopes ticked when it was created. Created under **Settings › Tokens** on the dashboard. |
| **MCP token** | The [MCP endpoint](mcp.md) on every project, to read, or to read and write (writes only where **MCP write enabled** is ticked). Created under **Settings › Tokens** on the dashboard. |
| **Peer token** | Sending and fetching projects between two NEXT HMI devices, after one pairing with the other device's device-admin password. See [Managing projects](install.md#managing-projects). |
| **A project user's password** | Signing in on that project's screens. It changes what the screens show and who actions are recorded as. It never opens the editor or the API. See [Users, groups & permissions](users.md). |

## What protects the open part

- **Other websites cannot use it.** A web page from another site, open in a
  browser on the panel or on a laptop on the same network, cannot connect to
  the live screens or send them changes: the device refuses a browser request
  whose page did not come from the device itself. Nor can it show the screens
  inside a frame of its own, where a disguised button could trick someone into
  a click that writes a setpoint: only the device itself and the sites you list
  may do that (see [Showing NEXT HMI inside another
  site](#showing-next-hmi-inside-another-site)).
- **That check stops websites, not scripts.** A program on the network (curl,
  a Python script, a PLC tool) sends no page address, and gets the same reach
  as a panel.
- **DNS rebinding gets past the check.** A website that points a name of its
  own at the device's address looks to the device like the device itself. It
  still reaches only the open part: the browser does not send the dashboard
  sign-in to that name, and the projects running behind the device answer
  only the device itself, never a name. On a new install it cannot set the
  device-admin password either: that takes the setup code, which only the
  device's console and log show.
- **Files in the project folders run no script.** An HTML or SVG file in
  `assets` or `custom-widgets`, opened at its own address, shows as a plain
  document, so a file someone put there cannot act with your dashboard
  sign-in. Custom widgets and external libraries are code the screens run on
  purpose and are not limited this way.
- **Sign-ins are throttled**, per username and per address on the screens
  (see [Users](users.md#add-users-and-groups)), and for the device-admin
  password and the setup code everywhere.
- **The open part takes at most 1 MB per request.** The device refuses a
  larger request before reading it, so no amount of data sent its way can
  exhaust the device's memory and take the screens down. An HTTP source whose
  request is over that is not sent, and the screen says so.
- **A project serves at most 500 open screens at once.** One more is turned
  away and its browser tries again every 10 seconds, so no flood of
  connections can wear down the device or the PLC behind it. The editor is
  never turned away.

## Showing NEXT HMI inside another site

By default only the device itself can show its pages in a frame; another site
that tries gets an empty frame. When a plant portal or another web page must
show NEXT HMI inside its own page, add it under **Settings › Sites that may
embed NEXT HMI** on the dashboard, as the address the portal is opened at:
scheme, host and, when it is not the default, port, such as
`https://portal.example.com` or `http://10.0.0.20:8080`. A path, a wildcard or
anything else is refused. The change applies the next time the page loads; no
restart.

Up to **32 sites** can be listed. Every page of the device carries the list,
and one long enough would make browsers refuse to load any page, so saving a
longer list is refused with a message saying how many it has; in a file edited
by hand, the sites past the 32nd are ignored.

Embedding is meant for the runtime screens, at `/runtime/<project>/`. The
dashboard and the editor do not work inside another site's frame: the browser
does not send their sign-in cookie to a page framed by a different site, so
they cannot stay signed in there. Open them directly, at the device's own
address.

A listed site can frame every page of the device, the screens of every project
included, so list only sites you control: whoever controls one can lay a
disguised page over your screens.

## Network advice

- **Give the HMI its own network segment** (a VLAN) and let the firewall pass
  only the panels and the engineering PCs to its ports (`8000`, and `8443`
  with HTTPS on).
- **Turn on [HTTPS](install.md#https)** wherever the network is not yours.
  Over plain HTTP the device-admin password, every operator sign-in and every
  token cross the network as readable text.
- **Never put the device on the public Internet.** Reach it from outside
  through a VPN.
- **Behind a reverse proxy**, pass the browser's `Host` header through with its
  port and send `X-Forwarded-Proto`, or the device refuses every change and
  every live connection. A proxy on another host must also be listed in
  `NEXTHMI_FORWARDED_ALLOW_IPS`. See
  [Behind a terminating proxy](install.md#behind-a-terminating-proxy).
- The full threat model is in [Network placement and threat
  model](../dev/operations/deploy.md#network-placement-and-threat-model).
