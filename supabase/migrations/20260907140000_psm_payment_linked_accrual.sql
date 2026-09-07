-- PSM: payment-linked accrual mode (2026-09-07 partner call + Josh's recap,
-- refined after finding the existing Self Portfolio Management system
-- already covers most of what the reference doc described).
--
-- Confirmed against the live system before writing this:
--   - Principal is already rent_requests.rent_amount (v_partner_self_fundable_plans,
--     20260803112418...sql:313) -- no separate "principal" input needed.
--   - term_months already defaults to 1 (20260805091203...sql), so a line
--     tied to one rent plan already expires with it instead of compounding
--     for 12 months regardless of whether the tenant returns.
--   - Access Fee and Registration Fee are already computed and stored on
--     every rent_request by the canonical compute_rent_repayment formula
--     (20260429053914...sql) -- access_fee, request_fee, total_repayment,
--     daily_repayment. Nothing new to compute there; just read them.
--   - Agent commission is credited by the existing, separate mechanism
--     (credit_agent_rent_commission) wherever tenant repayments are
--     recorded today -- untouched, unrelated to this change.
--
-- The one real gap: accrue_partner_self_returns accrues Returns purely
-- time-based, deliberately decoupled from tenant payment ("the company
-- absorbs tenant default, never the partner" -- its own comment). That's
-- backwards for a rent-plan-tied line where a missed payment should reduce
-- what accrues, or the statement shows fake figures for a tenant who never
-- comes back. This adds an opt-in 'payment_linked' accrual_mode so EXISTING
-- lines and the default behavior are completely unchanged.
--
-- Registration Fee and Platform Margin don't exist in PSM at all today.
-- Per product decision, both post to the ledger immediately as they're
-- recognized each cycle (they're platform revenue, not money owed
-- externally) rather than routing through the deferred
-- partner_self_payout_cycles/pay_partner_self_cycles mechanism Partner
-- Returns uses. general_ledger enforces a locked category allowlist
-- (validate_ledger_category(), gated by treasury_controls.strict_mode,
-- confirmed ON in production) -- discovered only by dry-running this
-- migration against the live DB, since it's a trigger, not a CHECK
-- constraint, so it's invisible to a pg_constraint/information_schema scan.
-- Rather than extend that "locked" list, this reuses two categories
-- already in it that fit exactly: registration_fee_collected and
-- access_fee_collected (platform margin is the net of the access fee
-- after partner returns are taken out).
--
-- IMPORTANT: the actual live partner_self_confirm_commitment / psm_confirm_commitment_for
-- / partner_self_top_up functions on production are substantially different
-- from every version in supabase/migrations/ -- they now route through an
-- ops-approval workflow (partner_self_commitments starts 'pending_ops_approval'),
-- promissory notes, and investor_portfolios/funder_pending_portfolios, none
-- of which appear in any migration file (confirmed live via direct DB query
-- before writing this, per CLAUDE.md's warning that migrations drift from
-- production). Wiring accrual_mode into that pipeline without fully
-- understanding it risks a real regression, so this deliberately does NOT
-- touch commitment/line creation at all. Instead it adds one narrow,
-- ops-only RPC to flip an existing line into payment-linked mode after the
-- fact, regardless of which pipeline created it.

-- =========================================================================
-- 1. Schema: opt-in flag + collection baseline, both default to a no-op.
-- =========================================================================

alter table public.partner_self_funding_lines
  add column if not exists accrual_mode text not null default 'time_based'
    check (accrual_mode in ('time_based', 'payment_linked'));

alter table public.partner_self_funding_lines
  add column if not exists amount_repaid_at_last_cycle numeric not null default 0;

-- =========================================================================
-- 2. Ops-only: opt a specific, already-created line into payment-linked
--    accrual. Deliberately narrow -- does not touch how lines get created.
-- =========================================================================

create or replace function public.psm_set_line_accrual_mode(
  p_line_id uuid,
  p_accrual_mode text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_uid uuid := auth.uid();
  v_mode text;
  v_line public.partner_self_funding_lines%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'ceo'::app_role)
    OR public.has_role(v_uid, 'partner_ops'::app_role) OR public.has_role(v_uid, 'financial_ops'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorised to change accrual mode' USING ERRCODE = '42501';
  END IF;

  IF p_accrual_mode NOT IN ('time_based', 'payment_linked') THEN
    RAISE EXCEPTION 'Invalid accrual_mode: %', p_accrual_mode USING ERRCODE = 'check_violation';
  END IF;
  v_mode := p_accrual_mode;

  SELECT * INTO v_line FROM public.partner_self_funding_lines WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Line not found' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE public.partner_self_funding_lines
     SET accrual_mode = v_mode,
         -- switching modes mid-line should not retroactively credit/deny
         -- Returns for days already accrued the old way; baseline collection
         -- at "now" so payment-linked accrual only measures what's collected
         -- from this point forward.
         amount_repaid_at_last_cycle = CASE WHEN v_mode = 'payment_linked'
           THEN (SELECT COALESCE(rr.amount_repaid, 0) FROM public.rent_requests rr WHERE rr.id = v_line.rent_request_id)
           ELSE amount_repaid_at_last_cycle END,
         updated_at = now()
   WHERE id = p_line_id;

  PERFORM public.psm_audit(v_uid, v_line.partner_id, 'line_accrual_mode_changed',
    'partner_self_funding_lines', p_line_id,
    jsonb_build_object('accrual_mode', v_mode, 'rent_request_id', v_line.rent_request_id));

  RETURN jsonb_build_object('line_id', p_line_id, 'accrual_mode', v_mode);
END;
$function$;

REVOKE ALL ON FUNCTION public.psm_set_line_accrual_mode(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psm_set_line_accrual_mode(uuid, text) TO authenticated, service_role;

-- =========================================================================
-- 3. accrue_partner_self_returns -- the existing time_based query gets one
--    added filter (accrual_mode = 'time_based') and is otherwise untouched.
--    A second block, gated the opposite way, handles payment_linked lines:
--    Returns scale by how much of this cycle's expected repayment the
--    tenant actually paid, and Registration Fee + Platform Margin are
--    recognized and posted to the ledger immediately, proportionally to
--    the same collection ratio.
-- =========================================================================

create or replace function public.accrue_partner_self_returns(p_as_of date default CURRENT_DATE)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
DECLARE
  r record;
  pl record;
  v_cycle_start date;
  v_cycle_end date;
  v_days integer;
  v_total numeric;
  v_lines integer;
  v_cycle_id uuid;
  v_commitments integer := 0;
  v_recognised numeric := 0;
  v_as_of date := LEAST(COALESCE(p_as_of, CURRENT_DATE), CURRENT_DATE);
  v_collected numeric;
  v_expected numeric;
  v_ratio numeric;
  v_returns_amount numeric;
  v_registration_amount numeric;
  v_margin_amount numeric;
  v_fee_entries jsonb;
BEGIN
  FOR r IN
    SELECT * FROM public.partner_self_commitments
    WHERE status='active' AND next_payout_at IS NOT NULL AND next_payout_at::date <= v_as_of
    ORDER BY next_payout_at ASC
  LOOP
    v_cycle_end := r.next_payout_at::date;
    v_cycle_start := (r.next_payout_at - interval '1 month')::date;
    v_days := GREATEST(1, v_cycle_end - v_cycle_start);

    INSERT INTO public.partner_self_payout_cycles (partner_id, commitment_id, cycle_start, cycle_end)
    VALUES (r.partner_id, r.id, v_cycle_start, v_cycle_end)
    ON CONFLICT (commitment_id, cycle_end) DO UPDATE SET updated_at = now()
    RETURNING id INTO v_cycle_id;

    -- Unchanged: time-based accrual for every line NOT opted into
    -- payment-linked mode. Same formula, same idempotency, as before.
    INSERT INTO public.partner_self_earnings (
      line_id, commitment_id, partner_id, cycle_start, cycle_end,
      days_live, days_in_cycle, principal, monthly_rate, amount, payout_cycle_id
    )
    SELECT l.id, r.id, r.partner_id, v_cycle_start, v_cycle_end,
           d.days_live, v_days, l.principal, l.monthly_rate,
           round(l.principal * l.monthly_rate / 100 * d.days_live::numeric / v_days),
           v_cycle_id
    FROM public.partner_self_funding_lines l
    CROSS JOIN LATERAL (
      SELECT GREATEST(0,
        LEAST(
          v_cycle_end,
          COALESCE(l.completed_at::date, v_cycle_end),
          COALESCE(COALESCE(r.term_end_at, l.term_end_at)::date, v_cycle_end)
        )
        - GREATEST(v_cycle_start, l.live_at::date)
      ) AS days_live
    ) d
    WHERE l.commitment_id = r.id
      AND l.accrual_mode = 'time_based'
      AND l.live_at IS NOT NULL
      AND l.status IN ('active','completed')
      AND d.days_live > 0
    ON CONFLICT (line_id, cycle_end) DO NOTHING;

    -- New: payment-linked lines. Returns scale by the tenant's actual
    -- collection ratio this cycle; Registration Fee + Platform Margin are
    -- recognized proportionally and posted straight to the ledger.
    FOR pl IN
      SELECT l.id AS line_id, l.principal, l.monthly_rate, l.amount_repaid_at_last_cycle,
             rr.amount_repaid, rr.daily_repayment, rr.access_fee, rr.request_fee,
             GREATEST(0,
               LEAST(
                 v_cycle_end,
                 COALESCE(l.completed_at::date, v_cycle_end),
                 COALESCE(COALESCE(r.term_end_at, l.term_end_at)::date, v_cycle_end)
               )
               - GREATEST(v_cycle_start, l.live_at::date)
             ) AS days_live
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      WHERE l.commitment_id = r.id
        AND l.accrual_mode = 'payment_linked'
        AND l.live_at IS NOT NULL
        AND l.status IN ('active','completed')
        AND NOT EXISTS (
          SELECT 1 FROM public.partner_self_earnings pe
          WHERE pe.line_id = l.id AND pe.cycle_end = v_cycle_end
        )
    LOOP
      IF pl.days_live <= 0 THEN
        CONTINUE;
      END IF;

      v_collected := GREATEST(0, COALESCE(pl.amount_repaid, 0) - COALESCE(pl.amount_repaid_at_last_cycle, 0));
      v_expected  := COALESCE(pl.daily_repayment, 0) * v_days;
      v_ratio     := CASE WHEN v_expected > 0 THEN LEAST(1, v_collected / v_expected) ELSE 0 END;

      v_returns_amount      := round(pl.principal * pl.monthly_rate / 100 * v_ratio);
      v_registration_amount := round(COALESCE(pl.request_fee, 0) * v_ratio);
      v_margin_amount       := round(COALESCE(pl.access_fee, 0) * v_ratio - v_returns_amount);

      INSERT INTO public.partner_self_earnings (
        line_id, commitment_id, partner_id, cycle_start, cycle_end,
        days_live, days_in_cycle, principal, monthly_rate, amount, payout_cycle_id
      ) VALUES (
        pl.line_id, r.id, r.partner_id, v_cycle_start, v_cycle_end,
        pl.days_live, v_days, pl.principal, pl.monthly_rate, v_returns_amount, v_cycle_id
      )
      ON CONFLICT (line_id, cycle_end) DO NOTHING;

      IF v_registration_amount > 0 OR v_margin_amount > 0 THEN
        v_fee_entries := '[]'::jsonb;
        IF v_registration_amount > 0 THEN
          v_fee_entries := v_fee_entries || jsonb_build_array(jsonb_build_object(
            'amount', v_registration_amount, 'direction', 'cash_out',
            'category', 'registration_fee_collected', 'ledger_scope', 'platform',
            'source_table', 'partner_self_funding_lines', 'source_id', pl.line_id,
            'reference_id', v_cycle_end::text,
            'description', 'PSM payment-linked registration fee recognised for cycle ending ' || v_cycle_end::text
          ));
        END IF;
        IF v_margin_amount > 0 THEN
          v_fee_entries := v_fee_entries || jsonb_build_array(jsonb_build_object(
            'amount', v_margin_amount, 'direction', 'cash_out',
            'category', 'access_fee_collected', 'ledger_scope', 'platform',
            'source_table', 'partner_self_funding_lines', 'source_id', pl.line_id,
            'reference_id', v_cycle_end::text,
            'description', 'PSM payment-linked platform margin (access fee net of partner returns) recognised for cycle ending ' || v_cycle_end::text
          ));
        END IF;
        v_fee_entries := v_fee_entries || jsonb_build_array(jsonb_build_object(
          'amount', (SELECT sum((e->>'amount')::numeric) FROM jsonb_array_elements(v_fee_entries) e),
          'direction', 'cash_in',
          'category', 'bucket_reclass_in', 'ledger_scope', 'platform',
          'source_table', 'partner_self_funding_lines', 'source_id', pl.line_id,
          'reference_id', v_cycle_end::text,
          'description', 'PSM payment-linked: reclass of collected repayment into fee/margin'
        ));
        PERFORM public.create_ledger_transaction(
          entries := v_fee_entries,
          idempotency_key := 'psm-fee-margin-' || pl.line_id::text || '-' || v_cycle_end::text
        );
      END IF;

      UPDATE public.partner_self_funding_lines
         SET amount_repaid_at_last_cycle = COALESCE(pl.amount_repaid, 0), updated_at = now()
       WHERE id = pl.line_id;
    END LOOP;

    SELECT COALESCE(SUM(amount),0), COUNT(*) INTO v_total, v_lines
    FROM public.partner_self_earnings WHERE payout_cycle_id = v_cycle_id AND status <> 'void';

    UPDATE public.partner_self_payout_cycles
       SET total_amount = v_total, lines_count = v_lines, updated_at = now()
     WHERE id = v_cycle_id;

    UPDATE public.partner_self_commitments
       SET next_payout_at = next_payout_at + interval '1 month',
           total_earned = total_earned + v_total,
           status = CASE WHEN term_end_at IS NOT NULL AND (next_payout_at + interval '1 month') > term_end_at
                         THEN 'matured' ELSE status END,
           updated_at = now()
     WHERE id = r.id;

    v_commitments := v_commitments + 1;
    v_recognised := v_recognised + v_total;

    PERFORM public.psm_audit(NULL, r.partner_id, 'returns_recognised',
      'partner_self_payout_cycles', v_cycle_id,
      jsonb_build_object('cycle_end', v_cycle_end, 'amount', v_total, 'lines', v_lines));
  END LOOP;

  RETURN jsonb_build_object('commitments_processed', v_commitments, 'total_recognised', v_recognised, 'as_of', v_as_of);
END;
$fn$;

REVOKE ALL ON FUNCTION public.accrue_partner_self_returns(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accrue_partner_self_returns(date) TO service_role;
