-- Rent collection allocation: serialise per agent, lock the Rent Plan once,
-- and fail fast on lock waits (3s) instead of hitting the 8s statement
-- timeout. Body is patched in place; every replacement is asserted.
DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.agent_allocate_tenant_payment_internal(uuid,uuid,uuid,numeric,text,uuid)'::regprocedure);
  v_new text;
  v_a text := $a$  INSERT INTO public.wallets_physical (user_id) VALUES (p_agent_id) ON CONFLICT (user_id) DO NOTHING;$a$;
  v_b text := $b$    FROM public.rent_requests rr
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;$b$;
BEGIN
  IF position(v_a in v_def) = 0 OR position(v_b in v_def) = 0 THEN
    RAISE EXCEPTION 'allocation patch: anchor text not found, nothing changed';
  END IF;
  IF position('agent_float_alloc:' in v_def) > 0 THEN
    RAISE NOTICE 'already patched'; RETURN;
  END IF;
  v_new := replace(v_def, v_a,
$r$  -- Fail fast on contended rows (weak-network retries / peak hours) with a
  -- retryable 55P03 instead of an 8s statement timeout. Transaction-scoped.
  PERFORM set_config('lock_timeout', '3s', true);
  -- One allocation per agent at a time, taken BEFORE the float is read, so
  -- float check, TID-backed lock and ledger legs always see one consistent
  -- state and lock order is fixed: agent -> Rent Plan -> ledger/wallets.
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_float_alloc:' || p_agent_id::text, 0));
  -- Lock the Rent Plan row up front (single lock point, fixed order).
  PERFORM 1 FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;

$r$ || v_a);
  v_new := replace(v_new, v_b, replace(v_b, 'WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;',
                   'WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;'));
  EXECUTE v_new;
END
$mig$;