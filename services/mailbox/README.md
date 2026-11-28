# Mailbox server

Store-and-forward sync for devices that are never online at the same time: it holds sealed
changes and files only until every device in the group has them, then deletes them. The design
is [../../docs/mailbox-service.md](../../docs/mailbox-service.md); the server reads nothing it
stores, and every request is signed by a device in the group.

Licensed AGPL-3.0-only (see [LICENSE](LICENSE)), unlike the rest of the repository
(GPL-3.0-only): anyone who runs a modified mailbox for others must offer them its source.

## Run it

Node 24 runs the TypeScript directly; there is no build step.

```sh
pnpm install
pnpm --filter bramble-mailbox-server start     # http://localhost:7401
```

`GET /health` answers `ok`. Everything else is under `/v1` and needs a signed request from the
app.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7401` | Port to listen on (the signalling relay uses 7400). |
| `DATA_DIR` | `./data` | Where `mailbox.db` and the `bodies/` directory live. Back it up or not: everything in it is in transit, and the apps hold the real copies. |
| `MAILBOX_TOKEN` | unset | When set (at least 16 of `A-Z a-z 0-9 _ -`), every `/v1` request must carry it, which makes the mailbox private to whoever has the token. `/health` stays open. |
| `MAILBOX_TOKEN_FILE` | unset | A file holding `MAILBOX_TOKEN` instead (one final newline is ignored), so the token stays out of the environment and the service file. Set one or the other, not both. Read once at start: restart to change it. |
| `RETENTION_MAX_DAYS` | `365` | The longest anything is held for a device that never collects it. Clients can ask for less, never more. |
| `QUOTA_BYTES` | unset | The most one mailbox may hold at once. Unset means no limit. |

An invalid value stops the server before it listens, naming the variable (never its value).
The server logs its listening line and errors only: no requests, no addresses. An unexpected
error is logged as the database's own message, never with the request.

With systemd, keep the token itself out of `Environment=` lines: NixOS, for one, writes unit
files to the world-readable Nix store. Point `MAILBOX_TOKEN_FILE` at a file only the service's
user can read, as sops-nix and agenix make with their owner set:

```ini
[Service]
Environment=MAILBOX_TOKEN_FILE=/run/secrets/mailbox-token
```

Or, on systemd 248 or later, let systemd hand over a file only root can read:

```ini
[Service]
LoadCredential=mailbox-token:/etc/bramble/mailbox-token
Environment=MAILBOX_TOKEN_FILE=/run/credentials/bramble-mailbox.service/mailbox-token
```

Write the path out with your unit's name rather than `%d`. A systemd older than 248 ignores both
`LoadCredential=` and `%d`, and the mailbox would start with no token at all; with the path
written out, it finds no file and refuses to start.

### Docker

The image is built from the repository root, because the server shares the sync protocol with the
apps:

```sh
docker build -f services/mailbox/Dockerfile -t bramble-mailbox .
docker run -d -p 7401:7401 -v bramble-mailbox:/data bramble-mailbox
```

It needs BuildKit, Docker's default builder: the legacy one ignores `Dockerfile.dockerignore` and
sends the whole repository. The server runs as the unprivileged `node` user, uid 1000, with
`DATA_DIR=/data`, and reports its health from `/health`. A named volume gets the right owner by
itself; a bind-mounted data directory must be writable by uid 1000 (`chown 1000:1000`), or the
server stops at start with "Can't write to DATA_DIR".

For a private mailbox, mount the token as a file, as Docker and Compose secrets do. Compose mounts
a file secret with its owner and mode from the host, so the file must be readable by uid 1000 too,
or the server stops with "Unreadable MAILBOX_TOKEN_FILE (EACCES)":

```yaml
services:
  mailbox:
    image: bramble-mailbox
    ports: ["7401:7401"]
    volumes: ["mailbox:/data"]
    environment:
      MAILBOX_TOKEN_FILE: /run/secrets/mailbox_token
    secrets: [mailbox_token]
secrets:
  mailbox_token:
    file: ./mailbox_token.txt
volumes:
  mailbox:
```

For devices off your network, put it behind a TLS reverse proxy and give the app
`https://<host>`. The token goes in the app's mailbox settings, never in the URL, so it cannot end
up in a proxy's access log.

## Hosted (Cloudflare)

The hosted mailbox is the same app as a Worker (`src/worker`): D1 holds the metadata, R2 every
body, a cron runs the retention sweep hourly, and accounts decide who may post. Billing is a
separate, closed-source Worker that reaches accounts only through the `Accounts` RPC entrypoint
(`AccountsRpc` in `src/worker/rpc.ts`), so this one never sees payment data. Its suite runs in
workerd against local D1 and R2:

```sh
pnpm --filter bramble-mailbox-server test     # the Node suite, then the Worker's
```

To deploy it, once, from `services/mailbox`:

Both stores go in the EU jurisdiction (the owner's decision), which can't be changed once they
exist: Worker code still runs near each user, but the data rests in the EU.

1. `pnpm exec wrangler d1 create bramble-mailbox --jurisdiction eu`, and put the id it prints in `wrangler.jsonc`
   (`d1_databases[0].database_id`).
2. `pnpm exec wrangler r2 bucket create bramble-mailbox-bodies --jurisdiction eu` (the binding in
   `wrangler.jsonc` already names the jurisdiction).
3. `pnpm exec wrangler d1 migrations apply bramble-mailbox --remote` (the `drizzle/` folder).
4. Put `{"ACCOUNT_KEY": "<the output of openssl rand -base64 32>"}` in a private file. Keep a copy
   somewhere safe: losing it makes every stored account number unresolvable.
5. `pnpm exec wrangler deploy --secrets-file <that file>`, then check `GET /health` answers `ok`.
   `wrangler.jsonc` serves it at `mailbox.bramble.sh`, the address the apps and the website use
   (bramble.sh's DNS must be on the same Cloudflare account). Hosted anywhere else, point that name
   at it instead; no app needs an update.

After a schema change, run step 3 again before deploying. The rate limits and the quota are in
`wrangler.jsonc`. Workers Logs is on without invocation logs, and traces are off, because both
would record URLs that hold mailbox ids.

Deploying it alone sells nothing: accounts are opened and paid for through the billing Worker and
the website's account page (`website/src/pages/account`). Without them a hosted mailbox can be
created only on an account opened by hand through the RPC.

### The sandbox

A second mailbox, `bramble-mailbox-sandbox` at `mailbox-sandbox.bramble.sh`, is for testing
against the Stripe sandbox: its own D1 database, R2 bucket (both EU) and `ACCOUNT_KEY`, so nothing
bought with a test card reaches a real account. It is the `sandbox` environment in
`wrangler.jsonc`, deployed with `--env sandbox` on every command (`d1 migrations apply
bramble-mailbox-sandbox --remote --env sandbox`, `deploy --env sandbox`); a plain deploy is the
hosted mailbox. Its billing is the sandbox billing Worker, which credits this mailbox only.

To use it, deploy the website's sandbox build with `pnpm --filter website deploy:sandbox` (the
account page at `https://sandbox.bramble-website-chc.pages.dev`, against both sandbox Workers; or
run it locally with `dev:sandbox`) and build an app with `--mode sandbox` (for
example `pnpm --filter @vault/platform-extension exec vite build --mode sandbox`, or
`vite --mode sandbox` for the mobile and desktop dev servers): its hosted mailbox and account page
are then the sandbox's. A release build can't reach either address.
