'use strict';
const crypto = require('crypto');

const TZ = 'Africa/Cairo';
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});

// Local (Cairo) wall-clock parts for a UTC timestamp. Handles DST via Intl.
function localParts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    date: `${o.year}-${o.month}-${o.day}`, dow: o.weekday,
    y: +o.year, mo: +o.month, d: +o.day, hour: +o.hour, mi: +o.minute, s: +o.second,
    h: +o.hour + +o.minute / 60,
  };
}
function tzOffset(ms) {
  const p = localParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.hour, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
function localToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffset(guess);
  t = guess - tzOffset(t);
  return t;
}
// "2026-11-12T18:30" interpreted as Cairo time -> UTC ms
function parseLocal(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(str || ''));
  return m ? localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}
function startOfLocalDay(ms) {
  const p = localParts(ms);
  return localToUtc(p.y, p.mo, p.d, 0, 0);
}

function sign(payload, secret) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(b).digest('base64url');
  return `${b}.${mac}`;
}
function verify(token, secret) {
  try {
    const [b, mac] = String(token || '').split('.');
    if (!b || !mac) return null;
    const exp = crypto.createHmac('sha256', secret).update(b).digest('base64url');
    const x = Buffer.from(mac), y = Buffer.from(exp);
    if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
function checkPassword(pw, salt, hash) {
  const h = crypto.scryptSync(String(pw), salt, 32);
  const e = Buffer.from(hash, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(n = 6) {
  let s = '';
  for (const b of crypto.randomBytes(n)) s += ALPHABET[b % ALPHABET.length];
  return s;
}
const normPhone = (p) => String(p || '').replace(/\D/g, '');

// Crowd level from headcount vs capacity
function crowdLevel(count, capacity) {
  const pct = capacity > 0 ? count / capacity : 0;
  return { pct: Math.round(pct * 100), level: pct < 0.4 ? 'quiet' : pct < 0.75 ? 'medium' : 'busy' };
}

module.exports = {
  TZ, localParts, localToUtc, parseLocal, startOfLocalDay,
  sign, verify, hashPassword, checkPassword, randomCode, normPhone, crowdLevel,
};
