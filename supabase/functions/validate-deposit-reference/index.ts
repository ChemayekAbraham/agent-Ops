// Pre-flight validator that mirrors the `guard_deposit_reference_uniqueness`
// Postgres trigger (see public.guard_deposit_reference_uniqueness). The UI
// calls this on debounced TID input + as a final guard on submit so the user
// gets the same outcome the DB would return — without a duplicate insert
// ever hitting the trigger.
//
// Source-of-truth rules implemented here (1:1 with the trigger):
//   1. Trim + null-coerce the reference. Empty -> placeholder.
//   2. Uppercase placeholder set: NONE, N/A, NA, PENDING, TBD, UNKNOWN.
//   3. Conflict if any other deposit_requests row has the same
//      UPPER(TRIM(transaction_id)).
//   4. Conflict if any other deposit_requests row has the reference embedded
//      (case-insensitive substring) in `notes` (covers pasted SMS receipts).
//
// Returns 200 in all validation outcomes. 400 only on malformed body, 401
// on bad/missing JWT, 500 on unexpected errors.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PLACEHOLDERS = new Set(['NONE', 'N/A', 'NA', 'PENDING', 'TBD', 'UNKNOWN']);

type Reason =
  | 'ok'
  | 'placeholder'
  | 'duplicate_transaction_id'
  | 'duplicate_in_notes';

interface Result {
  valid: boolean;
  reason: Reason;
  message: string;
  conflict:
    | { deposit_id: string; status: string; matched_field: 'transaction_id' | 'notes' }
    | null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Auth — in-code JWT validation (project convention).
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.slice('Bearer '.length);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Parse body
  let body: { transaction_id?: unknown; exclude_deposit_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed JSON body' }, 400);
  }
  const rawRef = typeof body.transaction_id === 'string' ? body.transaction_id : '';
  const excludeId =
    typeof body.exclude_deposit_id === 'string' && body.exclude_deposit_id.length > 0
      ? body.exclude_deposit_id
      : null;

  const ref = rawRef.trim();
  if (!ref) {
    const result: Result = {
      valid: true,
      reason: 'placeholder',
      message: 'Empty reference — nothing to validate yet.',
      conflict: null,
    };
    return json(result);
  }

  const upperRef = ref.toUpperCase();
  if (PLACEHOLDERS.has(upperRef)) {
    const result: Result = {
      valid: true,
      reason: 'placeholder',
      message: `Reference "${ref}" is a placeholder and is exempt from uniqueness.`,
      conflict: null,
    };
    return json(result);
  }

  try {
    // 3a) Same transaction_id (case-insensitive)
    const tidQuery = adminClient
      .from('deposit_requests')
      .select('id, status')
      .ilike('transaction_id', ref)
      .limit(1);
    if (excludeId) tidQuery.neq('id', excludeId);
    const { data: tidMatch, error: tidErr } = await tidQuery;
    if (tidErr) throw tidErr;
    if (tidMatch && tidMatch.length > 0) {
      const row = tidMatch[0] as { id: string; status: string };
      const result: Result = {
        valid: false,
        reason: 'duplicate_transaction_id',
        message: `Reference ${ref} is already reconciled on deposit ${row.id} (status: ${row.status}). Each receipt/reference can only be matched once.`,
        conflict: { deposit_id: row.id, status: row.status, matched_field: 'transaction_id' },
      };
      return json(result);
    }

    // 3b) Reference embedded in another deposit's notes (pasted receipts)
    const notesQuery = adminClient
      .from('deposit_requests')
      .select('id, status')
      .ilike('notes', `%${ref}%`)
      .limit(1);
    if (excludeId) notesQuery.neq('id', excludeId);
    const { data: notesMatch, error: notesErr } = await notesQuery;
    if (notesErr) throw notesErr;
    if (notesMatch && notesMatch.length > 0) {
      const row = notesMatch[0] as { id: string; status: string };
      const result: Result = {
        valid: false,
        reason: 'duplicate_in_notes',
        message: `Reference ${ref} already appears on deposit ${row.id} (status: ${row.status}) via its receipt notes. Each receipt/reference can only be matched once.`,
        conflict: { deposit_id: row.id, status: row.status, matched_field: 'notes' },
      };
      return json(result);
    }

    const result: Result = {
      valid: true,
      reason: 'ok',
      message: 'Reference is unique and safe to submit.',
      conflict: null,
    };
    return json(result);
  } catch (e) {
    console.error('[validate-deposit-reference] failed', e);
    return json({ error: (e as Error).message ?? 'Internal error' }, 500);
  }
});
