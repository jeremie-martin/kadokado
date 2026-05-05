# Single Node VPS Notes

One Node process can serve the built frontend, leaderboard API, and SQLite
database.

## Run

```sh
npm ci
npm run build
NODE_ENV=production \
PORT=8787 \
LEADERBOARD_DB_PATH=/var/lib/motiontwin/leaderboard.sqlite \
IP_HASH_SECRET='<long random secret>' \
npm start
```

- `PORT`: HTTP port for the Node server. Defaults to `8787`.
- `LEADERBOARD_DB_PATH`: SQLite path. Defaults to `.data/leaderboard.sqlite`.
- `IP_HASH_SECRET`: strongly recommended in production. Unset, the server logs a
  warning and falls back to a development secret, making IP hashes predictable.
  Keep it stable across restarts.
- `TRUST_PROXY`: set to `1` when behind a reverse proxy. Without it, every
  request appears to come from the proxy's address and the rate limiter
  collapses into a single shared bucket.

Put a reverse proxy in front of `PORT` for TLS.

## Health

```sh
curl -fsS http://127.0.0.1:8787/api/health
```

Healthy response:

```json
{ "ok": true, "database": "ok" }
```

Database failures return HTTP 503 with `{ "ok": false, "database": "error" }`.

## Backup

```sh
mkdir -p /var/backups/motiontwin
sqlite3 "$LEADERBOARD_DB_PATH" ".backup '/var/backups/motiontwin/leaderboard-$(date +%F-%H%M).sqlite'"
```

## Restore

1. Stop the Node server.
2. Copy the selected backup over `LEADERBOARD_DB_PATH`.
3. Ensure the server user can read/write the database file and parent directory.
4. Start the Node server.
5. Verify `/api/health`, then check a leaderboard route.
