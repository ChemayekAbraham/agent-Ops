/**
 * Africa's Talking browser voice client — ONE instance for the whole app.
 *
 * Why a module-level singleton and not React state: the SDK opens a WebSocket +
 * WebRTC peer connection when constructed. Re-constructing it on a rerender
 * would drop the live call, so the client is created once per capability token
 * and handed out to whoever asks.
 *
 * The capability token is short-lived and comes from the
 * `crm-voice-capability-token` edge function. The Africa's Talking API key never
 * reaches this file.
 */
// The SDK is a UMD bundle with no types.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- no bundled type declarations
import Africastalking from 'africastalking-client';

/** Events the SDK emits. `hangup` is the one that ends a live call. */
export type AtVoiceEvent =
  | 'ready'
  | 'notready'
  | 'calling'
  | 'callaccepted'
  | 'hangup'
  | 'offline'
  | 'closed'
  | 'incomingcall';

const EVENTS: AtVoiceEvent[] = [
  'ready',
  'notready',
  'calling',
  'callaccepted',
  'hangup',
  'offline',
  'closed',
  'incomingcall',
];

export interface AtHangupPayload {
  /** Africa's Talking numeric hangup code, when supplied. */
  code?: number | string;
  /** e.g. NORMAL_CLEARING, USER_BUSY, NO_ANSWER. */
  reason?: string;
}

interface RawClient {
  call: (destination: string) => void;
  hangup: () => void;
  answer?: () => void;
  muteAudio?: () => void;
  unmuteAudio?: () => void;
  hold?: () => void;
  unhold?: () => void;
  dtmf?: (digits: string) => void;
  on: (event: string, handler: (payload: unknown) => void, capture?: boolean) => void;
}

type Listener = (payload: unknown) => void;

let client: RawClient | null = null;
let clientToken: string | null = null;
const listeners = new Map<AtVoiceEvent, Set<Listener>>();

function emit(event: AtVoiceEvent, payload: unknown) {
  listeners.get(event)?.forEach((fn) => {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[atVoice] listener for "${event}" threw`, err);
    }
  });
}

/**
 * Subscribe to a client event. Subscriptions survive client re-creation, so a
 * token refresh never silently detaches the hangup handler.
 */
export function onVoiceEvent(event: AtVoiceEvent, handler: Listener): () => void {
  const set = listeners.get(event) ?? new Set<Listener>();
  set.add(handler);
  listeners.set(event, set);
  return () => {
    set.delete(handler);
  };
}

/**
 * Get (or lazily build) the single client for this capability token.
 *
 * Passing the same token returns the existing instance — the live call is never
 * torn down by a rerender.
 */
export function getVoiceClient(capabilityToken: string): RawClient {
  if (client && clientToken === capabilityToken) return client;

  // A new token means the old registration is stale; replace it.
  const Ctor = (Africastalking as { Client: new (token: string) => RawClient }).Client;
  const next = new Ctor(capabilityToken);

  EVENTS.forEach((event) => {
    next.on(event, (payload: unknown) => emit(event, payload), false);
  });

  client = next;
  clientToken = capabilityToken;
  return next;
}

/** The current client, if one has been built. Never constructs. */
export function peekVoiceClient(): RawClient | null {
  return client;
}

/**
 * Terminate the live call for real. This is the ONLY hang-up path in the CRM:
 * it invokes the SDK's own `hangup()` on the active WebRTC leg.
 */
export function hangupVoiceCall(): boolean {
  if (!client) return false;
  try {
    client.hangup();
    return true;
  } catch (err) {
    console.error('[atVoice] hangup failed', err);
    return false;
  }
}

export function muteVoiceCall(mute: boolean): boolean {
  if (!client) return false;
  try {
    if (mute) client.muteAudio?.();
    else client.unmuteAudio?.();
    return true;
  } catch (err) {
    console.error('[atVoice] mute toggle failed', err);
    return false;
  }
}

/** Uganda-aware E.164 normaliser. Returns `+256…`, or null when unusable. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  // Already international and plausible — leave it alone.
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (/^256[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0[3-9]\d{8}$/.test(digits)) return `+256${digits.slice(1)}`;
  if (/^[3-9]\d{8}$/.test(digits)) return `+256${digits}`;
  return null;
}

/** Read the hangup payload the SDK gives us without assuming its shape. */
export function readHangupCause(payload: unknown): { code: string | null; reason: string | null } {
  if (!payload) return { code: null, reason: null };
  if (typeof payload === 'string') return { code: null, reason: payload.toUpperCase() };
  const obj = payload as AtHangupPayload & { hangupCause?: string };
  const reason = obj.reason ?? obj.hangupCause ?? null;
  return {
    code: obj.code != null ? String(obj.code) : null,
    reason: reason ? String(reason).toUpperCase() : null,
  };
}
