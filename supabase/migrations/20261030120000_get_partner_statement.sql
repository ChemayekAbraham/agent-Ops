-- Partner statement: one statement per portfolio, rebuilt from the portfolio audit trail. READ ONLY - nothing is written.
--
-- For every portfolio of a partner it returns the day it started and with how much, then each event in date order:
--   * top-ups the partner made, marked "applied" (added to the principal by a merge) or "pending" (received, waiting for the next merge),
--   * returns earned (and how much was reinvested into the principal or paid out),
--   * withdrawals and capital paid out that belong to THAT portfolio only (not the partner's wallet withdrawals),
-- with the principal after each event as the system recorded it (roi_compounded.new_principal, merge new_capital, redemption remaining).
-- The closing principal is compared with the principal the portfolio holds today; a difference is returned, never hidden.
--
-- Same permission as get_partner_360 (partner_ops_can_view). The builder has no permission check of its own, so it is not callable by users.
-- Roll back with 20261030120000_get_partner_statement.rollback.sql.

CREATE OR REPLACE FUNCTION public._partner_statement_build(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_n int;
  pf record;
  r record;
  evs jsonb;
  princ numeric;
  start_amt numeric;
  q_amt numeric[];
  q_idx int[];
  m numeric;
  take numeric;
  k int;
  far boolean;
  v_topup_applied numeric; v_topup_pending numeric; v_earned numeric; v_reinv numeric; v_paid numeric; v_cap_out numeric; v_unmatched numeric;
  v_day_ev date; v_day_r date;
  v_ev jsonb;
BEGIN
  SELECT count(*) INTO v_n FROM public.investor_portfolios WHERE investor_id = p_user_id;

  FOR pf IN SELECT * FROM public.investor_portfolios WHERE investor_id = p_user_id ORDER BY created_at LOOP
    evs := '[]'::jsonb; q_amt := '{}'; q_idx := '{}';
    v_topup_applied := 0; v_earned := 0; v_reinv := 0; v_paid := 0; v_cap_out := 0;

    -- Starting amount: the amount the portfolio was created with; else the principal the first merge / top-up / compounding implies; else today's.
    SELECT COALESCE(
      (SELECT (a.metadata->>'amount')::numeric FROM public.audit_logs a
        WHERE a.table_name = 'investor_portfolios' AND a.record_id = pf.id::text
          AND a.action_type IN ('create_pending_portfolio','funder_pending_portfolio_created','direct_confirmation_portfolio_funded','create_portfolio_instant_wallet_deduct')
          AND a.metadata->>'amount' ~ '^[0-9]+(\.[0-9]+)?$' ORDER BY a.created_at LIMIT 1),
      (SELECT (a.metadata->>'previous_capital')::numeric FROM public.audit_logs a
        WHERE a.table_name = 'investor_portfolios' AND a.record_id = pf.id::text
          AND a.action_type IN ('manual_merge_pending_topups','auto_merge_pending_topups','cron_merge_paidout_topups','apply_pending_topups','manual_apply_topup_row','approve_portfolio_topup')
          AND a.metadata->>'previous_capital' ~ '^[0-9]+(\.[0-9]+)?$' ORDER BY a.created_at LIMIT 1),
      (SELECT (a.metadata->>'current_capital')::numeric FROM public.audit_logs a
        WHERE a.table_name = 'investor_portfolios' AND a.record_id = pf.id::text
          AND a.action_type IN ('manager_portfolio_topup_instant','manager_portfolio_topup_pending','manager_portfolio_topup')
          AND a.metadata->>'current_capital' ~ '^[0-9]+(\.[0-9]+)?$' ORDER BY a.created_at LIMIT 1),
      (SELECT (a.metadata->>'new_principal')::numeric - (a.metadata->>'roi_amount')::numeric FROM public.audit_logs a
        WHERE a.table_name = 'investor_portfolios' AND a.record_id = pf.id::text AND a.action_type = 'roi_compounded'
          AND a.metadata->>'new_principal' ~ '^[0-9]+(\.[0-9]+)?$' AND a.metadata->>'roi_amount' ~ '^[0-9]+(\.[0-9]+)?$' ORDER BY a.created_at LIMIT 1),
      pf.investment_amount, 0) INTO start_amt;

    princ := start_amt;
    evs := evs || jsonb_build_array(jsonb_build_object('at', pf.created_at, 'kind', 'start',
             'details', 'Portfolio started', 'topup', start_amt, 'principal', princ, 'status', 'applied'));

    FOR r IN
      SELECT a.created_at AS ts, 1 AS ord, a.action_type AS kind, a.id::text AS ref, a.metadata AS meta
        FROM public.audit_logs a
       WHERE a.table_name = 'investor_portfolios' AND a.record_id = pf.id::text
         AND a.action_type IN ('manager_portfolio_topup_instant','manager_portfolio_topup_pending','manager_portfolio_topup','coo_wallet_to_portfolio',
                               'manual_merge_pending_topups','auto_merge_pending_topups','cron_merge_paidout_topups','apply_pending_topups','manual_apply_topup_row','approve_portfolio_topup',
                               'reverse_merged_topup_row','cancel_pending_topups','roi_compounded','roi_split_payout')
      UNION ALL
      SELECT pr.created_at, 2, 'redemption', pr.id::text,
             jsonb_build_object('amount', pr.redeemed_amount, 'remaining', pr.remaining_principal)
        FROM public.portfolio_redemptions pr WHERE pr.partner_id = p_user_id AND pr.portfolio_code = pf.portfolio_code
      UNION ALL
      SELECT COALESCE(w.processed_at, w.created_at), 3, 'withdrawal', w.id::text,
             jsonb_build_object('amount', w.amount, 'method', w.payout_method)
        FROM public.withdrawal_requests w
       WHERE w.user_id = p_user_id AND w.status = 'completed' AND w.reason IS NOT NULL
         AND ( strpos(lower(w.reason), lower(pf.portfolio_code)) > 0
            OR (nullif(btrim(pf.account_name), '') IS NOT NULL AND strpos(lower(w.reason), lower(btrim(pf.account_name))) > 0)
            OR (v_n = 1 AND strpos(lower(w.reason), 'portfolio') > 0) )
       ORDER BY 1, 2
    LOOP
      IF r.kind IN ('manager_portfolio_topup_instant','manager_portfolio_topup_pending','manager_portfolio_topup','coo_wallet_to_portfolio') THEN
        IF (r.meta->>'amount') ~ '^[0-9]+(\.[0-9]+)?$' AND COALESCE(r.meta->>'status','') NOT IN ('rejected','cancelled','reversed') THEN
          evs := evs || jsonb_build_array(jsonb_build_object('at', r.ts, 'kind', 'topup', 'ref', upper(left(r.ref, 8)),
                   'details', 'Top-up received', 'topup', (r.meta->>'amount')::numeric, 'principal', princ, 'status', 'pending'));
          q_amt := q_amt || (r.meta->>'amount')::numeric;
          q_idx := q_idx || (jsonb_array_length(evs) - 1);
        END IF;

      ELSIF r.kind IN ('manual_merge_pending_topups','auto_merge_pending_topups','cron_merge_paidout_topups','apply_pending_topups','manual_apply_topup_row','approve_portfolio_topup') THEN
        IF (r.meta->>'new_capital') ~ '^[0-9]+(\.[0-9]+)?$' AND (r.meta->>'previous_capital') ~ '^[0-9]+(\.[0-9]+)?$' THEN
          -- What this merge adds is measured from the principal as already known, so the same merge recorded twice adds nothing the second time.
          m := (r.meta->>'new_capital')::numeric - princ;
          far := false;
          WHILE m > 0 AND COALESCE(array_length(q_amt, 1), 0) > 0 LOOP
            -- A merge that applies one top-up exactly matches it; otherwise the oldest waiting top-ups are taken first.
            k := 1;
            SELECT i INTO k FROM generate_subscripts(q_amt, 1) AS i WHERE q_amt[i] = m ORDER BY i LIMIT 1;
            IF NOT FOUND THEN k := 1; END IF;
            take := least(m, q_amt[k]);
            m := m - take;
            IF q_amt[k] - take <= 0 THEN
              v_ev := evs->q_idx[k];
              v_day_ev := ((v_ev->>'at')::timestamptz AT TIME ZONE 'Africa/Kampala')::date;
              v_day_r := (r.ts AT TIME ZONE 'Africa/Kampala')::date;
              evs := jsonb_set(evs, ARRAY[q_idx[k]::text, 'status'], '"applied"');
              evs := jsonb_set(evs, ARRAY[q_idx[k]::text, 'applied_at'], to_jsonb(r.ts));
              IF v_day_ev = v_day_r THEN
                evs := jsonb_set(evs, ARRAY[q_idx[k]::text, 'principal'], to_jsonb((r.meta->>'new_capital')::numeric));
                evs := jsonb_set(evs, ARRAY[q_idx[k]::text, 'details'], '"Top-up received and added to principal"');
              ELSE
                far := true;
              END IF;
              v_topup_applied := v_topup_applied + (v_ev->>'topup')::numeric;
              q_amt := q_amt[1:k-1] || q_amt[k+1:array_length(q_amt, 1)];
              q_idx := q_idx[1:k-1] || q_idx[k+1:array_length(q_idx, 1)];
            ELSE
              q_amt[k] := q_amt[k] - take;
            END IF;
          END LOOP;
          IF m > 0 THEN
            -- A merge with no matching top-up row in the trail (e.g. an imported or bank top-up): still part of the principal.
            evs := evs || jsonb_build_array(jsonb_build_object('at', r.ts, 'kind', 'topup', 'ref', upper(left(r.ref, 8)),
                     'details', 'Top-up added to principal', 'topup', m, 'principal', (r.meta->>'new_capital')::numeric, 'status', 'applied', 'applied_at', r.ts));
            v_topup_applied := v_topup_applied + m;
          ELSIF far THEN
            evs := evs || jsonb_build_array(jsonb_build_object('at', r.ts, 'kind', 'merge', 'ref', upper(left(r.ref, 8)),
                     'details', 'Earlier top-ups added to principal', 'principal', (r.meta->>'new_capital')::numeric, 'status', 'applied'));
          END IF;
          princ := (r.meta->>'new_capital')::numeric;
        END IF;

      ELSIF r.kind = 'reverse_merged_topup_row' THEN
        IF (r.meta->>'new_capital') ~ '^[0-9]+(\.[0-9]+)?$' AND (r.meta->>'amount') ~ '^[0-9]+(\.[0-9]+)?$' THEN
          princ := (r.meta->>'new_capital')::numeric;
          v_topup_applied := v_topup_applied - (r.meta->>'amount')::numeric;
          evs := evs || jsonb_build_array(jsonb_build_object('at', r.ts, 'kind', 'reversal', 'ref', upper(left(r.ref, 8)),
                   'details', 'Top-up reversed', 'topup', -(r.meta->>'amount')::numeric, 'principal', princ, 'status', 'applied'));
        END IF;

      ELSIF r.kind = 'cancel_pending_topups' THEN
        m := COALESCE(NULLIF(r.meta->>'total_cancelled', '')::numeric, 0);
        WHILE m > 0 AND COALESCE(array_length(q_amt, 1), 0) > 0 LOOP
          take := least(m, q_amt[1]);
          m := m - take;
          IF q_amt[1] - take <= 0 THEN
            evs := jsonb_set(evs, ARRAY[q_idx[1]::text, 'status'], '"cancelled"');
            evs := jsonb_set(evs, ARRAY[q_idx[1]::text, 'details'], '"Top-up cancelled before it was added"');
            q_amt := q_amt[2:array_length(q_amt, 1)]; q_idx := q_idx[2:array_length(q_idx, 1)];
          ELSE
            q_amt[1] := q_amt[1] - take;
          END IF;
        END LOOP;

      ELSIF r.kind = 'roi_compounded' THEN
        IF (r.meta->>'roi_amount') ~ '^[0-9]+(\.[0-9]+)?$' AND (r.meta->>'new_principal') ~ '^[0-9]+(\.[0-9]+)?$' THEN
          princ := (r.meta->>'new_principal')::numeric;
          v_earned := v_earned + (r.meta->>'roi_amount')::numeric;
          v_reinv := v_reinv + (r.meta->>'roi_amount')::numeric;
          evs := evs || jsonb_build_array(jsonb_build_object('at', r.ts, 'kind', 'returns', 'ref', upper(left(r.ref, 8)),
                   'details', 'Returns earned and reinvested into principal', 'returns', (r.meta->>'roi_amount')::numeric, 'principal', princ, 'status', 'applied'));
        END IF;

      ELSIF r.kind = 'roi_split_payout' THEN
        IF (r.meta->>'roi_amount') ~ '^[0-9]+(\.[0-9]+)?$' AND (r.meta->>'new_principal') ~ '^[0-9]+(\.[0-9]+)?$' THEN
          princ := (r.meta->>'new_principal')::numeric;
          m := COALESCE(NULLIF(r.meta->>'cash_amount', '')::numeric, 0);
          v_earned := v_earned + (r.meta->>'roi_amount')::numeric;
          v_paid := v_paid + m;
          v_reinv := v_reinv + ((r.meta->>'roi_amount')::numeric - m);
          evs := evs || jsonb_build_array(jsonb_build_object('at', r.ts, 'kind', 'returns', 'ref', upper(left(r.ref, 8)),
                   'details', 'Returns earned: ' || to_char((r.meta->>'roi_amount')::numeric - m, 'FM999,999,999,990') || ' reinvested, ' || to_char(m, 'FM999,999,999,990') || ' paid out',
                   'returns', (r.meta->>'roi_amount')::numeric, 'paid', m, 'principal', princ, 'status', 'applied'));
        END IF;

      ELSIF r.kind = 'redemption' THEN
        princ := COALESCE((r.meta->>'remaining')::numeric, princ);
        v_paid := v_paid + (r.meta->>'amount')::numeric;
        v_cap_out := v_cap_out + (r.meta->>'amount')::numeric;
        evs := evs || jsonb_build_array(jsonb_build_object('at', r.ts, 'kind', 'capital_out', 'ref', upper(left(r.ref, 8)),
                 'details', 'Capital paid out', 'paid', (r.meta->>'amount')::numeric, 'principal', princ, 'status', 'applied'));

      ELSIF r.kind = 'withdrawal' THEN
        -- A payout already shown as the cash part of a split payout around the same time is not listed twice.
        IF NOT EXISTS (SELECT 1 FROM public.audit_logs a
                        WHERE a.table_name = 'investor_portfolios' AND a.record_id = pf.id::text AND a.action_type = 'roi_split_payout'
                          AND a.metadata->>'cash_amount' ~ '^[0-9]+(\.[0-9]+)?$' AND (a.metadata->>'cash_amount')::numeric = (r.meta->>'amount')::numeric
                          AND abs(extract(epoch FROM (a.created_at - r.ts))) < 259200) THEN
          v_paid := v_paid + (r.meta->>'amount')::numeric;
          evs := evs || jsonb_build_array(jsonb_build_object('at', r.ts, 'kind', 'withdrawal', 'ref', upper(left(r.ref, 8)),
                   'details', 'Withdrawal paid out' || COALESCE(' (' || replace(NULLIF(r.meta->>'method', ''), '_', ' ') || ')', ''),
                   'paid', (r.meta->>'amount')::numeric, 'principal', princ, 'status', 'applied'));
        END IF;
      END IF;
    END LOOP;

    -- Top-ups still waiting: a merge follows a payout cycle (at most about 40 days). One older than 45 days that never matched a change to the
    -- principal (e.g. the same top-up recorded twice) is listed as "not matched" and left out of the pending total, never counted as money waiting.
    v_topup_pending := 0; v_unmatched := 0;
    FOR k IN 1 .. COALESCE(array_length(q_amt, 1), 0) LOOP
      IF ((evs->q_idx[k])->>'at')::timestamptz < now() - interval '45 days' THEN
        evs := jsonb_set(evs, ARRAY[q_idx[k]::text, 'status'], '"unmatched"');
        evs := jsonb_set(evs, ARRAY[q_idx[k]::text, 'details'], '"Top-up recorded; no matching change to the principal found"');
        v_unmatched := v_unmatched + q_amt[k];
      ELSE
        v_topup_pending := v_topup_pending + q_amt[k];
      END IF;
    END LOOP;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', pf.id, 'code', pf.portfolio_code, 'name', pf.account_name, 'status', pf.status,
      'rate', pf.roi_percentage, 'months', pf.duration_months, 'roi_mode', pf.roi_mode,
      'created_at', pf.created_at, 'maturity_date', pf.maturity_date,
      'start_amount', start_amt,
      'recorded_principal', pf.investment_amount, 'computed_principal', princ,
      'topups_applied', v_topup_applied, 'topups_pending', v_topup_pending, 'topups_unmatched', v_unmatched,
      'returns_earned', v_earned, 'returns_reinvested', v_reinv, 'paid_out', v_paid, 'capital_out', v_cap_out,
      -- What the recorded principal holds beyond start + applied top-ups + reinvested returns - capital paid out: amounts set by hand-edits
      -- of the portfolio (e.g. an opening balance entered at migration). Shown as its own line so the parts always add up.
      'adjustments', pf.investment_amount - (start_amt + v_topup_applied + v_reinv - v_cap_out),
      'events', evs));
  END LOOP;

  RETURN v_out;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.get_partner_statement(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT public.partner_ops_can_view() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  RETURN public._partner_statement_build(p_user_id);
END;
$fn$;

REVOKE ALL ON FUNCTION public._partner_statement_build(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_partner_statement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_statement(uuid) TO authenticated;
