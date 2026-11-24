const { DatabaseSync } = require('node:sqlite');

function starts(now = new Date()) {
  const hour = new Date(now);
  hour.setMinutes(0, 0, 0);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setDate(day.getDate() - (day.getDay() + 6) % 7);
  const month = new Date(day);
  month.setDate(1);
  return { hour: +hour, day: +day, week: +week, month: +month };
}

class History {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS counts (server TEXT, minute INTEGER, n INTEGER, PRIMARY KEY(server, minute))');
    this.add = this.db.prepare('INSERT INTO counts VALUES (?, ?, 1) ON CONFLICT(server,minute) DO UPDATE SET n=n+1');
    this.sum = this.db.prepare('SELECT coalesce(sum(n),0) AS n FROM counts WHERE server=? AND minute BETWEEN ? AND ?');
  }
  record(server, rows) {
    if (!Array.isArray(rows)) throw Error('Formato API');
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const stamp = Date.parse(row?.timestamp);
        if (!Number.isFinite(stamp)) throw Error('Formato API');
        this.add.run(server, Math.floor(stamp / 60000) * 60000);
      }
      this.db.prepare('DELETE FROM counts WHERE minute < ?').run(Date.now() - 32 * 86400000);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  counts(server, now = new Date()) {
    return Object.fromEntries(Object.entries(starts(now)).map(([period, start]) =>
      [period, this.sum.get(server, start, +now).n]));
  }
}

function remaining(response, windowName) {
  const buckets = (response.groups ?? []).flatMap(group => group.buckets ?? []);
  const fractions = buckets.filter(bucket => !windowName || bucket.window === windowName)
    .map(bucket => bucket.remainingFraction)
    .filter(value => Number.isFinite(value) && value >= 0 && value <= 1);
  if (!fractions.length) throw Error('Sem quota');
  return Math.round(100 * Math.min(...fractions)) + '%';
}

module.exports = { History, remaining };
