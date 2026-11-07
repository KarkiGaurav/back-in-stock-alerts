'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./store');
const views = require('./views');

const env = process.env;
const PORT = Number(env.PORT || 3000);
const STOCK_API_URL = String(env.STOCK_API_URL || '').replace(/\/+$/, '');
const STOCK_API_KEY = env.STOCK_API_KEY || '';
const RESEND_API_KEY = env.RESEND_API_KEY || '';
const RESEND_BASE_URL = String(env.RESEND_BASE_URL || 'https://api.resend.com').replace(/\/+$/, '');
const WEBHOOK_SECRET = env.WEBHOOK_SECRET || '';
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || WEBHOOK_SECRET;
const FROM_EMAIL = env.FROM_EMAIL || 'Restock Alerts <alerts@restock-alerts.dev>';
const STORE_NAME = env.STORE_NAME || 'Restock Alerts';
const PRODUCT_URL = env.PRODUCT_URL || '';
const DATA_DIR = env.DATA_DIR || path.join(__dirname, '..', 'data');
const RECONCILE_MS = 1000 * Number(env.RECONCILE_SECONDS || 60);
const MAX_SEND_ATTEMPTS = Number(env.MAX_SEND_ATTEMPTS || 10);

const store = new Store(DATA_DIR);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const backoff = (n) => Math.min(5 * 60_000, 2000 * 2 ** Math.max(0, n - 1)) + Math.floor(Math.random() * 500);
const normSku = (s) => String(s ?? '').trim().toUpperCase().slice(0, 64);
const normEmail = (s) => String(s ?? '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, body };
}

async function getStock(sku) {
  const r = await fetchJson(`${STOCK_API_URL}/${encodeURIComponent(sku)}`, { headers: { authorization: `Bearer ${STOCK_API_KEY}` } });
  if (!r.ok || !r.body || typeof r.body !== 'object') throw new Error(`stock API HTTP ${r.status}`);
  const quantity = Number(r.body.quantity);
  if (!Number.isFinite(quantity)) throw new Error('stock API returned no quantity');
  return { ...r.body, sku, quantity, in_stock: quantity > 0 };
}

const catalog = { at: 0, bySku: {}, list: [] };
async function getCatalog(force = false) {
  if (!force && Date.now() - catalog.at < 60_000 && catalog.list.length) return catalog;
  try {
    const r = await fetchJson(STOCK_API_URL, { headers: { authorization: `Bearer ${STOCK_API_KEY}` } });
    const list = Array.isArray(r.body?.products) ? r.body.products : Array.isArray(r.body) ? r.body : [];
    if (r.ok && list.length) {
      catalog.list = list;
      catalog.bySku = Object.fromEntries(list.map((p) => [normSku(p.sku), p]));
      catalog.at = Date.now();
    }
  } catch (e) {
    log('catalog fetch failed:', e.message);
  }
  return catalog;
}

const checking = new Set();
async function runStockCheck(job) {
  if (checking.has(job.sku)) return;
  checking.add(job.sku);
  try {
    let stock;
    try {
      stock = await getStock(job.sku);
    } catch (e) {
      job.attempts += 1;
      job.nextAttemptAt = Date.now() + backoff(job.attempts);
      job.lastError = e.message;
      store.commit();
      log(`stock check ${job.sku} failed (${e.message}), retry #${job.attempts}`);
      return;
    }
    if (stock.in_stock) {
      const waiting = store.waitingFor(job.sku);
      for (const r of waiting) {
        r.status = 'sending';
        r.nextAttemptAt = 0;
        r.product = { sku: stock.sku, name: stock.name, image: stock.image, price: stock.price, currency: stock.currency };
      }
      log(`${job.sku} confirmed in stock (${stock.quantity}); ${waiting.length} customer(s) queued`);
    } else if (job.reason === 'webhook') {
      log(`${job.sku}: webhook said restocked but stock API says ${stock.quantity}; ignoring`);
    }
    store.finishJob(job.sku);
    store.commit();
    if (stock.in_stock) kick();
  } finally {
    checking.delete(job.sku);
  }
}

const inFlight = new Set();
async function sendNotification(r) {
  if (inFlight.has(r.id)) return;
  inFlight.add(r.id);
  try {
    const product = r.product || (await getCatalog()).bySku[r.sku] || { sku: r.sku, name: r.sku };
    const shopUrl = PRODUCT_URL ? PRODUCT_URL.replace('{sku}', encodeURIComponent(r.sku)) : '';
    const payload = {
      from: FROM_EMAIL,
      to: [r.email],
      subject: `${product.name || r.sku} is back in stock`,
      html: views.emailHtml({ product, storeName: STORE_NAME, shopUrl }),
      text: views.emailText({ product, storeName: STORE_NAME, shopUrl }),
      tags: [{ name: 'type', value: 'back_in_stock' }],
    };
    r.attempts += 1;
    store.commit();
    let res;
    try {
      res = await fetchJson(`${RESEND_BASE_URL}/emails`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': `back-in-stock/${r.id}` },
        body: JSON.stringify(payload),
      }, 15_000);
    } catch (e) {
      res = { status: 0, ok: false, body: { message: e.message } };
    }
    if (res.ok) {
      r.status = 'notified';
      r.notifiedAt = new Date().toISOString();
      r.emailId = res.body?.id || null;
      r.lastError = null;
      log(`notified ${r.email} about ${r.sku}`);
    } else {
      const permanent = res.status === 400 || res.status === 422;
      r.lastError = `HTTP ${res.status || 'network'}: ${String(res.body?.message || '').slice(0, 140)}`;
      if (permanent || r.attempts >= MAX_SEND_ATTEMPTS) {
        r.status = 'failed';
      } else {
        r.nextAttemptAt = Date.now() + backoff(r.attempts);
      }
      log(`send to ${r.email} for ${r.sku} failed (${r.lastError}), attempt ${r.attempts}`);
    }
    store.commit();
  } finally {
    inFlight.delete(r.id);
  }
}

let ticking = false;
let again = false;
async function tick() {
  if (ticking) { again = true; return; }
  ticking = true;
  try {
    do {
      again = false;
      const now = Date.now();
      await Promise.all(store.dueJobs(now).map((j) => runStockCheck(j)));
      const due = store.sending().filter((r) => !r.nextAttemptAt || r.nextAttemptAt <= Date.now());
      for (let i = 0; i < due.length; i += 5) await Promise.all(due.slice(i, i + 5).map((r) => sendNotification(r)));
    } while (again);
  } catch (e) {
    log('worker error', e);
  } finally {
    ticking = false;
  }
}
const kick = () => setImmediate(tick);
setInterval(tick, 1000).unref();
setInterval(() => {
  const skus = store.skusWithWaiting();
  for (const sku of skus) store.enqueueCheck(sku, 'reconcile');
  if (skus.length) { store.commit(); kick(); }
}, RECONCILE_MS).unref();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json', ...headers });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function adminAuthorized(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ') || !ADMIN_PASSWORD) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString();
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return safeEqual(pass, ADMIN_PASSWORD);
}

const recentByIp = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (recentByIp.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  recentByIp.set(ip, hits);
  if (recentByIp.size > 10_000) recentByIp.clear();
  return hits.length > 120;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (p === '/healthz' || (p === '/' && m === 'GET')) {
    if (p === '/') return send(res, 302, '', { location: '/embed' });
    return json(res, 200, { ok: true });
  }

  if (p === '/embed' && m === 'GET') {
    const sku = normSku(url.searchParams.get('sku'));
    const cat = await getCatalog();
    let product = null;
    if (sku) {
      product = { ...(cat.bySku[sku] || { sku, name: sku }) };
      try { Object.assign(product, await getStock(sku)); } catch {}
    }
    const products = cat.list.map((x) => ({ ...x, sku: normSku(x.sku) })).sort((a, b) => Number(a.in_stock) - Number(b.in_stock));
    return send(res, 200, views.embedPage({ sku, product, products, storeName: STORE_NAME }), {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "frame-ancestors *; default-src 'self'; img-src * data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
  }

  if (p === '/api/requests') {
    if (m === 'OPTIONS') return send(res, 204, '', CORS);
    if (m !== 'POST') return json(res, 405, { error: 'Method not allowed' }, CORS);
    if (rateLimited(req.socket.remoteAddress || '')) return json(res, 429, { error: 'Too many requests, slow down.' }, CORS);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Body must be JSON: { "email", "sku" }' }, CORS); }
    const email = normEmail(body?.email);
    const sku = normSku(body?.sku);
    if (!EMAIL_RE.test(email) || email.length > 254) return json(res, 422, { error: 'Please enter a valid email address.' }, CORS);
    if (!sku || !/^[A-Z0-9][A-Z0-9._\-/ ]*$/.test(sku)) return json(res, 422, { error: 'A valid SKU is required.' }, CORS);
    const { request, created } = store.addRequest(email, sku, { source: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 60) : null });
    if (created) { store.enqueueCheck(sku, 'request'); store.commit(); kick(); }
    return json(res, created ? 201 : 200, { id: request.id, email, sku, status: request.status, duplicate: !created }, CORS);
  }

  if (p === '/webhooks/stock') {
    if (m !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (!WEBHOOK_SECRET || !safeEqual(req.headers['x-webhook-secret'] || '', WEBHOOK_SECRET)) return json(res, 401, { error: 'Invalid webhook secret' });
    let evt;
    try { evt = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const sku = normSku(evt?.sku);
    if (!sku) return json(res, 422, { error: 'sku is required' });
    const eventId = String(evt.event_id || crypto.createHash('sha256').update(JSON.stringify(evt)).digest('hex')).slice(0, 128);
    if (store.seenEvent(eventId)) return json(res, 200, { ok: true, duplicate: true });
    store.recordEvent(eventId, { sku, quantity: Number(evt.quantity) });
    if (Number(evt.quantity) > 0 || evt.quantity === undefined) store.enqueueCheck(sku, 'webhook');
    store.commit();
    kick();
    return json(res, 200, { ok: true });
  }

  if (p === '/admin' && m === 'GET') {
    if (!adminAuthorized(req)) return send(res, 401, 'Authentication required', { 'www-authenticate': 'Basic realm="Back-in-stock admin", charset="UTF-8"' });
    const filter = ['waiting', 'sending', 'notified', 'failed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';
    const all = store.state.requests;
    const counts = all.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), { all: all.length });
    const requests = all.filter((r) => filter === 'all' || r.status === filter).slice().reverse().slice(0, 500);
    const cat = await getCatalog();
    return send(res, 200, views.adminPage({ requests, products: cat.bySku, filter, counts, jobs: store.state.jobs.length }), {
      'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store',
    });
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    log('request error', e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status === 413 ? 'Body too large' : 'Internal error' });
  });
});

server.listen(PORT, () => {
  log(`back-in-stock listening on :${PORT} (data in ${DATA_DIR})`);
  const resumed = store.sending().length + store.state.jobs.length;
  if (resumed) log(`resuming ${resumed} pending item(s) from before restart`);
  kick();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
