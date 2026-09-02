-- Pending (not-yet-scored) activity feed for the proxy PV dashboard.
-- Mirrors the data_quality predicates in get_proxy_agent_pv so the feed can
-- never disagree with the score: unactivated promissory notes and unpaid
-- commission events for the month.
CREATE OR REPLACE FUNCTION public.get_proxy_agent_pv_pending_feed(p_agent_id uuid DEFAULT NULL::uuid, p_month date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := public.proxy_cc_resolve_agent(p_agent_id);
  v_month date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date;
  v_rate numeric := COALESCE(public.partner_note_rate('agent', now()), 1500);
  v_items jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'day') DESC), '[]'::jsonb)
    INTO v_items
    FROM (
      -- Commitments awaiting verification/activation
      SELECT jsonb_build_object(
               'kind', 'commitments',
               'day', (COALESCE(pn.approved_at, pn.updated_at) AT TIME ZONE 'Africa/Kampala')::date,
               'reference', pn.id,
               'label', COALESCE(NULLIF(pn.partner_name, ''), 'Promissory note'),
               'amount', COALESCE(pn.amount, 0),
               'status', pn.status,
               'potential_pv', v_rate,
               'gate', 'Counts once Partner Ops verifies and activates it'
             ) AS item
        FROM public.promissory_notes pn
       WHERE pn.agent_id = v_agent
         AND pn.status <> 'activated'
         AND (COALESCE(pn.approved_at, pn.updated_at) AT TIME ZONE 'Africa/Kampala')::date
             BETWEEN v_month AND (v_month + interval '1 month - 1 day')::date

      UNION ALL

      -- Commission events awaiting payment (new investments and top-ups)
      SELECT jsonb_build_object(
               'kind', CASE WHEN e.kind = 'portfolio_creation' THEN 'investment' ELSE 'topups' END,
               'day', (e.created_at AT TIME ZONE 'Africa/Kampala')::date,
               'reference', e.id,
               'label', CASE WHEN e.kind = 'portfolio_creation' THEN 'New partner investment' ELSE 'Partner top-up' END,
               'amount', COALESCE(e.base_amount, 0),
               'status', e.status,
               'potential_pv', ROUND(COALESCE(e.base_amount, 0) * COALESCE(e.rate, 0) / 100),
               'gate', 'Counts once the commission is paid'
             )
        FROM public.promissory_commission_events e
       WHERE e.agent_id = v_agent
         AND e.status <> 'paid'
         AND e.kind IN ('portfolio_creation','portfolio_topup')
         AND (e.created_at AT TIME ZONE 'Africa/Kampala')::date
             BETWEEN v_month AND (v_month + interval '1 month - 1 day')::date
    ) item;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'period_month', v_month,
    'generated_at', now(),
    'items', v_items
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_proxy_agent_pv_pending_feed(uuid, date) TO authenticated;