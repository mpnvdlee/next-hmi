# Connecting other systems (API v1)

API v1 lets another system talk to NEXT HMI over HTTP: a MES that reads recipes,
a BI tool that pulls historian data or alarm history, an HR system that keeps the
operator accounts up to date. It is a small, versioned API: the routes and field
names on this page stay the same for as long as v1 exists.

Every request names one project, by its id. The API works the same whether that
project is running or stopped, because it reads and writes the project's own
files. Nothing in it writes to the PLC.

## Giving a system access

There are two ways to sign a request.

**An API token (recommended).** A token is a long random string that unlocks
one project and only the parts you tick when you create it. Hand each system its
own token, so you can take one back without touching the others.

1. Open the project in the editor and pick **Admin** in the left rail.
2. In the **Tokens** section, click **Create token** and choose the kind **API**.
3. Give it a name you will recognise later (*HR system*, *Power BI*).
4. Tick the scopes the system needs, and nothing more (see the table below).
5. Click **Create token**, then copy the token. It is shown **once**: only a
   hash of it is stored, so a lost token cannot be recovered, only replaced.

![The Create token dialog with the kind set to API: a name field and one checkbox per scope, from reading historian samples to changing users.](images/admin-tokens-api.png)

The dialog also shows a ready-made `curl` command for the new token. The
**Tokens** section lists the project's tokens with **Revoke** on each.

**The device-admin password.** The password that unlocks the dashboard also
works, over HTTP Basic, with the username `admin`. It reaches every project and
every scope, so keep it for your own scripts and testing. After five wrong
passwords the API, and the dashboard sign-in, lock for a minute. A correct
password over the API does not wipe that count; a correct one entered anywhere
else (the dashboard sign-in, a password change, pairing an MCP client or another
machine), or the lock itself, starts it again.

A username and password from the project's *Users* list never works here.
Neither does an MCP token: those are for AI agents (see [AI agents over MCP](mcp.md)).

### Scopes

| Scope | Lets the system |
|---|---|
| `history:read` | Read historian samples |
| `alarms:read` | Read the alarm history, including who acknowledged each alarm |
| `recipes:read` | Read the recipe types and their saved datasets |
| `users:read` | Read the user list (never a password) |
| `users:write` | Create, change and delete users |

**`users:write` does not include `users:read`.** A token with only
`users:write` can create, change and delete users, but gets `403` when it asks
for the user list. A system that both reads and updates users, such as an HR
sync, needs both scopes ticked.

## Making a request

All addresses start with the dashboard's own address, then
`/api/v1/projects/<project id>/`. The project id is the name in the project's
URLs (`/runtime/<id>/`).

Send the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://hmi.local:8443/api/v1/projects/line-a/recipes"
```

Or the device-admin password, with `-u`:

```bash
curl -u "admin:$DEVICE_ADMIN_PASSWORD" \
  "https://hmi.local:8443/api/v1/projects/line-a/recipes"
```

What the answers mean:

| Status | Meaning |
|---|---|
| `200` | Done |
| `401` | No credential, a wrong one, or a revoked token |
| `403` | The token is for another project, or lacks the scope this route needs |
| `404` | No such project, or no such user |
| `409` | The project's `users.json` is damaged; repair it in the editor first |
| `422` | Something in the request is not valid; the `detail` field says what |
| `429` | Too many wrong passwords; wait a minute |

### Times

Wherever a request takes a time, write it as ISO-8601 (`2026-11-03T08:00:00`,
UTC when no offset is given), as `now`, or relative to now: `-30s`, `-15m`,
`-1h`, `-7d`. Every time in an answer is ISO-8601 in UTC, with its offset.

### Long lists come in pages

Historian samples and alarm history come in pages. An answer looks like this:

```json
{ "items": [ ... ], "nextCursor": "eyJrIjoi..." }
```

To get the next page, repeat the same request with `&cursor=<nextCursor>`. When
`nextCursor` is `null` you have everything that request asked for.

A cursor only walks one request's results; it is not a bookmark to come back to
later. To keep another system up to date, poll with `start` instead:

- **Historian samples** reach the database in batches, a second or two after
  they were measured. Set `start` a minute before the newest `timestamp` you
  already have, and drop the rows you already have (same `variable` and
  `timestamp`).
- **Alarm history**: set `start` to the newest `clearedAt` you already have, and
  drop the alarms whose `id` you already have.

Add `&format=csv` to get the page as a CSV file instead, ready for a
spreadsheet. The next cursor then comes in the `X-Next-Cursor` response header,
which is missing on the last page. A text that starts with `=`, `+`, `-` or `@`
gets a `'` in front, so the spreadsheet shows it instead of running it as a
formula.

## What you can read and change

### Historian samples

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://hmi.local:8443/api/v1/projects/line-a/history?variables=LinePLC:Tank/Level,LinePLC:Tank/Temp&start=-1h"
```

`variables` names one or more recorded variables, separated by commas, as
`<datasource>:<path>` — the same keys the [historian](historian.md) records. `start` is required; `end` is `now`
unless you give one. You get every recorded sample in that window, oldest first,
never thinned out: `{ "variable", "timestamp", "value" }`. A page holds up to
`1000` samples unless you set `limit`, which goes up to `10000`.

### Alarm history

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://hmi.local:8443/api/v1/projects/line-a/alarms/history?start=-7d&format=csv"
```

Each cleared alarm, oldest first by when it cleared, with its code, level,
title, when it came and went, and whether, when and by whom it was acknowledged
(`acked`, `ackedAt`, `ackedBy`). `start` and `end` select on the moment an
alarm cleared. An alarm that is still active is not in the history yet. The project keeps
the newest 500 cleared alarms. A page holds up to `100` unless you set `limit`,
which goes up to `500`.

### Recipes

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://hmi.local:8443/api/v1/projects/line-a/recipes"
```

Every recipe type with its parameters and saved datasets, and which dataset was
loaded last. Reading recipes never loads one to the machine.

### Users

List the users and the groups they can be in:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://hmi.local:8443/api/v1/projects/line-a/users"
```

Each user comes back as `{ "id", "username", "groups", "passwordSet" }`.

Create a user, or change one, with `PUT` and the user's id in the address:

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"username": "jdoe", "password": "a-long-password", "groups": ["operator"]}' \
  "https://hmi.local:8443/api/v1/projects/line-a/users/jdoe"
```

Send only what changes: a field you leave out keeps its current value, and
leaving out the password keeps the current password. A new user without a
password cannot sign in. The same rules as in the editor apply: ids and
usernames use letters, digits, `-` and `_`; every user needs at least one group
that exists; two users cannot share a username; and `guest` stays a password-less
member of the `guest` group only.

Remove a user:

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://hmi.local:8443/api/v1/projects/line-a/users/jdoe"
```

The `guest` user cannot be removed.

Every user created, changed or removed over the API is recorded in the audit
trail when the build has one, under the token's name (or `admin`), marked as
coming from the API. The record says whether the password changed, never the
password itself.

A change takes effect at once: the next sign-in on a panel uses the new list.
Someone already signed in on a panel stays signed in until they sign out. If
someone has the project open in the editor, the editor shows that another writer
changed it, so they reload before saving.

## Keeping it safe

- **Turn on HTTPS** (see [HTTPS](install.md#https)) before any system
  uses the API across a network. Over plain HTTP the token or password travels
  as readable text, and anyone on the network path can copy it. The API does not
  refuse plain HTTP, because many machines run on a closed LAN, but treat a
  token that has crossed an untrusted network that way as leaked.
- **One token per system, with the fewest scopes it needs.** A BI tool needs
  `history:read`, not `users:write`.
- **Store a token like a password**: in the other system's secret store, not in
  a script in a shared folder or in a ticket.
- **Revoke what you no longer use.** Tokens do not expire on their own. Revoke
  one from the **Tokens** list; changing the device-admin password revokes every
  token at once, MCP and API alike.
- A token with `users:write` can make anyone an operator or an admin. Give it
  only to a system you trust with that.
