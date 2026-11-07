'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    this.state = { requests: [], events: {}, jobs: [] };
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { requests: loaded.requests || [], events: loaded.events || {}, jobs: loaded.jobs || [] };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const bad = this.file + '.corrupt-' + Date.now();
        try { fs.renameSync(this.file, bad); } catch {}
        console.error(`state file unreadable, moved to ${bad}`);
      }
    }
  }

  commit() {
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  openRequest(email, sku) {
    return this.state.requests.find((r) => r.email === email && r.sku === sku && (r.status === 'waiting' || r.status === 'sending'));
  }

  addRequest(email, sku, meta = {}) {
    const existing = this.openRequest(email, sku);
    if (existing) return { request: existing, created: false };
    const request = {
      id: crypto.randomUUID(),
      email,
      sku,
      status: 'waiting',
      createdAt: new Date().toISOString(),
      notifiedAt: null,
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      emailId: null,
      source: meta.source || null,
    };
    this.state.requests.push(request);
    this.commit();
    return { request, created: true };
  }

  waitingFor(sku) {
    return this.state.requests.filter((r) => r.sku === sku && r.status === 'waiting');
  }

  sending() {
    return this.state.requests.filter((r) => r.status === 'sending');
  }

  skusWithWaiting() {
    return [...new Set(this.state.requests.filter((r) => r.status === 'waiting').map((r) => r.sku))];
  }

  seenEvent(id) {
    return Boolean(this.state.events[id]);
  }

  recordEvent(id, data) {
    this.state.events[id] = { ...data, receivedAt: new Date().toISOString() };
    const ids = Object.keys(this.state.events);
    if (ids.length > 5000) for (const old of ids.slice(0, ids.length - 5000)) delete this.state.events[old];
  }

  enqueueCheck(sku, reason) {
    if (!this.state.jobs.some((j) => j.sku === sku)) this.state.jobs.push({ sku, reason, attempts: 0, nextAttemptAt: 0 });
  }

  dueJobs(now) {
    return this.state.jobs.filter((j) => j.nextAttemptAt <= now);
  }

  finishJob(sku) {
    this.state.jobs = this.state.jobs.filter((j) => j.sku !== sku);
  }
}

module.exports = { Store };
