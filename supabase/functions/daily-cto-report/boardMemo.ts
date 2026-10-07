// Board Technology & Customer Reach memo (doc 201).
//
// Pure functions over the payload of public.get_board_tech_memo(): composeBoard()
// turns figures into the memo's content (summary cards, decisions, tables,
// actions, corrections) and buildBoardMemoPdf() lays it out. Nothing here
// touches the database or the network, so it can be exercised with a fixture.
//
// Principles carried over from the hand-written Week 39 report:
//   * count people, not clicks (sign-in; access-denied grouped by user);
//   * say whose problem a failure is (ours / customer's);
//   * a figure that cannot be measured is shown as unmeasurable, never dropped;
//   * causes we do not know are stated as "not yet established".

import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
type Rows = string[][];

export interface BoardCard { label: string; value: string; sub: string; status: string; tone: Tone }
export interface BoardBars { title: string; rows: { label: string; value: number; display: string; tone?: Tone }[]; footnote?: string }
export interface BoardAction { owner: string; when: string; text: string }
export interface BoardMemo {
  periodLabel: string;
  preparedLabel: string;
  summary: string;
  cards: BoardCard[];
  decide: string[];
  notes: string[];
  signups: { paras: string[]; bars: BoardBars };
  signin: { intro: string; table: Rows; problems: string[] };
  otp: { intro: string; table: Rows; footnote: string };
  messages: { bars: BoardBars; outcomes: Rows; paras: string[]; email: string };
  health: { table: Rows; rollbackBars: BoardBars; paras: string[] };
  corrections: Rows;
  actions: BoardAction[];
  sources: string;
}

// ------------------------------------------------------------------ helpers
const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const fmt = (v: unknown): string => num(v).toLocaleString('en-US');
const pct = (a: unknown, b: unknown, dp = 1): number => (num(b) > 0 ? Math.round((num(a) / num(b)) * 10 ** (dp + 2)) / 10 ** dp : 0);
const pctS = (a: unknown, b: unknown, dp = 1): string => `${pct(a, b, dp).toFixed(dp)}%`;
const of = (a: unknown, b: unknown, dp = 1): string => `${fmt(a)} of ${fmt(b)} (${pctS(a, b, dp)})`;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayShort = (iso: string): string => { const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()}`; };
const dayLong = (iso: string): string => { const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const joinList = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const kampala = (iso: string): Date => new Date(new Date(iso).getTime() + 3 * 3600 * 1000);
const stamp = (iso: string): string => { const k = kampala(iso); return `${k.getUTCDate()} ${MON[k.getUTCMonth()]} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')} EAT`; };

const OTP_LABEL: Record<string, string> = {
  login: 'Sign in by phone', signup: 'New sign-up', password_reset: 'Password reset',
  payout_number: 'Confirm payout number', phone_collection: 'Add phone to profile',
  phone_update: 'Change phone number', national_id_link: 'Link National ID', uncategorized: 'Other',
};
const STREAM_LABEL = (s: string): string => s.replace(/[_:-]+/g, ' ').trim();

// ------------------------------------------------------------------ compose
export function composeBoard(d: any): BoardMemo {
  const S = d.sms ?? {}, SD: any[] = d.sms_days ?? [], ST: any[] = d.sms_streams ?? [], E = d.email ?? {};
  const SI = d.signin ?? {}, OT: any[] = d.otp ?? [], OL = d.otp_login ?? {}, SU = d.signups ?? {};
  const ER = d.errors ?? {}, DB = d.db ?? {}, SJ: any[] = d.slow_jobs ?? [], J = d.jobs ?? {};
  const SEC = d.security ?? {}, BK = d.backups ?? {};
  const days: any[] = DB.days ?? [];
  const partial = d.partial_day === true;
  const closing = String(d.closing_date).slice(0, 10);
  const fromEat = kampala(d.window_from).toISOString().slice(0, 10);
  const nDays = days.length || 7;
  const periodLabel = `${dayLong(fromEat)} to ${dayLong(closing)} ${closing.slice(0, 4)}${partial ? ' (last day partial)' : ''}`;

  // ---- rollback
  const measured = days.filter((x) => x.ok);
  const rbRate = pct(DB.rollbacks, num(DB.commits) + num(DB.rollbacks));
  const spikeDays = measured.filter((x) => num(x.rate) >= 5);
  const resetDays = days.filter((x) => x.reset);
  const unmeasured = days.filter((x) => !x.ok);
  const rbTone: Tone = rbRate >= 5 ? 'bad' : 'good';
  const baseline = measured.filter((x) => num(x.rate) < 5);
  const baselineAvg = baseline.length ? baseline.reduce((s, x) => s + num(x.rate), 0) / baseline.length : 0;

  // ---- sign-in
  const siRate = pct(SI.people_in, SI.people_tried);
  const siTone: Tone = siRate >= 95 ? 'good' : siRate >= 85 ? 'warn' : 'bad';
  const ownFail = num(SI.platform) + num(SI.slow_reject);

  // ---- otp
  const otpV = OT.reduce((s, x) => s + num(x.verified), 0);
  const otpF = OT.reduce((s, x) => s + num(x.failed), 0);
  const otpRate = pct(otpV, otpV + otpF);

  // ---- sms
  const smsTotal = num(S.total);
  const smsReachedRate = pct(S.reached, smsTotal);
  const ours = num(S.credit) + num(S.rate) + num(S.backup_key);
  const failed = num(S.failed);
  const credit: any[] = S.credit_by_day ?? [];
  const rate: any[] = S.rate_by_day ?? [];
  const creditDays = credit.map((x) => `${num(x.n)} on ${dayLong(x.d)}`);
  const emailSentRate = pct(E.sent, E.total);
  const emailTone: Tone = emailSentRate >= 95 ? 'good' : 'warn';
  const smsTone: Tone = smsReachedRate >= 95 ? 'good' : smsReachedRate >= 85 ? 'warn' : 'bad';
  const otpTone: Tone = otpRate >= 90 ? 'good' : 'warn';

  const cards: BoardCard[] = [
    { label: 'Rollback rate', value: `${rbRate.toFixed(1)}%`, sub: `${DB.measured_days ?? 0} of ${nDays} days measured; target below 5%`, status: rbTone === 'bad' ? 'RED' : 'ON TARGET', tone: rbTone },
    { label: 'New accounts', value: fmt(SU.created), sub: `At least ${fmt(SU.opened_by_staff)} opened by agents or staff`, status: 'NORMAL', tone: 'neutral' },
    { label: 'Sign-in', value: `${siRate.toFixed(1)}%`, sub: `${fmt(SI.people_in)} of ${fmt(SI.people_tried)} people got in; target 95%`, status: siRate >= 95 ? 'ON TARGET' : 'BELOW TARGET', tone: siTone },
    { label: 'Verification codes', value: `${otpRate.toFixed(1)}%`, sub: `${fmt(otpV)} of ${fmt(otpV + otpF)} code entries succeeded`, status: otpRate >= 90 ? 'WORKING' : 'WATCH', tone: otpTone },
    { label: 'SMS', value: `${smsReachedRate.toFixed(1)}%`, sub: `${fmt(S.reached)} of ${fmt(smsTotal)} reached the network`, status: smsReachedRate >= 95 ? 'HEALTHY' : 'ACTION NEEDED', tone: smsTone },
    { label: 'E-mail', value: `${emailSentRate.toFixed(1)}%`, sub: `${fmt(E.sent)} of ${fmt(E.total)} sent; ${fmt(E.failed)} failed`, status: emailSentRate >= 95 ? 'HEALTHY' : 'WATCH', tone: emailTone },
  ];

  // ---- summary
  const ourShare = failed ? Math.round((ours / failed) * 100) : 0;
  const sumParts: string[] = [
    `This report covers ${periodLabel} (${nDays} days), computed directly from the live production database.`,
  ];
  if (failed > 0) {
    sumParts.push(`${pctS(failed, smsTotal)} of SMS failed (${fmt(failed)} of ${fmt(smsTotal)}) and ${ourShare}% of those failures were our own doing: ${fmt(S.credit)} from empty SMS credit, ${fmt(S.rate)} from sending too fast and ${fmt(S.backup_key)} from a broken backup-provider key.`);
  } else {
    sumParts.push('No SMS failed this period.');
  }
  if (spikeDays.length) {
    sumParts.push(`The database rollback rate was above the 5% target on ${joinList(spikeDays.map((x) => dayLong(x.d)))} (peak ${Math.max(...spikeDays.map((x) => num(x.rate))).toFixed(1)}%); on the other measured days it ran at about ${baselineAvg.toFixed(1)}%.`);
  }
  if (DB.restarted_in_window) sumParts.push(`The database restarted on ${stamp(DB.postmaster_start)}.`);
  const summary = sumParts.join(' ');

  // ---- decide / notes
  const decide: string[] = [];
  const notes: string[] = [];
  if (num(S.credit) > 0) {
    decide.push(`Approve a standing low-balance top-up rule for the SMS provider accounts. ${fmt(S.credit)} messages failed because the prepaid balance was empty: ${joinList(creditDays)}. Credit ran out on ${credit.length} of ${nDays} days.`);
  }
  if (num(S.rate) > 0) {
    notes.push(`${fmt(S.rate)} messages were refused for sending too fast (${joinList(rate.map((x) => `${num(x.n)} on ${dayLong(x.d)}`))}).`);
  } else if (smsTotal > 0) {
    notes.push('No messages were refused for sending too fast this period.');
  }
  if (spikeDays.length) {
    notes.push(`Database rollbacks spiked on ${joinList(spikeDays.map((x) => `${dayLong(x.d)} (${num(x.rate).toFixed(1)}%)`))}. The cause is not yet established. Rollbacks over the measured days: ${of(DB.rollbacks, num(DB.commits) + num(DB.rollbacks))}.`);
  }
  if (unmeasured.length) {
    notes.push(`${joinList(unmeasured.map((x) => dayLong(x.d)))} cannot be measured for rollbacks${resetDays.length ? ' because the database counters restarted' : ' because no daily reading exists to compare against'}. The rate above covers ${DB.measured_days ?? 0} of ${nDays} days.`);
  }
  if (DB.restarted_in_window) notes.push(`The database restarted on ${stamp(DB.postmaster_start)}. The reason is not yet established.`);
  notes.push(num(S.confirmed_30d) > 0
    ? `Handset delivery confirmations are recorded for only ${of(S.confirmed_30d, S.total_30d, 1)} of SMS over 30 days (latest ${stamp(S.confirmed_latest_30d)}). Most SMS cannot be proven to have reached a handset.`
    : 'We still cannot prove that an SMS reached a handset: provider delivery confirmations are not recorded (0 confirmed in 30 days).');
  if (num(S.backup_key) > 0) notes.push(`The backup SMS provider's login key is still broken: ${fmt(S.backup_key)} messages failed on it.`);
  if (num(SI.startup_timeouts) > 0) notes.push(`${fmt(SI.startup_timeouts)} sign-in start-ups timed out across ${fmt(SI.startup_timeout_users)} users. They do not count in the sign-in rate but make the app slow to open.`);

  // ---- sign-ups
  const byDay: any[] = SU.by_day ?? [];
  const busiest = byDay.reduce((m, x) => (num(x.n) > num(m?.n) ? x : m), null as any);
  const signupParas = [
    `${fmt(SU.created)} new accounts were created over the ${nDays} days; at least ${fmt(SU.opened_by_staff)} were opened by field agents or staff on behalf of tenants, landlords and Supporters.${busiest ? ` ${dayLong(busiest.d)} was the busiest day (${fmt(busiest.n)}).` : ''}`,
    num(SU.blocked) > 0
      ? `The sign-up guard blocked ${fmt(SU.blocked)} attempts, from ${fmt(SU.blocked_actors)} agent account${num(SU.blocked_actors) === 1 ? '' : 's'} and ${fmt(SU.blocked_ips)} IP address${num(SU.blocked_ips) === 1 ? '' : 'es'}. Agent Operations should confirm whether this was genuine onboarding.`
      : 'The sign-up guard blocked no attempts this period.',
  ];
  const signups = {
    paras: signupParas,
    bars: { title: 'New accounts per day (EAT)', rows: byDay.map((x) => ({ label: dayShort(x.d), value: num(x.n), display: fmt(x.n) })), footnote: partial ? 'The last day is a part day.' : undefined } as BoardBars,
  };

  // ---- sign-in
  const att = num(SI.attempts);
  const signin = {
    intro: `We count people, not clicks. Someone who retries three times in one visit counts once. ${fmt(SI.people_in)} of ${fmt(SI.people_tried)} people who tried to sign in got in (${siRate.toFixed(1)}%, against a target of 95%).`,
    table: [
      ['Succeeded', fmt(SI.ok), pctS(SI.ok, att), 'Signed in'],
      ['Password or code rejected, fast (<5 s)', fmt(SI.fast_reject), pctS(SI.fast_reject, att), 'Account exists; almost certainly a wrong password'],
      ['Rejected after a slow attempt (>5 s)', fmt(SI.slow_reject), pctS(SI.slow_reject, att), 'Account exists; could be a weak network or our fault. Not yet separated'],
      ['No account for that number or e-mail', fmt(SI.no_account), pctS(SI.no_account, att), 'Person not registered, or used a different number'],
      ['Rate-limited or never resolved', fmt(SI.platform), pctS(SI.platform, att), 'Ours'],
      ['Total', fmt(att), '100%', ''],
    ] as Rows,
    problems: [
      num(SI.startup_timeouts) > 0
        ? `Slow start-up. The app gave up waiting for the sign-in service ${fmt(SI.startup_timeouts)} times across ${fmt(SI.startup_timeout_users)} signed-in users. The person still gets in, but the wait is long.`
        : 'No start-up timeouts were recorded.',
      num(SI.denied_users) > 0
        ? `Access-denied loop. ${fmt(SI.denied_users)} signed-in users were refused a page ${fmt(SI.denied_events)} times between them; the single busiest account accounts for ${fmt(SI.denied_top_user_events)} of those. That is a redirect loop on a few accounts, not ${fmt(SI.denied_events)} separate failures. It needs a fix on those accounts' roles.`
        : 'No access-denied loops were recorded.',
      num(SI.frozen_users) > 0
        ? `Frozen accounts. ${fmt(SI.frozen_users)} users with deliberately frozen accounts were refused ${fmt(SI.frozen_events)} times. This is correct behaviour.`
        : 'No frozen-account refusals were recorded.',
    ],
  };

  // ---- otp
  const otpTable: Rows = OT.map((x) => {
    const noVerifyLog = num(x.sent) > 0 && num(x.verified) === 0 && num(x.failed) === 0;
    return [OTP_LABEL[x.category] ?? String(x.category), num(x.sent) ? fmt(x.sent) : 'n/a', noVerifyLog ? 'n/a' : fmt(x.verified), noVerifyLog ? 'n/a' : fmt(x.failed)];
  });
  const otp = {
    intro: `Customers receive one-time codes to sign in, reset a password, confirm a new payout number and link a National ID. When people entered a code over the ${nDays} days, ${fmt(otpV)} of ${fmt(otpV + otpF)} entries succeeded (${otpRate.toFixed(1)}%). Sign-in by phone is also audited separately: ${fmt(OL.success)} of ${fmt(OL.total)} attempts succeeded, ${fmt(OL.failed)} had a wrong code and ${fmt(OL.no_account)} had no account.`,
    table: otpTable,
    footnote: '"n/a" means that flow does not record that event in the code log (sign-in by phone is audited separately above; password reset records no send). Withdrawal-approval codes are not in this log.',
  };

  // ---- messages
  const daysBars: BoardBars = {
    title: `SMS per day: ${fmt(smsTotal)} messages to ${fmt(S.phones)} phone numbers`,
    rows: SD.map((x) => ({ label: dayShort(x.d), value: num(x.total), display: `${fmt(x.total)}${num(x.failed) ? `  (${fmt(x.failed)} failed)` : ''}`, tone: num(x.failed) > num(x.total) * 0.1 ? 'warn' as Tone : 'good' as Tone })),
    footnote: `${fmt(S.queued)} messages (${pctS(S.queued, smsTotal)}) still waiting in the queue.${partial ? ' The last day is a part day.' : ''}`,
  };
  const outcomes: Rows = [
    ['Reached the network', fmt(S.reached), pctS(S.reached, smsTotal), 'Handed over; handset receipt not provable for most'],
    ['Refused: sending too fast', fmt(S.rate), pctS(S.rate, smsTotal), 'Ours'],
    ['Refused: SMS credit ran out', fmt(S.credit), pctS(S.credit, smsTotal), 'Ours'],
    ['Invalid or unsupported number', fmt(S.invalid), pctS(S.invalid, smsTotal), "Customer's data"],
    ['Backup provider login broken', fmt(S.backup_key), pctS(S.backup_key, smsTotal), 'Ours'],
    ['Accepted but never confirmed, then failed', fmt(S.unconfirmed), pctS(S.unconfirmed, smsTotal), 'Mixed'],
    ['Other failures', fmt(S.other), pctS(S.other, smsTotal), 'Mixed'],
    ['Still in the queue', fmt(S.queued), pctS(S.queued, smsTotal), 'Not yet sent'],
    ['Total', fmt(smsTotal), '100%', ''],
  ];
  const msgParas: string[] = [];
  if (failed > 0) msgParas.push(`${ourShare}% of SMS failures were within our control (${fmt(ours)} of ${fmt(failed)}).`);
  if (ST.length) {
    const t = ST[0];
    msgParas.push(`The largest single source of failures is the "${STREAM_LABEL(t.source)}" stream: ${fmt(t.failed)} of ${fmt(t.total)} messages failed (${pctS(t.failed, t.total)}), which is ${pctS(t.failed, failed, 0)} of all failures.${ST.length > 1 ? ` Next: ${joinList(ST.slice(1, 4).map((x: any) => `${STREAM_LABEL(x.source)} (${fmt(x.failed)} of ${fmt(x.total)})`))}.` : ''}`);
  }
  const emailTxt = `E-mail: ${fmt(E.total)} messages. ${fmt(E.sent)} were sent (${emailSentRate.toFixed(1)}%). ${fmt(E.suppressed)} were not sent because the address is on the suppression list (it bounced before or opted out). ${fmt(E.failed)} failed permanently and ${fmt(E.pending)} are still queued. Over 30 days, ${of(E.sent_30d, E.total_30d)} e-mails were delivered.`;

  // ---- health
  const dbTone: Tone = DB.restarted_in_window || num(DB.cache_hit_pct) < 99 ? 'warn' : 'good';
  const failedJobs = num(J.failed);
  const healthTable: Rows = [
    ['Reliability', rbTone === 'bad' ? 'RED' : 'GREEN', `Rollbacks ${rbRate.toFixed(1)}% over ${DB.measured_days ?? 0} measured day${num(DB.measured_days) === 1 ? '' : 's'}${spikeDays.length ? `; peak ${Math.max(...spikeDays.map((x) => num(x.rate))).toFixed(1)}%` : ''}`],
    ['Sign-in', siRate >= 95 ? 'GREEN' : 'AMBER', `${siRate.toFixed(1)}% against 95%`],
    ['Infrastructure', dbTone === 'warn' ? 'AMBER' : 'GREEN', DB.restarted_in_window ? `Restart on ${stamp(DB.postmaster_start)}; uptime ${DB.uptime_hours} h${SJ.length ? `; ${SJ.length} slow background job${SJ.length > 1 ? 's' : ''}` : ''}` : `Uptime ${DB.uptime_hours} h; cache hit ${DB.cache_hit_pct}%`],
    ['Scheduled jobs', failedJobs === 0 ? 'GREEN' : num(J.failed_24h) > 0 ? 'AMBER' : 'GREEN', `${fmt(failedJobs)} failed run${failedJobs === 1 ? '' : 's'} in ${fmt(J.runs)}; ${fmt(J.failed_24h)} in the last 24 h`],
    ['Security', pct(SEC.rls_tables, SEC.public_tables) >= 99 ? 'GREEN' : 'AMBER', `${fmt(SEC.rls_tables)} of ${fmt(SEC.public_tables)} tables protected`],
    ['Backups', num(BK.failures) === 0 && num(BK.runs) > 0 ? 'GREEN' : 'AMBER', `${fmt(num(BK.runs) - num(BK.failures))} of ${fmt(BK.runs)} succeeded`],
  ];
  const rollbackBars: BoardBars = {
    title: 'Database rollback rate per day (target below 5%)',
    rows: days.map((x) => ({ label: dayShort(x.d), value: x.ok ? num(x.rate) : 0, display: x.ok ? `${num(x.rate).toFixed(1)}%` : 'n/a', tone: x.ok ? (num(x.rate) >= 5 ? 'bad' as Tone : 'good' as Tone) : 'neutral' as Tone })),
    footnote: `${DB.measured_days ?? 0}-day overall: ${fmt(DB.rollbacks)} rollbacks of ${fmt(num(DB.commits) + num(DB.rollbacks))} transactions (${rbRate.toFixed(1)}%). Days marked n/a cannot be measured${resetDays.length ? ' because the database counters restarted' : ''}. Lifetime rate since the last restart: ${DB.lifetime_rollback_pct}%.`,
  };
  const healthParas: string[] = [];
  healthParas.push(`App errors. ${fmt(ER.errors)} errors reached ${fmt(ER.affected_users)} of ${fmt(ER.active_users)} active users (${pctS(ER.affected_users, ER.active_users)}; target below 1%). ${fmt(ER.offline_storage)} were offline-storage errors on phones and ${fmt(ER.map_crash)} were a map screen crash; the rest were mostly failed network requests and screens that load before their data arrives. Active users means anyone who signed in, hit an error or was recorded active in the window.`);
  healthParas.push(num(DB.deadlocks) > 0
    ? `Deadlocks. The database recorded ${fmt(DB.deadlocks)} deadlocks over the measured days. The cause is open.`
    : 'Deadlocks. None were recorded on the measured days.');
  if (SJ.length) healthParas.push(`Slow background jobs. ${joinList(SJ.map((x: any) => `${String(x.name).replace(/_/g, ' ')} averages ${fmt(x.mean_s)} seconds (${fmt(x.calls)} runs)`))}. Customers do not wait on them. They are candidates for tuning.`);
  healthParas.push(`Security. Access rules cover ${fmt(SEC.rls_tables)} of ${fmt(SEC.public_tables)} data tables and ${fmt(SEC.fraud_blocks_active)} fraud blocks are active. The ${fmt(SEC.privileged_accounts)} privileged staff accounts are due for access review.`);
  const failing: any[] = J.failing ?? [];
  healthParas.push(failing.length
    ? `Scheduled jobs. ${joinList(failing.map((x: any) => `"${x.job}" failed ${fmt(x.n)} time${num(x.n) === 1 ? '' : 's'}${x.error ? ` (${String(x.error).slice(0, 80)})` : ''}`))}.`
    : 'Scheduled jobs. No job failed this period.');
  healthParas.push(`Backups. ${fmt(num(BK.runs) - num(BK.failures))} of ${fmt(BK.runs)} backups succeeded${BK.latest ? `; the latest ran at ${stamp(BK.latest)}` : ''}. The ledger balance is verified separately and was not re-tested for this memo.`);

  // ---- corrections (source reports vs this memo)
  const confirmedNow = num(S.confirmed_30d);
  const corrections: Rows = [
    ['Sign-in failures caused by the platform', 'Daily report: 0.00%', `${pctS(ownFail, att, 2)} of attempts (${fmt(ownFail)}), plus ${fmt(SI.startup_timeouts)} slow start-ups`, 'Slow failed attempts and start-up timeouts were left out'],
    ['Access-denied events', 'Counted as sign-in failures', `${fmt(SI.denied_users)} users, ${fmt(SI.denied_events)} events`, 'Events were not grouped by user'],
    ['SMS delivery confirmed', 'Daily report: sweep "has never marked a message delivered"', `${fmt(confirmedNow)} confirmed in 30 days${confirmedNow ? `, latest ${stamp(S.confirmed_latest_30d)}` : ''}`, 'Confirmations exist but cover only part of the traffic'],
    ['Why SMS failed', '"Provider refused the message"', `${ourShare}% of failures were ours`, "The provider's own error text shows credit, rate limit or key problems"],
    ['Rollback figure', 'Summed over days, silently skipping reset days', `${DB.measured_days ?? 0} of ${nDays} days measured; unmeasurable days listed`, 'Counters restart with the database; a gap must be shown, not hidden'],
  ];

  // ---- actions
  const actions: BoardAction[] = [];
  if (num(S.credit) > 0) actions.push({ owner: 'Finance and Operations', when: 'today', text: 'Top up both SMS provider accounts and set a low-balance alert.' });
  if (num(S.rate) > 0) actions.push({ owner: 'Engineering', when: 'this week', text: 'Keep SMS pacing and send one-time codes first; rate-limit refusals are still occurring.' });
  if (num(S.backup_key) > 0) actions.push({ owner: 'Engineering', when: 'this week', text: `Repair the backup SMS provider's login key (${fmt(S.backup_key)} messages failed on it).` });
  if (ST[0] && pct(ST[0].failed, ST[0].total) >= 10) actions.push({ owner: 'Operations', when: 'this week', text: `Review the "${STREAM_LABEL(ST[0].source)}" stream: ${pctS(ST[0].failed, ST[0].total)} of its messages failed.` });
  if (num(DB.deadlocks) > 0) actions.push({ owner: 'Engineering', when: 'today', text: `Find the cause of the ${fmt(DB.deadlocks)} database deadlocks.` });
  if (spikeDays.length || DB.restarted_in_window) actions.push({ owner: 'Engineering', when: 'this week', text: `Find the cause of the rollback spike${spikeDays.length > 1 ? 's' : ''} on ${joinList(spikeDays.map((x) => dayLong(x.d)))}${DB.restarted_in_window ? ' and of the database restart' : ''}.` });
  if (failing.length) actions.push({ owner: 'Engineering', when: 'this week', text: `Fix the failing scheduled job${failing.length > 1 ? 's' : ''}: ${joinList(failing.map((x: any) => String(x.job)))}.` });
  const sprint: string[] = ['Start recording SMS handset confirmations for all providers.'];
  if (num(SI.startup_timeouts) > 0) sprint.push(`Confirm the sign-in start-up fix is live; ${fmt(SI.startup_timeouts)} start-up timeouts continue.`);
  if (num(SI.denied_users) > 0) sprint.push(`Fix the access-denied loop (${fmt(SI.denied_users)} users).`);
  actions.push({ owner: 'Engineering', when: 'next sprint', text: sprint.join(' ') });
  if (num(SU.blocked) > 0) actions.push({ owner: 'Agent Operations', when: 'this week', text: 'Confirm whether the agent account that triggered the sign-up guard was genuinely onboarding customers.' });
  actions.push({ owner: 'Access admin', when: 'this week', text: `Complete the review of the ${fmt(SEC.privileged_accounts)} privileged staff accounts.` });

  return {
    periodLabel,
    preparedLabel: stamp(d.generated_at),
    summary,
    cards,
    decide,
    notes,
    signups,
    signin,
    otp,
    messages: { bars: daysBars, outcomes, paras: msgParas, email: emailTxt },
    health: { table: healthTable, rollbackBars, paras: healthParas },
    corrections,
    actions,
    sources: `Source: public.get_board_tech_memo, run against the live production database on ${stamp(d.generated_at)}. The window is ${fromEat} 00:00 to ${stamp(d.window_to)} EAT${partial ? '; figures for the last day are partial' : ''}. The SMS and e-mail logs keep growing, so totals can move by a few messages.`,
  };
}

// --------------------------------------------------------------------- text
export function boardPlainText(m: BoardMemo): string {
  const t = (rows: Rows) => rows.map((r) => `  ${r.filter(Boolean).join(' | ')}`).join('\n');
  return [
    `Welile Board Report - Technology & Customer Reach`,
    m.periodLabel,
    '',
    '1 Summary for the Board',
    m.summary,
    ...m.cards.map((c) => `- ${c.label}: ${c.value} (${c.status}) ${c.sub}`),
    '',
    ...(m.decide.length ? ['Decide:', ...m.decide.map((x) => `- ${x}`), ''] : []),
    'Note:',
    ...m.notes.map((x) => `- ${x}`),
    '',
    '2 Sign-ups', ...m.signups.paras,
    '', '3 Sign-ins', m.signin.intro, t(m.signin.table), ...m.signin.problems,
    '', '4 One-time codes', m.otp.intro, t(m.otp.table),
    '', '5 Customer messages', t(m.messages.outcomes), ...m.messages.paras, m.messages.email,
    '', '6 How healthy the system has been', t(m.health.table), ...m.health.paras,
    '', '7 Corrections to the source reports', t(m.corrections),
    '', '8 Actions', ...m.actions.map((a, i) => `${i + 1}. ${a.owner}, ${a.when}: ${a.text}`),
    '', m.sources,
  ].join('\n');
}

// ---------------------------------------------------------------------- pdf
const WIN_ANSI_EXTRA = new Set(['—', '–', '‘', '’', '“', '”', '•', '…']);
const safe = (s: unknown): string =>
  String(s ?? '').replace(/[^\x00-\xFF]/g, (c) => (WIN_ANSI_EXTRA.has(c) ? c : '?'));

export async function buildBoardMemoPdf(m: BoardMemo): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, margin = 46, inner = W - margin * 2;
  const col = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
  const ink = col(15, 23, 42), muted = col(100, 116, 139), line = col(226, 232, 240), soft = col(248, 250, 252);
  const good = col(15, 157, 88), warn = col(199, 119, 0), bad = col(192, 57, 43), white = col(255, 255, 255);
  const tone = (t?: Tone) => (t === 'good' ? good : t === 'warn' ? warn : t === 'bad' ? bad : muted);
  const ragColor = (s: string) => (s === 'GREEN' ? good : s === 'RED' ? bad : warn);

  let page = doc.addPage([W, H]);
  let y = 0, pageNo = 0;

  const wrap = (s: string, f: typeof font, size: number, maxW: number): string[] => {
    const lines: string[] = [];
    let cur = '';
    for (const w of safe(s).split(/\s+/)) {
      const t = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const header = () => {
    pageNo += 1;
    page.drawRectangle({ x: 0, y: H - 84, width: W, height: 84, color: ink });
    page.drawText('WELILE TECHNOLOGIES LIMITED  |  BOARD OF DIRECTORS', { x: margin, y: H - 30, size: 8.5, font: bold, color: col(148, 163, 184) });
    page.drawText('Technology & Customer Reach Report', { x: margin, y: H - 54, size: 17, font: bold, color: white });
    page.drawText(safe(`${m.periodLabel}  |  Prepared ${m.preparedLabel}  |  Confidential`), { x: margin, y: H - 72, size: 8.5, font, color: col(203, 213, 225) });
    const pn = `Page ${pageNo}`;
    page.drawText(pn, { x: W - margin - bold.widthOfTextAtSize(pn, 8.5), y: H - 72, size: 8.5, font: bold, color: col(203, 213, 225) });
    y = H - 84 - 24;
  };
  const footer = () => {
    page.drawLine({ start: { x: margin, y: 38 }, end: { x: W - margin, y: 38 }, color: line, thickness: 0.6 });
    page.drawText('Confidential - prepared for the Chief Executive Officer and Board of Directors. Full engineering diagnostics issued separately.', { x: margin, y: 25, size: 7.5, font, color: muted });
  };
  const newPage = () => { footer(); page = doc.addPage([W, H]); header(); };
  const ensure = (h: number) => { if (y - h < 56) newPage(); };
  header();

  const section = (label: string) => {
    ensure(34);
    page.drawText(safe(label), { x: margin, y: y - 11, size: 11, font: bold, color: ink });
    page.drawLine({ start: { x: margin, y: y - 17 }, end: { x: W - margin, y: y - 17 }, color: ink, thickness: 1.2 });
    y -= 28;
  };
  const sub = (label: string) => { ensure(22); page.drawText(safe(label), { x: margin, y: y - 10, size: 9.5, font: bold, color: ink }); y -= 18; };
  const para = (s: string, size = 10, color = ink) => {
    for (const l of wrap(s, font, size, inner)) { ensure(size + 5); page.drawText(l, { x: margin, y: y - size, size, font, color }); y -= size + 4.5; }
    y -= 5;
  };
  const labelled = (label: string, s: string, c: Tone) => {
    const size = 10, lw = bold.widthOfTextAtSize(safe(label), size) + 6;
    const lines = wrap(s, font, size, inner - lw);
    lines.forEach((l, i) => {
      ensure(size + 5);
      if (i === 0) page.drawText(safe(label), { x: margin, y: y - size, size, font: bold, color: tone(c) });
      page.drawText(l, { x: margin + lw, y: y - size, size, font, color: ink });
      y -= size + 4.5;
    });
    y -= 4;
  };

  const table = (headers: string[], weights: number[], rows: Rows, opts: { boldFirst?: boolean; lastBold?: boolean; ragCol?: number } = {}) => {
    const size = 8.5, totalW = inner;
    const colX = (i: number) => margin + weights.slice(0, i).reduce((s, w) => s + w * totalW, 0);
    const colW = (i: number) => weights[i] * totalW - 12;
    const head = () => {
      page.drawRectangle({ x: margin, y: y - 18, width: totalW, height: 18, color: ink });
      headers.forEach((h, i) => page.drawText(safe(h), { x: colX(i) + 6, y: y - 13, size, font: bold, color: white }));
      y -= 18;
    };
    ensure(48); head();
    rows.forEach((row, ri) => {
      const cells = row.map((c, i) => wrap(c, i === 0 && opts.boldFirst !== false ? bold : font, size, colW(i)));
      const rowH = Math.max(16, 6 + Math.max(...cells.map((c) => c.length)) * (size + 3.2));
      if (y - rowH < 56) { newPage(); head(); }
      if (ri % 2 === 1) page.drawRectangle({ x: margin, y: y - rowH, width: totalW, height: rowH, color: soft });
      cells.forEach((lines, i) => {
        const isRag = opts.ragCol === i;
        lines.forEach((l, li) => page.drawText(l, {
          x: colX(i) + 6, y: y - 11 - li * (size + 3.2), size,
          font: i === 0 || isRag ? bold : font,
          color: isRag ? ragColor(row[i]) : i === 0 ? ink : muted,
        }));
      });
      page.drawLine({ start: { x: margin, y: y - rowH }, end: { x: W - margin, y: y - rowH }, color: line, thickness: 0.5 });
      y -= rowH;
    });
    y -= 8;
  };

  const bars = (b: BoardBars) => {
    ensure(22 + b.rows.length * 15 + 24);
    sub(b.title);
    const max = Math.max(1, ...b.rows.map((r) => r.value));
    const labelW = 52, valW = 120, barW = inner - labelW - valW, rowH = 15;
    b.rows.forEach((r) => {
      ensure(rowH + 2);
      page.drawText(safe(r.label), { x: margin, y: y - 11, size: 8.5, font, color: muted });
      const w = Math.max(r.value > 0 ? 2 : 0, (r.value / max) * barW);
      page.drawRectangle({ x: margin + labelW, y: y - 12, width: barW, height: 9, color: soft });
      if (w > 0) page.drawRectangle({ x: margin + labelW, y: y - 12, width: w, height: 9, color: r.tone === 'bad' ? bad : r.tone === 'warn' ? warn : r.tone === 'neutral' ? muted : col(37, 99, 235) });
      page.drawText(safe(r.display), { x: margin + labelW + barW + 8, y: y - 11, size: 8.5, font: bold, color: ink });
      y -= rowH;
    });
    if (b.footnote) { y -= 2; para(b.footnote, 8, muted); } else y -= 6;
  };

  // ---- 1 Summary + cards
  section('1  Summary for the Board');
  para(m.summary);
  const cw = (inner - 16) / 3, ch = 62;
  for (let i = 0; i < m.cards.length; i += 3) {
    ensure(ch + 8);
    m.cards.slice(i, i + 3).forEach((c, j) => {
      const x = margin + j * (cw + 8);
      page.drawRectangle({ x, y: y - ch, width: cw, height: ch, color: soft, borderColor: line, borderWidth: 0.6 });
      page.drawRectangle({ x, y: y - ch, width: 3, height: ch, color: tone(c.tone) });
      page.drawText(safe(c.label.toUpperCase()), { x: x + 10, y: y - 13, size: 7.5, font: bold, color: muted });
      page.drawText(safe(c.status), { x: x + cw - 8 - bold.widthOfTextAtSize(safe(c.status), 7), y: y - 13, size: 7, font: bold, color: tone(c.tone) });
      page.drawText(safe(c.value), { x: x + 10, y: y - 33, size: 17, font: bold, color: ink });
      wrap(c.sub, font, 7.5, cw - 18).slice(0, 2).forEach((l, k) => page.drawText(l, { x: x + 10, y: y - 45 - k * 9, size: 7.5, font, color: muted }));
    });
    y -= ch + 8;
  }
  y -= 4;
  sub('What the Board is asked to note or decide');
  m.decide.forEach((s) => labelled('Decide: ', s, 'bad'));
  m.notes.forEach((s) => labelled('Note: ', s, 'neutral'));

  // ---- 2 Sign-ups
  section('2  Sign-ups');
  m.signups.paras.forEach((p) => para(p));
  if (m.signups.bars.rows.length) bars(m.signups.bars);

  // ---- 3 Sign-ins
  section('3  Sign-ins');
  para(m.signin.intro);
  table(['Sign-in attempts', 'Attempts', 'Share', 'What it means'], [0.34, 0.1, 0.1, 0.46], m.signin.table);
  sub('Problems not counted in the sign-in rate');
  m.signin.problems.forEach((p) => para(p, 9.5));

  // ---- 4 OTP
  section('4  One-time codes (OTP)');
  para(m.otp.intro);
  if (m.otp.table.length) table(['Purpose', 'Codes sent', 'Verified', 'Failed entry'], [0.4, 0.2, 0.2, 0.2], m.otp.table);
  para(m.otp.footnote, 8, muted);

  // ---- 5 Messages
  section('5  Customer messages');
  bars(m.messages.bars);
  table(['Outcome', 'Messages', 'Share', 'Whose problem'], [0.36, 0.14, 0.1, 0.4], m.messages.outcomes);
  m.messages.paras.forEach((p) => para(p, 9.5));
  para(m.messages.email, 9.5);

  // ---- 6 Health
  section('6  How healthy the system has been');
  table(['Area', 'Status', 'Basis'], [0.22, 0.14, 0.64], m.health.table, { ragCol: 1 });
  bars(m.health.rollbackBars);
  m.health.paras.forEach((p) => para(p, 9.5));

  // ---- 7 Corrections
  section('7  Corrections to the source reports');
  para('Each figure below was recomputed from the live production database. Where a source report differs, this memo uses the corrected figure.', 9, muted);
  table(['Topic', 'Source report said', 'Corrected', 'Why'], [0.2, 0.24, 0.26, 0.3], m.corrections);

  // ---- 8 Actions
  section('8  Actions');
  m.actions.forEach((a, i) => para(`${i + 1}. ${a.owner}, ${a.when}: ${a.text}`, 9.5));
  para(m.sources, 8, muted);

  footer();
  return await doc.save();
}
