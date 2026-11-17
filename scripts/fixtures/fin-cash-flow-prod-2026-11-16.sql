-- Verbatim production copy (16 Nov 2026, read-only export), md5(prosrc) ec20ae2eb67d17f6a9a9e9938331ea9c.
CREATE OR REPLACE FUNCTION public.fin_cash_flow(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view the statement of cash flows';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'A valid period is required (from < to)';
  END IF;

  WITH ca AS (
    SELECT code, label, restricted FROM public.fin_cash_accounts WHERE included
  ), l AS MATERIALIZED (
    SELECT s.transaction_group_id AS gid, s.account_code, s.category, s.dr, s.cr, s.transaction_date, s.is_legacy_counterpart
    FROM public.sofp_ledger_legs(p_to - interval '1 microsecond') s
  ), cash AS (
    SELECT l.* FROM l JOIN ca ON ca.code = l.account_code
  ), bal AS (
    SELECT COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date < p_from), 0) AS opening,
           COALESCE(SUM(dr - cr), 0) AS closing,
           COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date >= p_from), 0) AS period_net
    FROM cash
  ), by_acct AS (
    SELECT ca.code, ca.label, ca.restricted,
           COALESCE(SUM(c.dr - c.cr) FILTER (WHERE c.transaction_date < p_from), 0) AS opening,
           COALESCE(SUM(c.dr - c.cr), 0) AS closing
    FROM ca LEFT JOIN cash c ON c.account_code = ca.code
    GROUP BY 1, 2, 3
  ), grp_cash AS (
    -- cash effect of each group inside the period
    SELECT gid, SUM(dr - cr) AS cash_effect
    FROM cash WHERE transaction_date >= p_from AND gid IS NOT NULL
    GROUP BY 1
  ), cp AS (
    -- counterpart legs of those groups (any non-cash account); internal cash<->cash moves have none
    -- only legs dated inside the period: a group whose legs carry different dates (e.g. a later reversal)
    -- contributes to each period by its own dates
    SELECT l.gid, l.account_code, l.category, (l.cr - l.dr) AS eff
    FROM l JOIN grp_cash g ON g.gid = l.gid
    WHERE l.account_code NOT IN (SELECT code FROM ca) AND l.transaction_date >= p_from
  ), mapped AS (
    SELECT cp.eff,
           COALESCE(m1.section, m2.section, m3.section, 'operating') AS section,
           COALESCE(m1.group_label, m2.group_label, m3.group_label, 'Unclassified') AS group_label,
           COALESCE(m1.group_sort, m2.group_sort, m3.group_sort, 99) AS group_sort,
           CASE WHEN cp.eff >= 0 THEN COALESCE(m1.line_in, m2.line_in, m3.line_in, 'Unclassified inflows (' || cp.account_code || ')')
                ELSE COALESCE(m1.line_out, m2.line_out, m3.line_out, 'Unclassified outflows (' || cp.account_code || ')') END AS line,
           COALESCE(m1.sort, m2.sort, m3.sort, 900) + CASE WHEN cp.eff >= 0 THEN 0 ELSE 1 END AS sort
    FROM cp
    LEFT JOIN public.fin_cash_flow_map m1 ON m1.account_code = cp.account_code AND m1.category = cp.category
    LEFT JOIN public.fin_cash_flow_map m2 ON m2.account_code = cp.account_code AND m2.category IS NULL
    LEFT JOIN public.fin_cash_flow_map m3 ON m3.account_code IS NULL AND m3.category = cp.category
  ), lines AS (
    SELECT section, group_label, MIN(group_sort) AS group_sort, line, MIN(sort) AS sort, SUM(eff) AS amount
    FROM mapped GROUP BY section, group_label, line
  ), grouped AS (
    SELECT section, group_label, MIN(group_sort) AS group_sort, SUM(amount) AS total,
           jsonb_agg(jsonb_build_object('label', line, 'amount', ROUND(amount)) ORDER BY sort, line) AS lines
    FROM lines GROUP BY section, group_label
  ), sections AS (
    SELECT section, SUM(total) AS total,
           jsonb_agg(jsonb_build_object('label', group_label, 'total', ROUND(total), 'lines', lines) ORDER BY group_sort, group_label) AS groups
    FROM grouped GROUP BY section
  ), explained AS (
    SELECT COALESCE(SUM(amount), 0) AS total FROM lines
  ), unexplained AS (
    -- groups whose counterparts do not account for their cash effect (one-sided or unbalanced after mapping)
    SELECT g.gid, g.cash_effect, COALESCE(SUM(cp.eff), 0) AS counterpart, g.cash_effect - COALESCE(SUM(cp.eff), 0) AS gap
    FROM grp_cash g LEFT JOIN cp ON cp.gid = g.gid
    GROUP BY g.gid, g.cash_effect
    HAVING abs(g.cash_effect - COALESCE(SUM(cp.eff), 0)) > 0.5
  ), ungrouped AS (
    -- cash legs without a group id (cannot be explained by counterparts)
    SELECT COALESCE(SUM(dr - cr), 0) AS amount FROM cash WHERE transaction_date >= p_from AND gid IS NULL
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'currency', 'UGX', 'engine', 'fin_cash_flow',
    'cash_definition', 'Cash and cash equivalents = ' || (SELECT string_agg(code || ' ' || label, '; ' ORDER BY code) FROM ca)
      || '. Agent float (A2) is a company asset with agents, shown as an operating movement, not as cash (provisional, CFO decision D2). '
      || 'Internal moves between these accounts are eliminated. No balancing line: any unexplained difference is reported below with its ledger groups.',
    'operating', COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'groups', groups) FROM sections WHERE section = 'operating'), jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
    'investing', COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'groups', groups) FROM sections WHERE section = 'investing'), jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
    'financing', COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'groups', groups) FROM sections WHERE section = 'financing'), jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
    'exchange_rate_effect', 0,
    'net_change', ROUND((SELECT period_net FROM bal)),
    'explained_net_change', ROUND((SELECT total FROM explained)),
    'opening_cash', ROUND((SELECT opening FROM bal)),
    'closing_cash', ROUND((SELECT closing FROM bal)),
    'cash_accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', code, 'label', label, 'restricted', restricted,
                                  'opening', ROUND(opening), 'closing', ROUND(closing)) ORDER BY code) FROM by_acct), '[]'::jsonb),
    'balance_sheet_cash', ROUND(COALESCE((SELECT SUM(closing) FROM by_acct), 0)),
    'ties_to_balance_sheet', abs((SELECT closing FROM bal) - COALESCE((SELECT SUM(closing) FROM by_acct), 0)) < 1,
    'unreconciled_residual', ROUND((SELECT period_net FROM bal) - (SELECT total FROM explained)),
    'unexplained_difference', ROUND((SELECT period_net FROM bal) - (SELECT total FROM explained)),
    'unexplained_groups_count', (SELECT COUNT(*) FROM unexplained),
    'unexplained_ungrouped_amount', ROUND((SELECT amount FROM ungrouped)),
    'unexplained_groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('group', gid, 'cash_effect', ROUND(cash_effect), 'counterparts', ROUND(counterpart), 'gap', ROUND(gap)) ORDER BY abs(gap) DESC)
                                     FROM (SELECT * FROM unexplained ORDER BY abs(gap) DESC LIMIT 25) u), '[]'::jsonb),
    'reconciles', abs((SELECT opening FROM bal) + (SELECT total FROM explained) - (SELECT closing FROM bal)) < 1
  ) INTO v_out;
  RETURN v_out;
END;
$function$
;
