/**
 * Automated call centre — turns a script's steps into Africa's Talking voice XML.
 *
 * Pure: no database, no network. voice-autocall-ivr calls `renderFrom` with the
 * job's frozen script snapshot and writes back the step it stopped on.
 *
 * Step types (validated in SQL by voice_autocall_validate_steps):
 *   say      speak, then continue to `next` in the same response
 *   menu     <GetDigits> → callback kind=digits; timeout → <Redirect> kind=noinput
 *   record   <Record>    → callback kind=record; nothing said → <Redirect> kind=recnoinput
 *   transfer <Dial> to the CRM team; nobody available → `fallback_next`
 *   hangup   speak, then end the call
 */

export interface ScriptOption {
  next: string;
  outcome?: string;
  action?: 'opt_out';
}

export interface ScriptStep {
  type: 'say' | 'menu' | 'record' | 'transfer' | 'hangup';
  say?: string;
  play_url?: string;
  next?: string;
  options?: Record<string, ScriptOption>;
  no_input?: { next: string; outcome?: string };
  invalid?: { next: string };
  timeout?: number;
  max_seconds?: number;
  outcome?: string;
  fallback_next?: string;
}

export interface Script {
  voice?: 'woman' | 'man';
  start: string;
  steps: Record<string, ScriptStep>;
}

export type CallbackKind = 'digits' | 'noinput' | 'record' | 'recnoinput';

export interface RenderContext {
  script: Script;
  variables: Record<string, string>;
  /** Builds the absolute callback URL for a step. */
  callbackUrl: (kind: CallbackKind, step: string, tries: number) => string;
  /** Comma-separated E.164 numbers of the live CRM team; empty = no transfer. */
  transferNumbers: string;
  recordTransfers: boolean;
  /** Prepend a terminal <Record/> so the whole call is recorded. */
  recordWholeCall?: boolean;
}

export interface Rendered {
  xml: string;
  /** Step the call is now waiting on (or ended at). */
  step: string;
  /** Outcome set by a step reached on the way, if any. */
  outcome: string | null;
  /** True when this response ends the call. */
  ends: boolean;
  /** True when this response bridges to the live team. */
  transfers: boolean;
}

/** Most steps a single response may chain before we assume a loop. */
const MAX_CHAIN = 12;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `{first_name}` → value; unknown placeholders are dropped, never read aloud. */
export function fillVariables(text: string, vars: Record<string, string>): string {
  return text
    .replace(/\{([a-z_]+)\}/g, (_, k: string) => (vars[k] ?? '').toString())
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function speak(step: ScriptStep, ctx: RenderContext): string {
  if (step.play_url) return `<Play url="${escapeXml(step.play_url)}"/>`;
  if (!step.say) return '';
  const voice = ctx.script.voice === 'man' ? 'man' : 'woman';
  return `<Say voice="${voice}" playBeep="false">${escapeXml(fillVariables(step.say, ctx.variables))}</Say>`;
}

export function wrap(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

export const HANGUP_XML = wrap('<Hangup/>');
export const EMPTY_XML = wrap('');
export const REJECT_XML = wrap('<Reject/>');

/** Render from `startKey`, following say steps until one needs the caller. */
export function renderFrom(startKey: string, ctx: RenderContext, tries = 0, isFirst = false): Rendered {
  let key = startKey;
  let body = isFirst && ctx.recordWholeCall ? '<Record/>' : '';
  let outcome: string | null = null;

  for (let i = 0; i < MAX_CHAIN; i++) {
    const step = ctx.script.steps[key];
    if (!step) {
      return { xml: wrap(`${body}<Hangup/>`), step: key, outcome, ends: true, transfers: false };
    }
    if (step.outcome && step.type !== 'record') outcome = step.outcome;

    switch (step.type) {
      case 'say':
        body += speak(step, ctx);
        key = step.next ?? '';
        continue;

      case 'hangup':
        body += `${speak(step, ctx)}<Hangup/>`;
        return { xml: wrap(body), step: key, outcome, ends: true, transfers: false };

      case 'menu': {
        const timeout = Math.min(Math.max(step.timeout ?? 10, 3), 30);
        const digitsUrl = escapeXml(ctx.callbackUrl('digits', key, tries));
        const noInputUrl = escapeXml(ctx.callbackUrl('noinput', key, tries));
        body += `<GetDigits timeout="${timeout}" numDigits="1" callbackUrl="${digitsUrl}">${speak(step, ctx)}</GetDigits>`;
        body += `<Redirect>${noInputUrl}</Redirect>`;
        return { xml: wrap(body), step: key, outcome, ends: false, transfers: false };
      }

      case 'record': {
        const maxLength = Math.min(Math.max(step.max_seconds ?? 60, 5), 180);
        const recUrl = escapeXml(ctx.callbackUrl('record', key, tries));
        const noRecUrl = escapeXml(ctx.callbackUrl('recnoinput', key, tries));
        body += `<Record finishOnKey="#" maxLength="${maxLength}" trimSilence="true" playBeep="true" callbackUrl="${recUrl}">${speak(step, ctx)}</Record>`;
        body += `<Redirect>${noRecUrl}</Redirect>`;
        return { xml: wrap(body), step: key, outcome, ends: false, transfers: false };
      }

      case 'transfer': {
        const numbers = ctx.transferNumbers.trim();
        if (!numbers) {
          key = step.fallback_next ?? '';
          continue;
        }
        body += `${speak(step, ctx)}<Dial phoneNumbers="${escapeXml(numbers)}" sequential="true"${
          ctx.recordTransfers ? ' record="true"' : ''
        }/>`;
        return { xml: wrap(body), step: key, outcome, ends: false, transfers: true };
      }
    }
  }
  // A say-loop with no exit: end the call rather than spin.
  return { xml: wrap(`${body}<Hangup/>`), step: key, outcome, ends: true, transfers: false };
}

export interface DigitsResult {
  next: string;
  tries: number;
  outcome: string | null;
  action: 'opt_out' | null;
  /** What to log for this press. */
  logged: 'option' | 'invalid' | 'no_input';
}

/** Decide where a key press (or no press) on a menu step goes. */
export function resolveMenu(step: ScriptStep, digits: string | null, tries: number): DigitsResult {
  const pressed = (digits ?? '').trim().slice(0, 1);
  const opt = pressed ? step.options?.[pressed] : undefined;
  if (opt) {
    return { next: opt.next, tries: 0, outcome: opt.outcome ?? null, action: opt.action ?? null, logged: 'option' };
  }
  // A wrong key gets one more chance on the same menu (via `invalid`).
  if (pressed && step.invalid && tries < 1) {
    return { next: step.invalid.next, tries: tries + 1, outcome: null, action: null, logged: 'invalid' };
  }
  const fallback = step.no_input;
  return {
    next: fallback?.next ?? '',
    tries: 0,
    outcome: fallback?.outcome ?? null,
    action: null,
    logged: pressed ? 'invalid' : 'no_input',
  };
}

/** Africa's Talking terminal state → our attempt status. */
export function terminalStatus(
  rawState: string,
  answered: boolean,
  durationSeconds: number,
): 'completed' | 'no_answer' | 'busy' | 'failed' {
  if (answered || durationSeconds > 0) return 'completed';
  switch (rawState.trim().toLowerCase()) {
    case 'busy':
      return 'busy';
    case 'failed':
    case 'aborted':
      return 'failed';
    default:
      return 'no_answer';
  }
}

/** Uganda-aware E.164 normaliser, same rule as crm-place-call. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (/^256[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0[3-9]\d{8}$/.test(digits)) return `+256${digits.slice(1)}`;
  if (/^[3-9]\d{8}$/.test(digits)) return `+256${digits}`;
  return null;
}
