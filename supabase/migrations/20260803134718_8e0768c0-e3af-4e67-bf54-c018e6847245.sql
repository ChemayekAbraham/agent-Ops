-- ===============================================================
-- Self Portfolio Management — Phase Four: pay recognised returns
-- ===============================================================
CREATE OR REPLACE FUNCTION public.pay_partner_self_cycles(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c record;
  v_entries jsonb;
  v_group uuid;
  v_paid integer := 0;
  v_amount numeric := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
BEGIN
  FOR c IN
    SELECT p.*, cm.monthly_rate
      FROM public.partner_self_payout_cycles p
      JOIN public.partner_self_commitments cm ON cm.id = p.commitment_id
     WHERE p.status = 'pending'
       AND p.cycle_end <= CURRENT_DATE
     ORDER BY p.cycle_end ASC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))
  LOOP
    -- Idempotency: never credit a cycle that already carries a ledger group.
    IF c.ledger_group_id IS NOT NULL THEN
      UPDATE public.partner_self_payout_cycles
         SET status = 'paid', paid_at = COALESCE(paid_at, now()), updated_at = now()
       WHERE id = c.id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF COALESCE(c.total_amount, 0) <= 0 THEN
      UPDATE public.partner_self_payout_cycles
         SET status = 'void', failure_reason = 'nothing recognised for this cycle', updated_at = now()
       WHERE id = c.id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      v_entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', c.partner_id,
          'amount', c.total_amount,
          'direction', 'cash_out',
          'category', 'roi_expense',
          'ledger_scope', 'platform',
          'source_table', 'partner_self_payout_cycles',
          'source_id', c.id,
          'linked_party', 'platform',
          'description', 'Self-managed partner returns for cycle ending ' || c.cycle_end::text
        ),
        jsonb_build_object(
          'user_id', c.partner_id,
          'amount', c.total_amount,
          'direction', 'cash_in',
          'category', 'roi_wallet_credit',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'partner_self_payout_cycles',
          'source_id', c.id,
          'linked_party', 'platform',
          'description', c.monthly_rate || '% monthly returns on self-managed funding (cycle ending '
                         || c.cycle_end::text || ')'
        )
      );

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'psm-payout-' || c.id::text
      );

      UPDATE public.partner_self_payout_cycles
         SET status = 'paid', paid_at = now(), ledger_group_id = v_group,
             failure_reason = NULL, updated_at = now()
       WHERE id = c.id;

      UPDATE public.partner_self_earnings
         SET status = 'paid', paid_at = now()
       WHERE payout_cycle_id = c.id AND status = 'accrued';

      UPDATE public.partner_self_commitments
         SET total_paid = COALESCE(total_paid, 0) + c.total_amount, updated_at = now()
       WHERE id = c.commitment_id;

      -- Recover any active customer advance set to collect from returns.
      BEGIN
        PERFORM public.apply_roi_advance_recovery(c.partner_id, c.total_amount, c.id,
                                                 'psm-payout-' || c.id::text);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;

      BEGIN
        INSERT INTO public.system_events (event_type, user_id, metadata)
        VALUES ('roi_distributed', c.partner_id,
                jsonb_build_object('source', 'partner_self_managed',
                                   'payout_cycle_id', c.id,
                                   'commitment_id', c.commitment_id,
                                   'cycle_end', c.cycle_end,
                                   'amount', c.total_amount));
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;

      PERFORM public.psm_audit(NULL, c.partner_id, 'returns_paid',
        'partner_self_payout_cycles', c.id,
        jsonb_build_object('amount', c.total_amount, 'cycle_end', c.cycle_end,
                           'ledger_group_id', v_group));

      v_paid := v_paid + 1;
      v_amount := v_amount + c.total_amount;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.partner_self_payout_cycles
         SET status = 'failed', failure_reason = left(SQLERRM, 500), updated_at = now()
       WHERE id = c.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('cycles_paid', v_paid, 'total_paid', v_amount,
                            'skipped', v_skipped, 'failed', v_failed);
END;
$fn$;

REVOKE ALL ON FUNCTION public.pay_partner_self_cycles(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_partner_self_cycles(integer) TO service_role;

-- ---------------------------------------------------------------
-- Ops visibility: self-managed commitments with returns due soon
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_self_nearing_payouts(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_days integer := GREATEST(0, LEAST(COALESCE(p_days, 7), 60));
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT (
      public.is_ops_role(v_uid) OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'coo')
      OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'manager') OR public.has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;

  RETURN (
    WITH due AS (
      SELECT cm.id AS commitment_id,
             cm.partner_id,
             COALESCE(NULLIF(btrim(pr.full_name),''),'Partner') AS partner_name,
             pr.phone AS partner_phone,
             cm.committed_amount,
             cm.monthly_rate,
             cm.next_payout_at::date AS next_payout_date,
             (cm.next_payout_at::date - CURRENT_DATE) AS days_until,
             (SELECT COALESCE(SUM(l.principal),0)
                FROM public.partner_self_funding_lines l
               WHERE l.commitment_id = cm.id AND l.status = 'active') AS active_principal,
             (SELECT COALESCE(SUM(p.total_amount),0)
                FROM public.partner_self_payout_cycles p
               WHERE p.commitment_id = cm.id AND p.status = 'pending') AS pending_amount,
             cm.total_earned,
             cm.total_paid
        FROM public.partner_self_commitments cm
        LEFT JOIN public.profiles pr ON pr.id = cm.partner_id
       WHERE cm.status = 'active'
         AND cm.next_payout_at IS NOT NULL
         AND cm.next_payout_at::date <= (CURRENT_DATE + v_days)
    )
    SELECT jsonb_build_object(
      'count', (SELECT COUNT(*) FROM due),
      'expected_total', (SELECT COALESCE(SUM(GREATEST(pending_amount,
                          round(active_principal * monthly_rate / 100))), 0) FROM due),
      'rows', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'commitment_id', d.commitment_id,
                 'partner_id', d.partner_id,
                 'partner_name', d.partner_name,
                 'partner_phone', d.partner_phone,
                 'committed_amount', d.committed_amount,
                 'active_principal', d.active_principal,
                 'monthly_rate', d.monthly_rate,
                 'next_payout_date', d.next_payout_date,
                 'days_until', d.days_until,
                 'expected_amount', GREATEST(d.pending_amount,
                                    round(d.active_principal * d.monthly_rate / 100)),
                 'pending_amount', d.pending_amount,
                 'total_earned', d.total_earned,
                 'total_paid', d.total_paid
               ) ORDER BY d.next_payout_date ASC), '[]'::jsonb)
        FROM due d
      )
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.partner_self_nearing_payouts(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_self_nearing_payouts(integer) TO authenticated, service_role;