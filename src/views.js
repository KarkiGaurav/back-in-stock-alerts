'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (p) => (p && p.price != null ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: p.currency || 'GBP' }).format(p.price) : '');
const when = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');

const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;

function embedPage({ sku, product, products, storeName }) {
  const picker = !sku;
  const options = (products || []).map((p) => `<option value="${esc(p.sku)}">${esc(p.name)}${p.in_stock ? '' : ' (sold out)'}</option>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notify me when it's back</title>
<style>
:root{--ink:#14161a;--muted:#6b7280;--line:#e6e7eb;--bg:#ffffff;--soft:#f6f6f4;--accent:#111827;--ok:#0f7a4a;--err:#b42318}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--ink);font:15px/1.5 ${FONT};-webkit-font-smoothing:antialiased}
.card{max-width:440px;margin:0 auto;background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:20px}
.product{display:flex;gap:14px;align-items:center;margin-bottom:16px}
.product img{width:64px;height:64px;border-radius:10px;object-fit:cover;background:var(--soft);flex:none}
.name{font-weight:600;line-height:1.3}.meta{color:var(--muted);font-size:13px;margin-top:2px}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:#fdecec;color:var(--err);margin-left:6px}
.pill.in{background:#e7f6ee;color:var(--ok)}
h1{font-size:17px;margin:0 0 4px;letter-spacing:-.01em}p.sub{margin:0 0 14px;color:var(--muted);font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
input,select{width:100%;font:inherit;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:10px;padding:11px 12px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{border-color:#9ca3af;box-shadow:0 0 0 3px rgba(17,24,39,.08)}
.field{margin-bottom:12px}
button{width:100%;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:10px;padding:12px 14px;cursor:pointer;transition:opacity .15s}
button[disabled]{opacity:.6;cursor:default}
.msg{display:none;margin-top:12px;font-size:14px;border-radius:10px;padding:10px 12px}
.msg.err{display:block;background:#fdecec;color:var(--err)}
.done{display:none;text-align:center;padding:8px 0}
.done svg{width:44px;height:44px;margin-bottom:8px}
.done h2{font-size:17px;margin:0 0 4px}.done p{margin:0;color:var(--muted);font-size:14px}
.fine{margin:12px 0 0;color:var(--muted);font-size:12px;text-align:center}
</style></head><body>
<div class="card">
  ${product ? `<div class="product">${product.image ? `<img src="${esc(product.image)}" alt="">` : ''}<div><div class="name">${esc(product.name || product.sku)}</div>
  <div class="meta">${esc(money(product))}${product.in_stock ? '<span class="pill in">In stock</span>' : '<span class="pill">Sold out</span>'}</div></div></div>` : ''}
  <form id="f" novalidate>
    <h1>Get an email when it's back</h1>
    <p class="sub">One email, the moment it's restocked. Nothing else.</p>
    ${picker ? `<div class="field"><label for="sku">Product</label><select id="sku" name="sku" required>${options}</select></div>` : `<input type="hidden" name="sku" value="${esc(sku)}">`}
    <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required maxlength="254"></div>
    <button id="b" type="submit">Notify me</button>
    <div id="m" class="msg" role="alert"></div>
  </form>
  <div id="d" class="done" aria-live="polite">
    <svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="22" fill="#e7f6ee"/><path d="M15 24.5l6 6 12-13" stroke="#0f7a4a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <h2 id="dt">You're on the list</h2><p id="dp"></p>
  </div>
  <p class="fine">${esc(storeName)} will only use your email for this alert.</p>
</div>
<script>
const f=document.getElementById('f'),b=document.getElementById('b'),m=document.getElementById('m');
f.addEventListener('submit',async(e)=>{e.preventDefault();m.className='msg';
const email=f.email.value.trim(),sku=f.sku.value;
if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){m.textContent='Please enter a valid email address.';m.className='msg err';return}
b.disabled=true;b.textContent='Saving...';
try{const r=await fetch('/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,sku})});
const j=await r.json().catch(()=>({}));
if(!r.ok)throw new Error(j.error||'Something went wrong. Please try again.');
f.style.display='none';document.getElementById('d').style.display='block';
document.getElementById('dt').textContent=j.duplicate?'You\\'re already on the list':'You\\'re on the list';
document.getElementById('dp').textContent='We\\'ll email '+email+' once, as soon as it\\'s back.';
}catch(err){m.textContent=err.message;m.className='msg err';b.disabled=false;b.textContent='Notify me'}});
</script></body></html>`;
}

function emailHtml({ product, storeName, shopUrl }) {
  const name = esc(product.name || product.sku);
  const price = esc(money(product));
  const img = product.image ? `<tr><td style="padding:0 0 24px"><img src="${esc(product.image)}" width="520" alt="${name}" style="display:block;width:100%;max-width:520px;height:auto;border-radius:12px;border:0"></td></tr>` : '';
  const cta = shopUrl
    ? `<tr><td style="padding:8px 0 4px"><a href="${esc(shopUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:10px">Shop now</a></td></tr>`
    : `<tr><td style="padding:8px 0 4px;font-size:15px;color:#374151">Head to the store to grab yours before it sells out again.</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${name} is back in stock</title></head>
<body style="margin:0;padding:0;background:#f4f4f2;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${name} is back. Quantities are limited.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;font-family:${FONT}">
<tr><td style="padding:28px 20px 0;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">${esc(storeName)}</td></tr>
<tr><td style="padding:20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:0 0 10px"><span style="display:inline-block;background:#e7f6ee;color:#0f7a4a;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px">BACK IN STOCK</span></td></tr>
<tr><td style="padding:0 0 8px;font-size:26px;line-height:1.25;font-weight:700;color:#111827">Good news: it's back.</td></tr>
<tr><td style="padding:0 0 24px;font-size:16px;line-height:1.5;color:#374151">You asked us to tell you when <strong>${name}</strong> was available again. It just landed.</td></tr>
${img}
<tr><td style="padding:0 0 4px;font-size:18px;font-weight:600;color:#111827">${name}</td></tr>
${price ? `<tr><td style="padding:0 0 18px;font-size:16px;color:#6b7280">${price}</td></tr>` : ''}
${cta}
</table></td></tr>
<tr><td style="padding:8px 20px 28px;font-size:12px;line-height:1.5;color:#9ca3af">You're receiving this one-time email because you asked to be notified about this product. We won't email you about it again.</td></tr>
</table></td></tr></table></body></html>`;
}

function emailText({ product, storeName, shopUrl }) {
  return `${product.name || product.sku} is back in stock.\n\nYou asked ${storeName} to let you know when it was available again.${product.price != null ? `\nPrice: ${money(product)}` : ''}${shopUrl ? `\n\nShop now: ${shopUrl}` : ''}\n\nThis is a one-time email.`;
}

function adminPage({ requests, products, filter, counts, jobs }) {
  const statusPill = (s) => {
    const map = { waiting: ['#fff7e6', '#9a5b00', 'Waiting'], sending: ['#eef2ff', '#3730a3', 'Sending'], notified: ['#e7f6ee', '#0f7a4a', 'Notified'], failed: ['#fdecec', '#b42318', 'Failed'] };
    const [bg, fg, label] = map[s] || ['#f3f4f6', '#374151', s];
    return `<span class="pill" style="background:${bg};color:${fg}">${label}</span>`;
  };
  const tabs = ['all', 'waiting', 'sending', 'notified', 'failed'].map((t) => `<a href="?status=${t}" class="tab${filter === t ? ' on' : ''}">${t[0].toUpperCase() + t.slice(1)} <span>${t === 'all' ? counts.all : counts[t] || 0}</span></a>`).join('');
  const rows = requests.map((r) => {
    const p = products[r.sku];
    return `<tr><td><div class="em">${esc(r.email)}</div><div class="sm">${when(r.createdAt)}</div></td>
<td><div class="pr">${p && p.image ? `<img src="${esc(p.image)}" alt="">` : ''}<div><div>${esc(p ? p.name : r.sku)}</div><div class="sm mono">${esc(r.sku)}</div></div></div></td>
<td>${statusPill(r.status)}${r.lastError && r.status !== 'notified' ? `<div class="sm err">${esc(r.lastError)}</div>` : ''}</td>
<td>${r.notifiedAt ? when(r.notifiedAt) : '<span class="sm">–</span>'}</td>
<td class="num">${r.attempts || 0}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15">
<title>Back-in-stock requests</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f6f4;color:#14161a;font:14px/1.45 ${FONT};-webkit-font-smoothing:antialiased}
main{max-width:1100px;margin:0 auto;padding:28px 16px 64px}h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}.lead{color:#6b7280;margin:0 0 20px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.stat{background:#fff;border:1px solid #e6e7eb;border-radius:12px;padding:14px}.stat b{display:block;font-size:24px;letter-spacing:-.02em}.stat span{color:#6b7280;font-size:13px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.tab{padding:7px 12px;border-radius:999px;text-decoration:none;color:#374151;background:#fff;border:1px solid #e6e7eb;font-weight:600;font-size:13px}
.tab span{color:#9ca3af;margin-left:4px}.tab.on{background:#111827;color:#fff;border-color:#111827}.tab.on span{color:#d1d5db}
.card{background:#fff;border:1px solid #e6e7eb;border-radius:12px;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:720px}th,td{text-align:left;padding:11px 14px;border-bottom:1px solid #f0f0ee;vertical-align:middle}
th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:600;background:#fafaf9}
tr:last-child td{border-bottom:0}.em{font-weight:600}.sm{color:#6b7280;font-size:12px}.mono{font-family:ui-monospace,Menlo,monospace}.err{color:#b42318}.num{text-align:right}
.pr{display:flex;gap:10px;align-items:center}.pr img{width:36px;height:36px;border-radius:8px;object-fit:cover;background:#f3f4f6}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px}
.empty{padding:40px;text-align:center;color:#6b7280}
</style></head><body><main>
<h1>Back-in-stock requests</h1><p class="lead">Every customer request, its status and when it was notified. Refreshes every 15 seconds.</p>
<div class="stats"><div class="stat"><b>${counts.all}</b><span>Total requests</span></div><div class="stat"><b>${counts.waiting || 0}</b><span>Waiting for restock</span></div>
<div class="stat"><b>${counts.notified || 0}</b><span>Notified</span></div><div class="stat"><b>${(counts.sending || 0) + (counts.failed || 0)}</b><span>Retrying or failed</span></div>
<div class="stat"><b>${jobs}</b><span>Stock checks queued</span></div></div>
<div class="tabs">${tabs}</div>
<div class="card">${rows ? `<table><tr><th>Customer</th><th>Product</th><th>Status</th><th>Notified</th><th class="num">Sends</th></tr>${rows}</table>` : '<div class="empty">No requests yet.</div>'}</div>
</main></body></html>`;
}

module.exports = { embedPage, emailHtml, emailText, adminPage, esc };
