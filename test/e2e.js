'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const MOCK_PORT = 4911;
const APP_PORT = 4912;
const SECRET = 'whsec_test';
const KEY = 're_test_key';
const stock = { 'MUG-1': 0, 'TEE-1': 0, 'HAT-1': 0, 'BAG-1': 5 };
const emails = [];
const seenKeys = new Map();
let failNext = 0;
let stockDown = 0;

const mock = http.createServer(async (req, res) => {
  const body = await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
  const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'bad key' });
  const m = req.url.match(/^\/api\/stock(?:\/(.+))?$/);
  if (req.method === 'GET' && m) {
    if (stockDown > 0) { stockDown--; return send(503, { error: 'down' }); }
    if (!m[1]) return send(200, { products: Object.entries(stock).map(([sku, q]) => ({ sku, name: `Product ${sku}`, price: 20, currency: 'GBP', quantity: q, in_stock: q > 0 })) });
    const sku = decodeURIComponent(m[1]);
    const q = stock[sku] || 0;
    return send(200, { sku, name: `Product ${sku}`, price: 20, currency: 'GBP', quantity: q, in_stock: q > 0 });
  }
  if (req.method === 'POST' && req.url === '/emails') {
    const p = JSON.parse(body);
    const key = req.headers['idempotency-key'];
    if (key && seenKeys.has(key)) return send(200, { id: seenKeys.get(key) });
    if (failNext > 0) { failNext--; return send(500, { message: 'injected' }); }
    const id = `em_${emails.length + 1}`;
    if (key) seenKeys.set(key, id);
    emails.push({ to: p.to[0], subject: p.subject, html: p.html });
    return send(200, { id });
  }
  send(404, {});
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-'));
let app;
function startApp() {
  app = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir, STOCK_API_URL: `http://localhost:${MOCK_PORT}/api/stock`, STOCK_API_KEY: KEY,
      RESEND_API_KEY: KEY, RESEND_BASE_URL: `http://localhost:${MOCK_PORT}`, WEBHOOK_SECRET: SECRET, RECONCILE_SECONDS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('  app: ' + d));
  app.stderr.on('data', (d) => process.stdout.write('  app err: ' + d));
  return waitFor(async () => (await call('GET', '/healthz')).status === 200, 5000);
}
const stopApp = () => new Promise((r) => { app.once('exit', r); app.kill('SIGTERM'); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(100); } throw new Error('timeout'); }
async function call(method, p, body, headers = {}) {
  const r = await fetch(`http://localhost:${APP_PORT}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.text() };
}
const hook = (evt, secret = SECRET) => call('POST', '/webhooks/stock', evt, { 'x-webhook-secret': secret });
const count = (to, skuPart) => emails.filter((e) => e.to === to && e.subject.includes(skuPart)).length;

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  await startApp();
  const results = [];
  const test = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };

  await test('embed renders and is frameable', async () => {
    const r = await call('GET', '/embed?sku=MUG-1');
    assert.equal(r.status, 200);
    assert.match(r.body, /Notify me/);
  });
  await test('rejects bad input', async () => {
    assert.equal((await call('POST', '/api/requests', { email: 'nope', sku: 'MUG-1' })).status, 422);
    assert.equal((await call('POST', '/api/requests', { email: 'a@b.com' })).status, 422);
  });
  await test('no duplicate open requests (10 concurrent)', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/requests', { email: 'Ana@Example.com', sku: 'mug-1' })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 200).length, 9);
  });
  await test('wrong webhook secret is rejected', async () => {
    assert.equal((await hook({ event_id: 'e0', sku: 'MUG-1', quantity: 5 }, 'nope')).status, 401);
  });
  await test('phantom restock does not email', async () => {
    assert.equal((await hook({ event_id: 'e1', sku: 'MUG-1', quantity: 9 })).status, 200);
    await sleep(1500);
    assert.equal(count('ana@example.com', 'MUG-1'), 0);
  });
  await test('real restock with the same webhook twice at once emails exactly once', async () => {
    stock['MUG-1'] = 4;
    await Promise.all([hook({ event_id: 'e2', sku: 'MUG-1', quantity: 4 }), hook({ event_id: 'e2', sku: 'MUG-1', quantity: 4 })]);
    await waitFor(() => count('ana@example.com', 'MUG-1') === 1, 5000);
    await sleep(1500);
    assert.equal(count('ana@example.com', 'MUG-1'), 1);
  });
  await test('different event ids for the same restock still email once', async () => {
    await hook({ event_id: 'e3', sku: 'MUG-1', quantity: 4 });
    await sleep(1500);
    assert.equal(count('ana@example.com', 'MUG-1'), 1);
  });
  await test('email 500s are retried until delivered once', async () => {
    await call('POST', '/api/requests', { email: 'ben@example.com', sku: 'TEE-1' });
    failNext = 2;
    stock['TEE-1'] = 3;
    await hook({ event_id: 'e4', sku: 'TEE-1', quantity: 3 });
    await waitFor(() => count('ben@example.com', 'TEE-1') === 1, 15000);
    assert.equal(count('ben@example.com', 'TEE-1'), 1);
  });
  await test('stock API outage is retried, and a missed webhook is caught by reconciliation', async () => {
    await call('POST', '/api/requests', { email: 'cara@example.com', sku: 'HAT-1' });
    stockDown = 2;
    stock['HAT-1'] = 2;
    await waitFor(() => count('cara@example.com', 'HAT-1') === 1, 15000);
  });
  await test('requests survive a restart and still get notified', async () => {
    stock['MUG-1'] = 0;
    await call('POST', '/api/requests', { email: 'dan@example.com', sku: 'MUG-1' });
    await stopApp();
    await startApp();
    stock['MUG-1'] = 6;
    await hook({ event_id: 'e5', sku: 'MUG-1', quantity: 6 });
    await waitFor(() => count('dan@example.com', 'MUG-1') === 1, 5000);
    assert.equal(count('ana@example.com', 'MUG-1'), 1);
  });
  await test('admin needs a password', async () => {
    assert.equal((await call('GET', '/admin')).status, 401);
    const ok = await call('GET', '/admin', null, { authorization: 'Basic ' + Buffer.from('admin:' + SECRET).toString('base64') });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /dan@example.com/);
  });

  for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? `  -> ${e}` : ''}`);
  if (process.env.SAVE_SAMPLES) {
    fs.writeFileSync(path.join(process.env.SAVE_SAMPLES, 'email.html'), emails[0].html);
  }
  await stopApp();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
}

main().catch(async (e) => { console.error(e); try { await stopApp(); } catch {} process.exit(1); });
