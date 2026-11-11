'use strict';
// Demo data: one gym with 4 weeks of visit history so the forecast has something to show.
const db = require('./db');
const U = require('./util');

const DAY = 864e5;
const NAMES = ['أحمد محمد', 'محمود علي', 'مصطفى حسن', 'يوسف إبراهيم', 'عمر خالد', 'كريم سمير', 'علي طارق', 'هشام فتحي',
  'سارة أحمد', 'مريم محمود', 'نور علي', 'هبة حسن', 'ياسمين عادل', 'منى سعيد', 'إسلام رضا', 'باسم نبيل', 'تامر وائل',
  'خالد مجدي', 'رامي سامح', 'شريف عماد', 'دينا مصطفى', 'آية محمد', 'فاطمة كمال', 'حسام عزت', 'عمرو جمال', 'زياد أمين',
  'ماجد ناصر', 'وليد صلاح', 'لؤي هاني', 'سلمى ياسر'];
// relative arrival rate per local hour (peaks in the evening, small bump in the morning)
const RATE = { 6: 2, 7: 4, 8: 5, 9: 4, 10: 3, 11: 2, 12: 2, 13: 3, 14: 3, 15: 3, 16: 5, 17: 8, 18: 11, 19: 12, 20: 10, 21: 6, 22: 3 };

function seedDemo({ slug = 'gold', password = 'admin123' } = {}) {
  if (db.prepare('SELECT 1 FROM gyms WHERE slug = ?').get(slug)) return { skipped: true, slug };
  const now = Date.now();
  const { salt, hash } = U.hashPassword(password);
  const gymId = Number(db.prepare(
    'INSERT INTO gyms (slug, name, color, capacity, stay_hours, admin_salt, admin_hash, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(slug, 'جولد جيم', '#e11d48', 40, 3, salt, hash, now - 30 * DAY).lastInsertRowid);

  const insM = db.prepare('INSERT INTO members (gym_id, name, phone, code, plan, expires_at, created_at) VALUES (?,?,?,?,?,?,?)');
  const memberIds = [];
  NAMES.forEach((n, i) => {
    const code = i === 0 ? 'DEMO22' : i === 1 ? 'EXPIR2' : U.randomCode(6);
    const exp = i === 1 ? now - DAY : now + (5 + i * 3) * DAY;
    memberIds.push(Number(insM.run(gymId, n, `0100000${String(i + 1).padStart(4, '0')}`, code, i % 3 ? 'شهري' : 'ربع سنوي', exp, now - 29 * DAY).lastInsertRowid));
  });

  const insV = db.prepare('INSERT INTO visits (gym_id, member_id, in_at, out_at) VALUES (?,?,?,?)');
  const active = memberIds.filter((_, i) => i !== 1);
  db.exec('BEGIN');
  for (let k = 28; k >= 0; k--) {
    const p = U.localParts(now - k * DAY);
    const dayFactor = p.dow === 'Fri' ? 0.6 : p.dow === 'Sat' ? 0.9 : 1;
    for (const [hs, rate] of Object.entries(RATE)) {
      const h = +hs;
      const n = Math.round(rate * 1.8 * dayFactor * (0.8 + Math.random() * 0.4));
      for (let i = 0; i < n; i++) {
        const start = U.localToUtc(p.y, p.mo, p.d, h, Math.floor(Math.random() * 60));
        if (start > now) continue;
        const end = start + (50 + Math.random() * 50) * 60e3;
        insV.run(gymId, active[Math.floor(Math.random() * active.length)], start, end > now ? null : Math.round(end));
      }
    }
  }
  db.exec('COMMIT');

  const insC = db.prepare('INSERT INTO classes (gym_id, title, coach, starts_at, capacity) VALUES (?,?,?,?,?)');
  insC.run(gymId, 'HIIT', 'كابتن هاني', now + 2 * 3600e3, 12);
  const t = U.localParts(now + DAY);
  insC.run(gymId, 'يوغا', 'كابتن سلمى', U.localToUtc(t.y, t.mo, t.d, 17, 0), 15);
  insC.run(gymId, 'كروس فيت', 'كابتن عمر', U.localToUtc(t.y, t.mo, t.d, 19, 30), 14);
  insC.run(gymId, 'زومبا', 'كابتن دينا', U.localToUtc(t.y, t.mo, t.d, 20, 30), 20);
  return { slug, password, member_login: { phone: '01000000001', code: 'DEMO22' } };
}

module.exports = { seedDemo };

if (require.main === module) {
  const r = seedDemo();
  if (r.skipped) console.log(`Gym "${r.slug}" already exists, nothing to do.`);
  else {
    console.log('Demo gym created.');
    console.log(`  Member page : /g/${r.slug}   (login: phone ${r.member_login.phone}, code ${r.member_login.code})`);
    console.log(`  Admin panel : /admin/${r.slug}   (password: ${r.password})`);
  }
}
