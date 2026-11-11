'use strict';
// End-to-end check of the full flow against a throwaway database.
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gymflow-'));
process.env.SUPER_KEY = 'test-super';

const { seedDemo } = require('../src/seed');
const app = require('../src/server');

(async () => {
  seedDemo({ slug: 'gold', password: 'admin123' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token, extra = {}) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let n = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  ✓', msg); n++; };

  // pages & public data
  for (const p of ['/', '/super', '/g/gold', '/admin/gold', '/static/app.css', '/g/gold/manifest.json', '/g/gold/icon.svg'])
    ok((await fetch(base + p)).status === 200, `GET ${p} -> 200`);
  ok((await fetch(base + '/g/nope')).status === 404, 'unknown gym -> 404');

  let pub = (await call('GET', '/api/gold/public')).body;
  ok(pub.gym.name && pub.live.capacity === 40, 'public data has gym + capacity');
  ok(pub.hourly.length === 18 && pub.hourly.some((h) => h.predicted > 0), 'hourly forecast built from history');
  ok(['quiet', 'medium', 'busy'].includes(pub.live.level), `live level = ${pub.live.level} (${pub.live.count} inside)`);
  ok(pub.classes.length >= 4, 'upcoming classes listed');

  // auth
  ok((await call('GET', '/api/gold/admin/overview')).status === 401, 'admin API rejects anonymous');
  ok((await call('POST', '/api/gold/admin/login', { password: 'wrong' })).status === 401, 'wrong admin password rejected');
  const admin = (await call('POST', '/api/gold/admin/login', { password: 'admin123' })).body.token;
  ok(!!admin, 'admin login works');

  // multi-tenant isolation
  const sup = await call('POST', '/api/super/gyms', { slug: 'iron', name: 'آيرون جيم', color: '#111111', capacity: 20, password: 'ironpass1' }, null, { 'x-super-key': 'test-super' });
  ok(sup.status === 201, 'super admin creates a second gym');
  ok((await call('POST', '/api/super/gyms', { slug: 'x', name: 'x', password: 'abcdef' }, null, { 'x-super-key': 'bad' })).status === 401, 'super API needs key');
  ok((await call('GET', '/api/iron/admin/overview', null, admin)).status === 401, "gold's admin token can't open iron");
  ok((await call('GET', '/api/iron/admin/members', null, (await call('POST', '/api/iron/admin/login', { password: 'ironpass1' })).body.token)).body.length === 0, 'iron starts empty (no data leak)');

  // members + scan flow changes the live crowd
  const before = (await call('GET', '/api/gold/admin/overview', null, admin)).body.live.count;
  const mem = await call('POST', '/api/gold/admin/members', { name: 'اختبار', phone: '01234567890', days: 30 }, admin);
  ok(mem.status === 201 && /^[A-Z0-9]{6}$/.test(mem.body.code), 'create member returns a code');
  ok((await call('POST', '/api/gold/admin/members', { name: 'dup', phone: '01234567890' }, admin)).status === 409, 'duplicate phone rejected');
  const s1 = await call('POST', '/api/gold/admin/scan', { code: mem.body.code }, admin);
  ok(s1.body.action === 'in' && s1.body.live.count === before + 1, 'scan #1 = check-in, crowd +1');
  const s2 = await call('POST', '/api/gold/admin/scan', { code: mem.body.code.toLowerCase() }, admin);
  ok(s2.body.action === 'out' && s2.body.live.count === before, 'scan #2 = check-out, crowd -1 (case-insensitive)');
  const exp = await call('POST', '/api/gold/admin/scan', { code: 'EXPIR2' }, admin);
  ok(exp.status === 403, 'expired member refused at the door');
  ok((await call('POST', '/api/gold/admin/scan', { code: 'ZZZZZZ' }, admin)).status === 404, 'unknown code -> 404');
  const renewed = await call('POST', '/api/gold/admin/members/2/renew', { days: 30 }, admin);
  ok(renewed.body.expires_at > Date.now(), 'renew extends an expired membership');
  ok((await call('POST', '/api/gold/admin/scan', { code: 'EXPIR2' }, admin)).body.action === 'in', 'renewed member can enter');

  // member login + booking
  ok((await call('POST', '/api/gold/member/login', { phone: '01000000001', code: 'WRONG1' })).status === 401, 'member login rejects wrong code');
  const mt = (await call('POST', '/api/gold/member/login', { phone: '01000000001', code: 'demo22' })).body.token;
  ok(!!mt, 'member login works');
  const me = (await call('GET', '/api/gold/me', null, mt)).body;
  ok(me.qr.startsWith('<svg') && me.active, 'member gets QR + active status');
  ok((await call('GET', '/api/gold/admin/members', null, mt)).status === 401, 'member token cannot use admin API');
  const cls = (await call('GET', '/api/gold/public')).body.classes[0];
  ok((await call('POST', `/api/gold/classes/${cls.id}/book`, null, mt)).status === 201, 'member books a class');
  ok((await call('POST', `/api/gold/classes/${cls.id}/book`, null, mt)).status === 409, 'double booking rejected');
  ok((await call('GET', '/api/gold/public')).body.classes[0].booked === cls.booked + 1, 'booked count updates');
  ok((await call('DELETE', `/api/gold/classes/${cls.id}/book`, null, mt)).status === 200, 'member cancels booking');
  ok((await call('GET', '/api/gold/me', null, mt)).body.bookings.length === 0, 'booking removed');

  // class capacity + creation using Cairo local time
  const c = await call('POST', '/api/gold/admin/classes', { title: 'اختبار', starts_at: '2099-01-01T10:00', capacity: 1 }, admin);
  ok(c.status === 201, 'admin creates class');
  const mt2 = (await call('POST', '/api/gold/member/login', { phone: '01000000003', code: (await call('GET', '/api/gold/admin/members', null, admin)).body.find((m) => m.phone === '01000000003').code })).body.token;
  await call('POST', `/api/gold/classes/${c.body.id}/book`, null, mt);
  ok((await call('POST', `/api/gold/classes/${c.body.id}/book`, null, mt2)).status === 409, 'full class refuses extra booking');

  // stale visit auto-closes
  const db = require('../src/db');
  const g = db.prepare("SELECT * FROM gyms WHERE slug='iron'").get();
  const m2 = Number(db.prepare("INSERT INTO members (gym_id,name,phone,code,expires_at,created_at) VALUES (?,?,?,?,?,?)").run(g.id, 'x', '0111111111', 'STALE1', Date.now() + 1e9, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO visits (gym_id, member_id, in_at) VALUES (?,?,?)').run(g.id, m2, Date.now() - 5 * 3600e3);
  ok((await call('GET', '/api/iron/public')).body.live.count === 0, 'forgotten check-out is auto-closed after 3h');

  // Cairo local-time conversion (summer UTC+3, winter UTC+2)
  const U = require('../src/util');
  ok(new Date(U.parseLocal('2026-07-01T12:00')).toISOString() === '2026-07-01T09:00:00.000Z', 'Cairo summer time converts correctly');
  ok(new Date(U.parseLocal('2026-12-01T12:00')).toISOString() === '2026-12-01T10:00:00.000Z', 'Cairo winter time converts correctly');

  server.close();
  console.log(`\nAll ${n} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
