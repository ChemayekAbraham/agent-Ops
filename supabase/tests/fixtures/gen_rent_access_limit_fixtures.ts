/**
 * Generates the fixed fixtures behind supabase/tests/rent_access_limit_server.sql by running the REAL client function
 * (src/lib/rentAccessLimit.ts) on a fixed clock and a seeded set of payment histories. Output: SQL VALUES rows
 *   (id, payment times, hours-before-now offsets, increment, decrement, max, expected limit, paid_days, missed_days, tracked_days)
 * Hand-built edge cases carry explicit timestamps; the seeded random histories carry compact hour offsets (hours before the fixed clock).
 *
 *   npx vite-node supabase/tests/fixtures/gen_rent_access_limit_fixtures.ts
 *
 * Paste the output between the FIXTURES markers in the test. Re-run it if the TypeScript formula ever changes: the SQL test will then fail
 * until the server function agrees again.
 */
import { calculateRentAccessLimit } from '../../../src/lib/rentAccessLimit';

const NOW = new Date('2026-10-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// mulberry32: a tiny seeded generator so the fixtures never change by accident
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261014);

type Case = { id: string; times: string[]; hours?: number[]; inc: number; dec: number; max: number };
const cases: Case[] = [];
const at = (offsetDays: number, hourUtc: number, minute = 0) =>
  new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), hourUtc, minute) - offsetDays * DAY).toISOString();

// hand-built edges
cases.push({ id: 'no_payments', times: [], inc: 10000, dec: 7000, max: 30000000 });
cases.push({ id: 'paid_today_only', times: [at(0, 6)], inc: 10000, dec: 7000, max: 30000000 });
cases.push({ id: 'five_day_streak', times: [0, 1, 2, 3, 4].map((d) => at(d, 9)), inc: 10000, dec: 7000, max: 30000000 });
cases.push({ id: 'same_day_many', times: [at(0, 1), at(0, 8), at(0, 23, 59)], inc: 10000, dec: 7000, max: 30000000 });
cases.push({ id: 'one_old_payment_clamps_to_zero', times: [at(20, 10)], inc: 10000, dec: 7000, max: 30000000 });
{
  // 400 consecutive daily payments at 10:00 UTC (2 hours before the 12:00 clock), enough to reach the cap
  const hours = Array.from({ length: 400 }, (_, i) => i * 24 + 2);
  cases.push({ id: 'cap_hit', times: hours.map((h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString()), hours, inc: 100000, dec: 7000, max: 30000000 });
}
cases.push({ id: 'midnight_utc_boundary', times: [at(3, 23, 59), at(2, 0, 0), at(2, 0, 1)], inc: 10000, dec: 7000, max: 30000000 });
cases.push({ id: 'future_payment', times: [new Date(NOW.getTime() + 3 * DAY).toISOString()], inc: 10000, dec: 7000, max: 30000000 });
cases.push({ id: 'live_params', times: [0, 2, 3, 9, 10, 30].map((d) => at(d, 11)), inc: 10000, dec: 1000, max: 30000000 });
cases.push({ id: 'zero_decrement', times: [0, 5, 40].map((d) => at(d, 7)), inc: 10000, dec: 0, max: 30000000 });
cases.push({ id: 'zero_increment', times: [0, 5, 40].map((d) => at(d, 7)), inc: 0, dec: 7000, max: 30000000 });
cases.push({ id: 'tiny_max', times: [0, 1, 2, 3].map((d) => at(d, 7)), inc: 10000, dec: 7000, max: 25000 });

// seeded random histories, stored as hour offsets before the clock
for (let i = 0; i < 24; i++) {
  const horizon = 1 + Math.floor(rand() * 180);
  const density = 0.05 + rand() * 0.95;
  const hours: number[] = [];
  for (let d = 0; d < horizon; d++) {
    if (rand() < density) {
      const n = 1 + (rand() < 0.2 ? 1 : 0);
      for (let k = 0; k < n; k++) hours.push(d * 24 + Math.floor(rand() * 24) - 12 + 12);
    }
  }
  const inc = [10000, 10000, 5000, 20000, 1000][Math.floor(rand() * 5)];
  const dec = [7000, 1000, 7000, 3000, 12000][Math.floor(rand() * 5)];
  const max = [30000000, 30000000, 500000, 2000000][Math.floor(rand() * 4)];
  const times = hours.map((h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString());
  cases.push({ id: `random_${String(i + 1).padStart(2, '0')}`, times, hours, inc, dec, max });
}

const lines = cases.map((c) => {
  const r = calculateRentAccessLimit(500000, c.times.map((t) => ({ amount: 50000, created_at: t })), NOW, {
    paidIncrementUgx: c.inc, missedDecrementUgx: c.dec, maxLimitUgx: c.max,
  });
  const ts = c.hours
    ? 'NULL'
    : c.times.length ? `ARRAY[${c.times.map((t) => `'${t}'`).join(', ')}]::timestamptz[]` : `ARRAY[]::timestamptz[]`;
  const hs = c.hours ? `ARRAY[${c.hours.join(',')}]` : 'NULL::int[]';
  return `    ('${c.id}', ${ts}, ${hs}, ${c.inc}, ${c.dec}, ${c.max}, ${r.limit}, ${r.paidDays}, ${r.missedDays}, ${r.trackedDays})`;
});
console.log(`-- now = '${NOW.toISOString()}'`);
console.log(lines.join(',\n'));
