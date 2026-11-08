// Maps an activate_promissory_note RPC error to the HTTP answer the activation page shows.
// Pure (no I/O) so it can be unit-tested. Checked in this order (Phase 4 design v2, section 3.4.1):
// session problems first, then the RPC's own error prefixes, then the anon-key "permission denied"
// (no session), then lock/serialization races; anything else is a generic 500 with no raw message.

export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
}

export interface MappedError {
  status: number;
  body: { error: string; code: string };
}

const SIGN_IN = 'Please sign in to activate this note';

export function mapError(error: RpcErrorLike | null | undefined): MappedError {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');

  if (message.startsWith('AUTH_REQUIRED') || code === 'PGRST301' || code === 'PGRST302' || message.includes('JWT')) {
    return { status: 401, body: { error: SIGN_IN, code: 'AUTH_REQUIRED' } };
  }
  if (message.startsWith('NOTE_NOT_FOUND')) {
    return { status: 404, body: { error: 'Note not found', code: 'NOTE_NOT_FOUND' } };
  }
  if (message.startsWith('NOTE_LINKED_ELSEWHERE')) {
    return { status: 403, body: { error: 'This note is already linked to another account', code: 'NOTE_LINKED_ELSEWHERE' } };
  }
  if (message.startsWith('NOTE_CONTACT_MISMATCH')) {
    return {
      status: 403,
      body: {
        error: 'This note was written for another phone number or email. Partner Ops can link it for you.',
        code: 'NOTE_CONTACT_MISMATCH',
      },
    };
  }
  if (message.startsWith('NOTE_NOT_OPEN')) {
    const m = /already\s+([A-Za-z_]+)/.exec(message);
    const status = m ? m[1] : 'closed';
    return { status: 400, body: { error: `Note is already ${status}`, code: 'NOTE_NOT_OPEN' } };
  }
  if (code === '42501' && message.includes('permission denied for function')) {
    // The anon key reached the RPC (no session): signing in fixes it.
    return { status: 401, body: { error: SIGN_IN, code: 'AUTH_REQUIRED' } };
  }
  if (code === '55P03' || code === '40001' || code === '40P01') {
    return {
      status: 409,
      body: { error: 'This note changed while you were activating it. Please open the link again.', code: 'NOTE_CHANGED' },
    };
  }
  return { status: 500, body: { error: 'Activation failed. Please try again.', code: 'ACTIVATION_FAILED' } };
}
