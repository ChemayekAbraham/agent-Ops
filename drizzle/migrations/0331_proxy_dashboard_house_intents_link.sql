CREATE OR REPLACE FUNCTION public.get_proxy_agent_performance_dashboard(p_agent_id uuid DEFAULT NULL::uuid, p_range text DEFAULT '7d'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := proxy_cc_resolve_agent(p_agent_id);
  v_now timestamptz := now();
  v_today date := (v_now AT TIME ZONE 'Africa/Kampala')::date;
  v_day_start timestamptz := v_today::timestamp AT TIME ZONE 'Africa/Kampala';
  v_week_date date := date_trunc('week', v_today::timestamp)::date;
  v_week_start timestamptz := v_week_date::timestamp AT TIME ZONE 'Africa/Kampala';
  v_from date;
  v_cfg jsonb;
  v_daily int; v_weekly int;
  v_rate numeric;
  v_notes jsonb; v_comm jsonb; v_series jsonb; v_recent jsonb;
  v_pending_unpaid int;
BEGIN
  v_from := CASE p_range
    WHEN '30d' THEN v_today - 29
    WHEN 'month' THEN date_trunc('month', v_today::timestamp)::date
    ELSE v_today - 6 END;

  SELECT value INTO v_cfg FROM system_config WHERE key = 'proxy_note_targets';
  SELECT daily_note_target, weekly_note_target INTO v_daily, v_weekly FROM proxy_agent_targets WHERE agent_id = v_agent;
  v_daily := COALESCE(v_daily, (v_cfg->>'daily')::int, 10);
  v_weekly := COALESCE(v_weekly, (v_cfg->>'weekly')::int, 50);
  v_rate := COALESCE(partner_note_rate('agent', v_now), 0);

  WITH n AS (
    SELECT status, amount, created_at, approval_bonus_paid,
           CASE WHEN status = 'activated' THEN COALESCE(approved_at, updated_at) END AS brought_in_at
      FROM promissory_notes WHERE agent_id = v_agent
  )
  SELECT jsonb_build_object(
      'created', COUNT(*),
      'brought_in', COUNT(*) FILTER (WHERE status = 'activated'),
      'pending', COUNT(*) FILTER (WHERE status = 'pending'),
      'other', COUNT(*) FILTER (WHERE status NOT IN ('pending','activated')),
      'brought_in_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'activated'),0),
      'pending_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'),0),
      'created_today', COUNT(*) FILTER (WHERE created_at >= v_day_start),
      'brought_in_today', COUNT(*) FILTER (WHERE brought_in_at >= v_day_start),
      'brought_in_amount_today', COALESCE(SUM(amount) FILTER (WHERE brought_in_at >= v_day_start),0),
      'created_this_week', COUNT(*) FILTER (WHERE created_at >= v_week_start)
    ),
    COUNT(*) FILTER (WHERE status = 'pending' AND NOT COALESCE(approval_bonus_paid,false))
  INTO v_notes, v_pending_unpaid FROM n;

  SELECT jsonb_build_object(
      'earned', COALESCE(SUM(amount),0),
      'notes', COALESCE(SUM(amount) FILTER (WHERE category = 'agent_commission'),0),
      'initial_support', COALESCE(SUM(amount) FILTER (WHERE category IN ('proxy_investment_commission','agent_investment_commission')),0),
      'top_ups', COALESCE(SUM(amount) FILTER (WHERE category = 'partner_commission'),0),
      'today', COALESCE(SUM(amount) FILTER (WHERE transaction_date >= v_day_start),0)
    ) INTO v_comm
    FROM general_ledger
   WHERE user_id = v_agent AND direction = 'cash_in' AND ledger_scope = 'wallet'
     AND classification <> 'admin_correction'
     AND (category IN ('proxy_investment_commission','agent_investment_commission','partner_commission')
          OR (category = 'agent_commission' AND source_table = 'promissory_notes'));

  v_comm := v_comm || jsonb_build_object(
    'pending', v_pending_unpaid * v_rate,
    'pending_notes', v_pending_unpaid,
    'note_rate', v_rate,
    'initial_support_pct', 2,
    'top_up_pct', 1);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', d, 'brought_in', bi, 'pending', pe) ORDER BY d), '[]'::jsonb)
    INTO v_series
    FROM (
      SELECT g.d::date AS d,
        (SELECT COUNT(*) FROM promissory_notes p WHERE p.agent_id = v_agent AND p.status = 'activated'
            AND (COALESCE(p.approved_at, p.updated_at) AT TIME ZONE 'Africa/Kampala')::date = g.d::date) AS bi,
        (SELECT COUNT(*) FROM promissory_notes p WHERE p.agent_id = v_agent AND p.status = 'pending'
            AND (p.created_at AT TIME ZONE 'Africa/Kampala')::date = g.d::date) AS pe
      FROM generate_series(v_from, v_today, interval '1 day') g(d)
    ) s;

  SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'created_at') DESC), '[]'::jsonb) INTO v_recent
    FROM (
      SELECT jsonb_build_object(
        'id', p.id,
        'partner_name', COALESCE(pp.full_name, p.partner_name),
        'amount', p.amount,
        'status', p.status,
        'created_at', p.created_at,
        'brought_in_at', CASE WHEN p.status='activated' THEN COALESCE(p.approved_at, p.updated_at) END,
        'house_count', (SELECT COUNT(*) FROM promissory_note_house_intents h WHERE h.note_id = p.id),
        'commission', CASE WHEN p.approval_bonus_paid THEN v_rate ELSE 0 END
      ) AS r
      FROM promissory_notes p LEFT JOIN profiles pp ON pp.id = p.partner_user_id
      WHERE p.agent_id = v_agent
      ORDER BY p.created_at DESC LIMIT 8
    ) x;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'generated_at', v_now,
    'today', v_today,
    'notes', v_notes,
    'commission', v_comm,
    'targets', jsonb_build_object(
      'daily', v_daily, 'weekly', v_weekly,
      'week_start', v_week_date,
      'days_remaining', 6 - (v_today - v_week_date)),
    'series', v_series,
    'recent', v_recent
  );
END; $function$;