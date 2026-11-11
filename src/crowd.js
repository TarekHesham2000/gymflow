'use strict';
const db = require('./db');
const { localParts, crowdLevel } = require('./util');

const HOUR = 3600e3;

// Visits left open longer than the gym's stay limit are closed automatically
// (people forget to scan out).
function closeStale(gym, now = Date.now()) {
  const limit = gym.stay_hours * HOUR;
  db.prepare('UPDATE visits SET out_at = in_at + ? WHERE gym_id = ? AND out_at IS NULL AND in_at < ?')
    .run(limit, gym.id, now - limit);
}

function liveCount(gym, now = Date.now()) {
  closeStale(gym, now);
  return db.prepare('SELECT COUNT(*) AS c FROM visits WHERE gym_id = ? AND out_at IS NULL').get(gym.id).c;
}

function live(gym, now = Date.now()) {
  const count = liveCount(gym, now);
  return { count, capacity: gym.capacity, ...crowdLevel(count, gym.capacity) };
}

// Hour-by-hour view for today: what happened so far + a forecast built from
// the same weekday in the previous 4 weeks.
function hourly(gym, now = Date.now(), from = 6, to = 23) {
  const today = localParts(now);
  const rows = db.prepare('SELECT in_at, out_at FROM visits WHERE gym_id = ? AND in_at >= ?')
    .all(gym.id, now - 36 * 24 * HOUR);

  const byDate = new Map(); // date -> [[startHour, endHour]]
  for (const r of rows) {
    const s = localParts(r.in_at);
    const end = localParts(r.out_at ?? now);
    const e = end.date === s.date ? end.h : 24;
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push([s.h, e]);
  }
  const occAt = (date, h) =>
    (byDate.get(date) || []).filter(([s, e]) => s <= h + 0.5 && h + 0.5 < e).length;

  // The previous 4 occurrences of today's weekday that the gym already existed on.
  const created = localParts(gym.created_at).date;
  const pastDates = [];
  for (let k = 1; k <= 4; k++) {
    const d = localParts(now - k * 7 * 24 * HOUR).date;
    if (d >= created) pastDates.push(d);
  }

  const out = [];
  for (let h = from; h <= to; h++) {
    let predicted = null;
    if (pastDates.length) {
      predicted = Math.round(pastDates.reduce((a, d) => a + occAt(d, h), 0) / pastDates.length);
    }
    let actual = null;
    if (h < today.hour) actual = occAt(today.date, h);
    else if (h === today.hour) actual = liveCount(gym, now);
    out.push({
      h, predicted, actual,
      predictedLevel: predicted == null ? null : crowdLevel(predicted, gym.capacity).level,
      actualLevel: actual == null ? null : crowdLevel(actual, gym.capacity).level,
    });
  }
  return out;
}

module.exports = { closeStale, liveCount, live, hourly };
