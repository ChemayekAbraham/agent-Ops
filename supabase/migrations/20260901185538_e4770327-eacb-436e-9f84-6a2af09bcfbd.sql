-- Self-support funding source: operational float instead of withdrawable
-- (see docs/self-support-float-funding-change.md)

CREATE OR REPLACE FUNCTION public.funder_float_available(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT GREATEST(
    0,
    public.get_user_float_available_balance(p_user_id)
      - GREATEST(0, public.funder_pending_hold(p_user_id))
  );
$function$;

GRANT EXECUTE ON FUNCTION public.funder_float_available(uuid) TO authenticated, service_role;

DO $do$
DECLARE
  v_rec record;
  v_def text;
  v_new text;
  v_pairs text[][] := ARRAY[
    -- funding-source gate: withdrawable -> operational float
    ARRAY['public\.get_user_available_balance\(v_uid\)', 'public.funder_float_available(v_uid)'],
    ARRAY['public\.get_user_available_balance\(v_partner\)', 'public.funder_float_available(v_partner)'],
    ARRAY['public\.get_user_available_balance\(p_partner\)', 'public.funder_float_available(p_partner)'],
    ARRAY['public\.get_user_available_balance\(t\.partner_id\)', 'public.funder_float_available(t.partner_id)'],
    ARRAY['public\.funder_support_capacity\(p_partner\)', 'public.funder_float_available(p_partner)'],
    -- funding mode now defaults to float
    ARRAY['p_funding_mode text DEFAULT ''withdrawable''::text', 'p_funding_mode text DEFAULT ''float''::text'],
    ARRAY['COALESCE\(NULLIF\(p_funding_mode,''''\), ''withdrawable''\)', 'COALESCE(NULLIF(p_funding_mode,''''), ''float'')'],
    -- copy: name the bucket the money comes from
    ARRAY['partner has UGX % available', 'partner has UGX % of operational float available'],
    ARRAY['partner holds UGX % across wallet and operational float', 'partner holds UGX % of operational float'],
    ARRAY['Your wallet has UGX % available', 'Your operational float has UGX % available'],
    ARRAY['Partner wallet no longer covers this top-up', 'Partner operational float no longer covers this top-up'],
    -- wallet debit leg: float bucket, operational recipient
    ARRAY['''category'', ''supporter_rent_fund'', ''ledger_scope'', ''wallet'',(\s*)''recipient_type'', ''user'', ''wallet_bucket'', ''withdrawable''',
          '''category'', ''supporter_rent_fund'', ''ledger_scope'', ''wallet'',\1''recipient_type'', ''operational_wallet'', ''wallet_bucket'', ''float'''],
    -- float-usage tags so float consumption is auditable by purpose
    ARRAY['\(self_managed_partner\)', '(self_managed_partner; float_usage=self_portfolio_funding)'],
    ARRAY['\(self_support_operational_house\)', '(self_support_operational_house; float_usage=house_support_funding)'],
    ARRAY['''description'', ''Self-managed portfolio top-up''', '''description'', ''Self-managed portfolio top-up (float_usage=self_portfolio_funding)''']
  ];
  i integer;
BEGIN
  FOR v_rec IN
    SELECT p.oid, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'psm_confirm_commitment_for',
        'partner_support_houses',
        'partner_self_top_up',
        'partner_self_topup_eligibility',
        'partner_self_list_fundable_plans',
        'partner_ops_approve_self_topup',
        'approve_pending_portfolio'
      )
  LOOP
    v_def := pg_get_functiondef(v_rec.oid);
    v_new := v_def;
    FOR i IN 1 .. array_length(v_pairs, 1) LOOP
      v_new := regexp_replace(v_new, v_pairs[i][1], v_pairs[i][2], 'g');
    END LOOP;

    IF v_new = v_def THEN
      RAISE EXCEPTION 'SELF_SUPPORT_FLOAT_PATCH_NOOP: % was not changed', v_rec.proname;
    END IF;

    EXECUTE v_new;
  END LOOP;
END
$do$;

-- Safety: no self-support path may still gate on the withdrawable balance.
DO $do$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('psm_confirm_commitment_for','partner_support_houses','partner_self_top_up',
                      'partner_self_topup_eligibility','partner_self_list_fundable_plans',
                      'partner_ops_approve_self_topup')
    AND pg_get_functiondef(p.oid) ILIKE '%get_user_available_balance%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SELF_SUPPORT_FLOAT_LEFTOVER_WITHDRAWABLE_GATE: %', v_bad;
  END IF;
END
$do$;
