INSERT INTO public.agent_collections (
  agent_id, tenant_id, rent_request_id, amount, payment_method,
  float_before, float_after, tracking_id, notes, created_at
)
SELECT
  gl.user_id,
  rr.tenant_id,
  gl.source_id,
  gl.amount,
  'cash'::collection_payment_method,
  0,
  0,
  'AGT-BF' || substr(gl.id::text, 1, 6),
  'Backfilled from ledger (capacity fix)',
  gl.created_at
FROM public.general_ledger gl
JOIN public.rent_requests rr ON rr.id = gl.source_id
WHERE gl.category = 'rent_payment_for_tenant'
  AND gl.ledger_scope = 'wallet'
  AND (gl.created_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date
  AND NOT EXISTS (
    SELECT 1 FROM public.agent_collections ac
    WHERE ac.agent_id = gl.user_id
      AND ac.rent_request_id = gl.source_id
      AND ac.amount = gl.amount
      AND ac.created_at = gl.created_at
  );