# Back-in-Stock Alerts

Customers leave their email on a sold-out product and get **exactly one** email when it is really back.
Plain Node.js (no dependencies), a crash-safe JSON store on disk, and a background worker with retries.

## Run it

```bash
docker build -t back-in-stock .
docker run -p 3000:3000 \
  -e STOCK_API_URL=... -e STOCK_API_KEY=... \
  -e RESEND_API_KEY=... -e RESEND_BASE_URL=... \
  -e WEBHOOK_SECRET=... \
  back-in-stock
```

Without Docker: `node src/server.js` (Node 20+). Tests: `npm test` (spins up a mock stock API + mock Resend and runs the app against it).

| Route | What it does |
|---|---|
| `GET /embed?sku=SKU` | Email form for an iframe on any store. Shows the product, price and stock state. Without `sku` it shows a product picker. |
| `POST /api/requests` | `{ email, sku }`. 201 when created, 200 with `duplicate: true` when an open request already exists. |
| `POST /webhooks/stock` | Stock webhook, checked against `X-Webhook-Secret`. |
| `GET /admin` | Requests, status, when each was notified, send attempts. Basic auth. |

## Env

| Variable | Required | |
|---|---|---|
| `STOCK_API_URL`, `STOCK_API_KEY` | yes | Source of truth for stock |
| `RESEND_API_KEY`, `RESEND_BASE_URL` | yes | Email sending (Resend API format) |
| `WEBHOOK_SECRET` | yes | Shared secret for webhooks |
| `PORT` | no | Default 3000 |
| `ADMIN_PASSWORD` | no | `/admin` password (any username). **Defaults to `WEBHOOK_SECRET`** so the container needs nothing extra. |
| `DATA_DIR` | no | Where state is stored. Mount a volume here in production. |
| `FROM_EMAIL`, `STORE_NAME`, `PRODUCT_URL` | no | Email sender, branding, and a `https://shop/products/{sku}` link for the button |

## How customers get one email: not zero, not two

**Don't trust the webhook.** A webhook only means "go and look". The app re-reads the stock API, and only a quantity above 0 there triggers emails. Fake restocks are logged and ignored. The secret is compared in constant time.

**Duplicate webhooks, even at the same moment.** Every `event_id` is recorded before the 200 is returned. Node handles each request's check-and-record step without interruption, so the second of two simultaneous deliveries sees the first and is dropped. Re-checks for the same SKU are merged into one queued job.

**No duplicate requests.** One open request per (email, SKU). Emails are lowercased and SKUs uppercased first. Ten parallel submits create one request.

**Exactly-once email.**
- A confirmed restock moves each waiting request to `sending` and writes that to disk.
- The worker then sends with `Idempotency-Key: back-in-stock/<request id>`.
- If the process dies after the provider accepted the email but before we saved `notified`, the retry reuses the same key, and the provider returns the original email instead of sending a second one.
- 5xx and network errors back off and retry (2s, 4s, 8s ... up to 5 min, 10 attempts). A 400 or 422 is marked `failed` and shows in the admin.

**Don't trust the network.**
- Stock API failures go back on the queue with backoff.
- Every 60s the app re-checks SKUs that still have waiting customers, so a webhook that never arrived still ends in an email.

**Survives a restart.**
- State is written with write, fsync, then rename.
- Pending stock checks and `sending` emails are saved too, so the worker carries on where it stopped.
- In Docker, mount a volume at `/app/data` to keep state across container replacements.

## Tests

`test/e2e.js` runs the real server against mocks and checks:
- concurrent duplicate requests
- wrong secret
- a fake restock
- the same webhook twice at once
- a new event id for the same restock
- injected email 500s
- a stock API outage and recovery through reconciliation
- a restart mid-flow
- admin auth

All pass.

## Built with

Claude Code (Anthropic) for the build and tests, reviewed and directed by me.
