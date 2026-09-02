CREATE OR REPLACE FUNCTION public.proxy_pv_fmt_pct(p_rate numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT rtrim(rtrim(to_char(COALESCE(p_rate, 0) * 100, 'FM999990.99'), '0'), '.') || '%';
$$;

REVOKE ALL ON FUNCTION public.proxy_pv_fmt_pct(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.proxy_pv_fmt_pct(numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_proxy_agent_pv_activity(
  p_agent_id uuid DEFAULT NULL,
  p_day date DEFAULT NULL,
  p_kind text DEFAULT 'commitments'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_agent uuid := public.proxy_cc_resolve_agent(p_agent_id);
  v_day date := COALESCE(p_day, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_kind text := lower(COALESCE(p_kind, 'commitments'));
  v_rate numeric := COALESCE(public.partner_note_rate('agent', now()), 1500);
  v_items jsonb := '[]'::jsonb;
  v_counted_pv numeric := 0;
  v_pending_pv numeric := 0;
  v_counted int := 0;
  v_pending int := 0;
  v_basis numeric := 0;
  v_pct numeric;
  v_ev_kind text;
BEGIN
  IF v_kind NOT IN ('commitments', 'investment', 'topups') THEN
    RAISE EXCEPTION 'unsupported activity kind: %', v_kind;
  END IF;

  IF v_kind = 'commitments' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'occurred_at' DESC), '[]'::jsonb),
           COALESCE(SUM((x->>'pv')::numeric) FILTER (WHERE (x->>'counted')::boolean), 0),
           COUNT(*) FILTER (WHERE (x->>'counted')::boolean),
           COUNT(*) FILTER (WHERE NOT (x->>'counted')::boolean),
           COALESCE(SUM((x->>'amount')::numeric) FILTER (WHERE (x->>'counted')::boolean), 0)
      INTO v_items, v_counted_pv, v_counted, v_pending, v_basis
      FROM (
        SELECT jsonb_build_object(
                 'id', pn.id,
                 'reference', 'NOTE-' || left(pn.id::text, 8),
                 'party', COALESCE(NULLIF(btrim(pn.partner_name), ''), 'Unnamed partner'),
                 'contact', COALESCE(pn.phone_number, pn.whatsapp_number, pn.email),
                 'amount', COALESCE(pn.amount, 0),
                 'status', pn.status,
                 'verified', pn.status = 'activated',
                 'counted', pn.status = 'activated',
                 'verification_label', CASE WHEN pn.status = 'activated'
                                            THEN 'Verified and activated by Partner Ops'
                                            ELSE 'Awaiting Partner Ops verification' END,
                 'verified_at', pn.approved_at,
                 'verified_by', (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = pn.approved_by),
                 'recorded_at', pn.created_at,
                 'occurred_at', COALESCE(pn.approved_at, pn.updated_at),
                 'contribution_type', pn.contribution_type,
                 'pv', CASE WHEN pn.status = 'activated' THEN v_rate ELSE 0 END,
                 'pv_formula', '1 verified commitment x ' || to_char(v_rate, 'FM999,999,999') || ' PV'
               ) AS x
          FROM public.promissory_notes pn
         WHERE pn.agent_id = v_agent
           AND (COALESCE(pn.approved_at, pn.updated_at) AT TIME ZONE 'Africa/Kampala')::date = v_day
      ) s;

    v_pending_pv := v_pending * v_rate;
    v_pct := NULL;
  ELSE
    v_ev_kind := CASE WHEN v_kind = 'investment' THEN 'portfolio_creation' ELSE 'portfolio_topup' END;

    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'occurred_at' DESC), '[]'::jsonb),
           COALESCE(SUM((x->>'pv')::numeric) FILTER (WHERE (x->>'counted')::boolean), 0),
           COALESCE(SUM((x->>'pv')::numeric) FILTER (WHERE NOT (x->>'counted')::boolean), 0),
           COUNT(*) FILTER (WHERE (x->>'counted')::boolean),
           COUNT(*) FILTER (WHERE NOT (x->>'counted')::boolean),
           COALESCE(SUM((x->>'amount')::numeric) FILTER (WHERE (x->>'counted')::boolean), 0)
      INTO v_items, v_counted_pv, v_pending_pv, v_counted, v_pending, v_basis
      FROM (
        SELECT jsonb_build_object(
                 'id', e.id,
                 'reference', 'PCE-' || left(e.id::text, 8),
                 'party', COALESCE(
                            (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = e.partner_id),
                            (SELECT NULLIF(btrim(pn.partner_name), '') FROM public.promissory_notes pn WHERE pn.id = e.note_id),
                            'Partner'),
                 'amount', COALESCE(e.base_amount, 0),
                 'rate', e.rate,
                 'status', e.status,
                 'verified', e.status = 'paid',
                 'counted', e.status = 'paid',
                 'verification_label', CASE WHEN e.status = 'paid' THEN 'Commission paid - counted'
                                            WHEN e.status = 'skipped' THEN COALESCE('Skipped: ' || e.skip_reason, 'Skipped')
                                            WHEN e.error_message IS NOT NULL THEN 'Failed: ' || e.error_message
                                            ELSE 'Commission not yet paid - not counted' END,
                 'occurred_at', e.created_at,
                 'recorded_at', e.created_at,
                 'source', e.source_table,
                 'ledger_group_id', e.ledger_group_id,
                 'pv', COALESCE(e.base_amount, 0) * COALESCE(e.rate, 0),
                 'pv_formula', to_char(COALESCE(e.base_amount, 0), 'FM999,999,999') || ' x '
                               || public.proxy_pv_fmt_pct(e.rate)
               ) AS x
          FROM public.promissory_commission_events e
         WHERE e.agent_id = v_agent
           AND e.kind = v_ev_kind
           AND (e.created_at AT TIME ZONE 'Africa/Kampala')::date = v_day
      ) s;

    SELECT MAX(e.rate) INTO v_pct
      FROM public.promissory_commission_events e
     WHERE e.agent_id = v_agent AND e.kind = v_ev_kind
       AND (e.created_at AT TIME ZONE 'Africa/Kampala')::date = v_day;
    v_pct := COALESCE(v_pct, CASE WHEN v_kind = 'investment' THEN 0.02 ELSE 0.01 END);
  END IF;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'day', v_day,
    'kind', v_kind,
    'generated_at', now(),
    'scoring', jsonb_build_object(
      'commitment_pv_rate', CASE WHEN v_kind = 'commitments' THEN v_rate ELSE NULL END,
      'percentage_rate', v_pct,
      'counted_items', v_counted,
      'pending_items', v_pending,
      'counted_basis', v_basis,
      'counted_pv', v_counted_pv,
      'pending_pv', v_pending_pv,
      'formula', CASE
                   WHEN v_kind = 'commitments'
                     THEN v_counted || ' verified x ' || to_char(v_rate, 'FM999,999,999') || ' PV = '
                          || to_char(v_counted_pv, 'FM999,999,999') || ' PV'
                   ELSE to_char(v_basis, 'FM999,999,999') || ' paid basis x '
                        || public.proxy_pv_fmt_pct(v_pct) || ' = '
                        || to_char(v_counted_pv, 'FM999,999,999') || ' PV'
                 END,
      'gate', CASE WHEN v_kind = 'commitments'
                   THEN 'Only promissory notes with status activated are scored.'
                   ELSE 'Only commission events with status paid are scored.' END
    ),
    'items', v_items
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_proxy_agent_pv_activity(uuid, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_proxy_agent_pv_activity(uuid, date, text) TO authenticated, service_role;