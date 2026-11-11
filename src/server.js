'use strict';
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const U = require('./util');
const crowd = require('./crowd');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

// ---- config / secrets ------------------------------------------------------
const SUPER_KEY = process.env.SUPER_KEY || 'change-me';
function getSecret() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'secret'").get();
  if (row) return row.value;
  const s = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('secret', ?)").run(s);
  return s;
}
const SECRET = process.env.SECRET || getSecret();
const DAY = 864e5;
const TOKEN_TTL = 30 * DAY;

const fail = (res, code, error) => res.status(code).json({ error });
const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer /, '');

// very small in-memory rate limiter for login-type endpoints
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path;
    const now = Date.now();
    const e = hits.get(k);
    if (!e || e.reset < now) hits.set(k, { n: 1, reset: now + windowMs });
    else if (++e.n > max) return fail(res, 429, 'محاولات كتير، جرّب بعد شوية');
    next();
  };
}
const loginLimiter = limit(15, 5 * 60e3);

// ---- tenant resolution -----------------------------------------------------
app.param('slug', (req, res, next, slug) => {
  const gym = db.prepare('SELECT * FROM gyms WHERE slug = ?').get(String(slug).toLowerCase());
  if (!gym) return fail(res, 404, 'الجيم غير موجود');
  req.gym = gym;
  next();
});

function requireAdmin(req, res, next) {
  const p = U.verify(bearer(req), SECRET);
  if (!p || p.role !== 'admin' || p.gym !== req.gym.id) return fail(res, 401, 'سجّل دخول الأول');
  next();
}
function requireMember(req, res, next) {
  const p = U.verify(bearer(req), SECRET);
  if (!p || p.role !== 'member' || p.gym !== req.gym.id) return fail(res, 401, 'سجّل دخول الأول');
  const m = db.prepare('SELECT * FROM members WHERE id = ? AND gym_id = ?').get(p.mid, req.gym.id);
  if (!m) return fail(res, 401, 'سجّل دخول الأول');
  req.member = m;
  next();
}
function requireSuper(req, res, next) {
  const a = Buffer.from(String(req.headers['x-super-key'] || ''));
  const b = Buffer.from(SUPER_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 401, 'مفتاح غير صحيح');
  next();
}

const colorOk = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ''));
const clean = (s, max = 80) => String(s ?? '').trim().slice(0, max);

// ---- pages -----------------------------------------------------------------
const pub = path.join(__dirname, '..', 'public');
app.use('/static', express.static(pub, { maxAge: '5m' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.send('ok'); });
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/super', (req, res) => res.sendFile(path.join(pub, 'super.html')));
app.get('/g/:slug', (req, res) => res.sendFile(path.join(pub, 'member.html')));
app.get('/admin/:slug', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
// per-gym PWA manifest + icon so "Add to home screen" shows the gym's own brand
app.get('/g/:slug/manifest.json', (req, res) => {
  const g = req.gym;
  res.json({
    name: g.name, short_name: g.name.slice(0, 12), start_url: `/g/${g.slug}`, scope: `/g/${g.slug}`,
    display: 'standalone', dir: 'rtl', lang: 'ar', background_color: '#ffffff', theme_color: g.color,
    icons: [{ src: `/g/${g.slug}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  });
});
app.get('/g/:slug/icon.svg', (req, res) => {
  const g = req.gym;
  const letter = [...g.name][0] || 'G';
  res.type('image/svg+xml').send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${g.color}"/>` +
    `<text x="256" y="340" font-size="280" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${letter.replace(/[<&>]/g, '')}</text></svg>`);
});

// ---- super admin (you) -----------------------------------------------------
app.get('/api/gyms', (req, res) => {
  res.json(db.prepare('SELECT slug, name, color FROM gyms ORDER BY name').all());
});
app.get('/api/super/gyms', requireSuper, (req, res) => {
  res.json(db.prepare('SELECT id, slug, name, color, capacity, created_at FROM gyms ORDER BY id DESC').all());
});
app.post('/api/super/gyms', requireSuper, (req, res) => {
  const b = req.body || {};
  const slug = clean(b.slug, 30).toLowerCase();
  if (!/^[a-z0-9-]{2,30}$/.test(slug)) return fail(res, 400, 'الـ slug حروف إنجليزي وأرقام وشرطة بس');
  if (!clean(b.name)) return fail(res, 400, 'اسم الجيم مطلوب');
  if (String(b.password || '').length < 6) return fail(res, 400, 'الباسورد 6 حروف على الأقل');
  if (db.prepare('SELECT 1 FROM gyms WHERE slug = ?').get(slug)) return fail(res, 409, 'الـ slug مستخدم');
  const { salt, hash } = U.hashPassword(b.password);
  const info = db.prepare(
    'INSERT INTO gyms (slug, name, color, capacity, stay_hours, admin_salt, admin_hash, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(slug, clean(b.name), colorOk(b.color) ? b.color : '#0ea5e9',
      Math.max(5, Math.min(2000, parseInt(b.capacity) || 50)), 3, salt, hash, Date.now());
  res.status(201).json({ id: Number(info.lastInsertRowid), slug, member_url: `/g/${slug}`, admin_url: `/admin/${slug}` });
});

// ---- public (no login): the core feature -----------------------------------
function upcomingClasses(gym) {
  return db.prepare(
    `SELECT c.id, c.title, c.coach, c.starts_at, c.capacity,
            (SELECT COUNT(*) FROM bookings b WHERE b.class_id = c.id) AS booked
       FROM classes c WHERE c.gym_id = ? AND c.starts_at > ? ORDER BY c.starts_at LIMIT 30`)
    .all(gym.id, Date.now());
}
app.get('/api/:slug/public', (req, res) => {
  const g = req.gym;
  res.set('Cache-Control', 'no-store');
  res.json({
    gym: { name: g.name, color: g.color, slug: g.slug },
    live: crowd.live(g),
    hourly: crowd.hourly(g),
    now_hour: U.localParts(Date.now()).hour,
    classes: upcomingClasses(g),
  });
});

// ---- member ----------------------------------------------------------------
app.post('/api/:slug/member/login', loginLimiter, (req, res) => {
  const phone = U.normPhone(req.body?.phone);
  const code = clean(req.body?.code, 12).toUpperCase();
  const m = db.prepare('SELECT * FROM members WHERE gym_id = ? AND phone = ? AND code = ?').get(req.gym.id, phone, code);
  if (!m) return fail(res, 401, 'الرقم أو الكود غير صحيح');
  res.json({ token: U.sign({ role: 'member', gym: req.gym.id, mid: m.id, exp: Date.now() + TOKEN_TTL }, SECRET) });
});
app.get('/api/:slug/me', requireMember, async (req, res) => {
  const m = req.member;
  const bookings = db.prepare(
    `SELECT c.id, c.title, c.starts_at FROM bookings b JOIN classes c ON c.id = b.class_id
      WHERE b.member_id = ? AND c.starts_at > ? ORDER BY c.starts_at`).all(m.id, Date.now());
  res.json({
    name: m.name, plan: m.plan, code: m.code, expires_at: m.expires_at, active: m.expires_at > Date.now(),
    qr: await QRCode.toString(m.code, { type: 'svg', margin: 1, width: 220 }),
    bookings,
  });
});
app.post('/api/:slug/classes/:id/book', requireMember, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ? AND gym_id = ?').get(req.params.id, req.gym.id);
  if (!cls) return fail(res, 404, 'الكلاس مش موجود');
  if (cls.starts_at <= Date.now()) return fail(res, 400, 'الكلاس بدأ بالفعل');
  if (req.member.expires_at <= Date.now()) return fail(res, 403, 'اشتراكك منتهي، جدّده من الجيم');
  const booked = db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE class_id = ?').get(cls.id).c;
  if (booked >= cls.capacity) return fail(res, 409, 'الكلاس مكتمل');
  try {
    db.prepare('INSERT INTO bookings (class_id, member_id, created_at) VALUES (?,?,?)').run(cls.id, req.member.id, Date.now());
  } catch { return fail(res, 409, 'انت حاجز في الكلاس ده بالفعل'); }
  res.status(201).json({ ok: true });
});
app.delete('/api/:slug/classes/:id/book', requireMember, (req, res) => {
  db.prepare('DELETE FROM bookings WHERE class_id = ? AND member_id = ? AND class_id IN (SELECT id FROM classes WHERE gym_id = ?)')
    .run(req.params.id, req.member.id, req.gym.id);
  res.json({ ok: true });
});

// ---- gym admin -------------------------------------------------------------
app.post('/api/:slug/admin/login', loginLimiter, (req, res) => {
  const g = req.gym;
  if (!U.checkPassword(String(req.body?.password || ''), g.admin_salt, g.admin_hash)) return fail(res, 401, 'الباسورد غلط');
  res.json({ token: U.sign({ role: 'admin', gym: g.id, exp: Date.now() + 12 * 3600e3 }, SECRET), gym: { name: g.name, color: g.color, capacity: g.capacity } });
});

app.get('/api/:slug/admin/overview', requireAdmin, (req, res) => {
  const g = req.gym, now = Date.now();
  const todayStart = U.startOfLocalDay(now);
  const one = (sql, ...a) => db.prepare(sql).get(...a).c;
  res.json({
    live: crowd.live(g),
    today_checkins: one('SELECT COUNT(*) AS c FROM visits WHERE gym_id = ? AND in_at >= ?', g.id, todayStart),
    active_members: one('SELECT COUNT(*) AS c FROM members WHERE gym_id = ? AND expires_at > ?', g.id, now),
    expiring_soon: one('SELECT COUNT(*) AS c FROM members WHERE gym_id = ? AND expires_at > ? AND expires_at < ?', g.id, now, now + 7 * DAY),
    recent: db.prepare(
      `SELECT v.id, m.name, v.in_at, v.out_at FROM visits v JOIN members m ON m.id = v.member_id
        WHERE v.gym_id = ? ORDER BY v.in_at DESC LIMIT 12`).all(g.id),
  });
});

// Reception scans a member's QR (or types the code). Same scan toggles in/out.
app.post('/api/:slug/admin/scan', requireAdmin, (req, res) => {
  const g = req.gym, now = Date.now();
  const code = clean(req.body?.code, 20).toUpperCase();
  const m = db.prepare('SELECT * FROM members WHERE gym_id = ? AND code = ?').get(g.id, code);
  if (!m) return fail(res, 404, 'كود غير صحيح');
  crowd.closeStale(g, now);
  const open = db.prepare('SELECT id FROM visits WHERE gym_id = ? AND member_id = ? AND out_at IS NULL').get(g.id, m.id);
  const info = { name: m.name, expires_at: m.expires_at };
  if (open) {
    db.prepare('UPDATE visits SET out_at = ? WHERE id = ?').run(now, open.id);
    return res.json({ action: 'out', member: info, live: crowd.live(g) });
  }
  if (m.expires_at <= now) return res.status(403).json({ error: 'الاشتراك منتهي', member: info });
  db.prepare('INSERT INTO visits (gym_id, member_id, in_at) VALUES (?,?,?)').run(g.id, m.id, now);
  res.json({ action: 'in', member: info, live: crowd.live(g) });
});

app.get('/api/:slug/admin/members', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT id, name, phone, code, plan, expires_at,
            EXISTS(SELECT 1 FROM visits v WHERE v.member_id = members.id AND v.out_at IS NULL) AS inside
       FROM members WHERE gym_id = ? ORDER BY id DESC LIMIT 500`).all(req.gym.id));
});
app.post('/api/:slug/admin/members', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = clean(b.name), phone = U.normPhone(b.phone);
  if (!name || phone.length < 8) return fail(res, 400, 'الاسم ورقم التليفون مطلوبين');
  const days = Math.max(1, Math.min(800, parseInt(b.days) || 30));
  for (let i = 0; i < 5; i++) {
    try {
      const code = U.randomCode(6);
      const info = db.prepare('INSERT INTO members (gym_id, name, phone, code, plan, expires_at, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(req.gym.id, name, phone, code, clean(b.plan, 40) || null, Date.now() + days * DAY, Date.now());
      return res.status(201).json({ id: Number(info.lastInsertRowid), code });
    } catch (e) {
      if (/phone/.test(String(e.message))) return fail(res, 409, 'رقم التليفون مسجل بالفعل');
    }
  }
  fail(res, 500, 'حصل خطأ، جرّب تاني');
});
app.post('/api/:slug/admin/members/:id/renew', requireAdmin, (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ? AND gym_id = ?').get(req.params.id, req.gym.id);
  if (!m) return fail(res, 404, 'العضو مش موجود');
  const days = Math.max(1, Math.min(800, parseInt(req.body?.days) || 30));
  const from = Math.max(m.expires_at, Date.now()); // renewing early keeps remaining days
  db.prepare('UPDATE members SET expires_at = ? WHERE id = ?').run(from + days * DAY, m.id);
  res.json({ expires_at: from + days * DAY });
});

app.get('/api/:slug/admin/classes', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM bookings b WHERE b.class_id = c.id) AS booked
       FROM classes c WHERE c.gym_id = ? AND c.starts_at > ? ORDER BY c.starts_at`).all(req.gym.id, Date.now() - 3600e3));
});
app.post('/api/:slug/admin/classes', requireAdmin, (req, res) => {
  const b = req.body || {};
  const startsAt = U.parseLocal(b.starts_at);
  if (!clean(b.title) || !startsAt) return fail(res, 400, 'اسم الكلاس والميعاد مطلوبين');
  const info = db.prepare('INSERT INTO classes (gym_id, title, coach, starts_at, capacity) VALUES (?,?,?,?,?)')
    .run(req.gym.id, clean(b.title), clean(b.coach, 40) || null, startsAt, Math.max(1, Math.min(200, parseInt(b.capacity) || 15)));
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});
app.delete('/api/:slug/admin/classes/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM classes WHERE id = ? AND gym_id = ?').run(req.params.id, req.gym.id);
  res.json({ ok: true });
});

// ---- errors ----------------------------------------------------------------
app.use('/api', (req, res) => fail(res, 404, 'غير موجود'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'بيانات غير صالحة');
  console.error(err);
  fail(res, 500, 'خطأ في السيرفر');
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`GymFlow running on http://localhost:${port}`);
    if (SUPER_KEY === 'change-me') console.warn('! SUPER_KEY is the default. Set SUPER_KEY env var before deploying.');
  });
}
