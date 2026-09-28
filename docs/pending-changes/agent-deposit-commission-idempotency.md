# Agent-deposit retry: commission idempotency (STAGED, NOT APPLIED)

Status: draft only. Not applied to `supabase/functions/agent-deposit/index.ts`
because edits to edge functions deploy live. Apply only on explicit authorisation.

## Confirmed defect (read-only trace, 2026-09-29)

- `agent-deposit/index.ts:493` builds the commission event reference as
  `agent-deposit-${rentRequestId}-${Date.now()}`.
- `credit_agent_rent_commission(p_rent_request_id, p_repayment_amount, p_tenant_id, p_event_reference_id)`
  de-duplicates on that reference (`commission_accrual_ledger.source_id = v_idem_key`, per agent and role).
- A retried request therefore gets a new reference and pays commission again.
- The same request also passes `p_source_id: crypto.randomUUID()` to
  `record_rent_request_repayment_v2`, so the accounting split is not de-duplicated either.

## Proposed change

1. Clients send `idempotency_key` (UUID) per business event. `AgentDepositDialog` and
   `AgentTopUpTenantDialog` already have `useIdempotentSubmit`, which keeps the same key
   across retries and rotates it only after success.
2. `agent-deposit` validates it (UUID, optional) and derives:
   - commission reference: `agent-deposit-${rentRequestId}-${idempotency_key}`
   - waterfall source id: `idempotency_key`
3. Without a key, the current behaviour is kept, so older app versions are not blocked.
   Retry protection applies only to requests that carry the key.

```diff
- const { user_id: rawUserId, amount: rawAmount, user_phone: rawPhone } = body as Record<string, unknown>;
+ const { user_id: rawUserId, amount: rawAmount, user_phone: rawPhone, idempotency_key: rawKey } = body as Record<string, unknown>;
+ const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
+ if (rawKey !== undefined && (typeof rawKey !== 'string' || !UUID_RE.test(rawKey))) {
+   return new Response(JSON.stringify({ error: 'idempotency_key must be a UUID' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
+ }
+ const eventKey = typeof rawKey === 'string' ? rawKey.toLowerCase() : null;
...
-               p_source_id: crypto.randomUUID(),
+               p_source_id: eventKey ?? crypto.randomUUID(),
...
- const commissionEventRef = `agent-deposit-${activeRentRequest.id}-${Date.now()}`;
+ const commissionEventRef = eventKey
+   ? `agent-deposit-${activeRentRequest.id}-${eventKey}`
+   : `agent-deposit-${activeRentRequest.id}-${Date.now()}`;
```

## Known limit

This stops a second commission payment and a second accounting split. The deposit's
other ledger writes in the same request (agent and tenant legs, landlord overflow) are
still keyed on `Date.now()`. A full request-level dedupe needs a request-key table and
is a separate change.
