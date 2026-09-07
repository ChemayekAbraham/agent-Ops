-- PSM: Landlord Float Bucket / cycle recycling (2026-09-07, follow-up to
-- 20260907140000_psm_payment_linked_accrual.sql).
--
-- The reference doc ("Landlord Float Flows") describes a Landlord Float
-- Bucket that redisburses the same principal to the landlord every cycle,
-- for up to 12 cycles, before it ever reaches the partner. Traced the full
-- live mechanism before writing this (none of it is in supabase/migrations/):
--
--   psm_confirm_commitment_for -> creates partner_self_commitments
--     (status='pending_ops_approval') + partner_self_funding_lines +
--     investor_portfolios + funder_pending_portfolios.
--   approve_pending_portfolio  -> Partner Ops approves: debits the partner's
--     wallet into their OWN operational float wallet, flips the commitment
--     to 'active', then (for source='self_managed' only) calls
--     psm_disburse_landlord_float(commitment_id, NULL, NULL).
--   psm_disburse_landlord_float -> for each funding line, if no open/
--     partially_paid agent_landlord_float_allocations row already exists
--     for that rent_request, inserts ONE allocation (source=
--     'partner_self_funding') and posts the rent_disbursement ledger pair.
--     This is a ONE-TIME disbursement per line today -- nothing ever calls
--     it a second time, so principal never recycles.
--   agent_landlord_float_allocations.status auto-flips to 'fully_paid' the
--     instant paid_out_amount reaches allocated_amount (recompute_alfa_status,
--     a BEFORE trigger) -- confirmed live, not just in a migration file.
--   apply_landlord_payout_to_allocation (AFTER UPDATE OF status ON
--     landlord_payouts) is what increments paid_out_amount the moment an
--     agent's landlord payout actually completes -- per the 2026-09-07
--     product decision, THIS is the "day the tenant's rent is released to
--     the landlord" event that should trigger next cycle's float becoming
--     available, gated on the tenant having no arrears.
--
-- Design: reuse psm_disburse_landlord_float verbatim for the recycle itself
-- (it already skips a rent_request with a live allocation, and inserting a
-- fresh 'partner_self_funding' row for the same rent_request is exactly
-- what "redisburse the same principal" means here) rather than duplicating
-- its allocation/ledger logic. Extend apply_landlord_payout_to_allocation
-- with one new block, gated strictly on source='partner_self_funding' AND
-- the just-updated allocation reaching 'fully_paid', so cfo_disbursement
-- and every other source's behavior is byte-for-byte unchanged.
--
-- The recycle cap reuses the EXISTING term_months field (already capped at
-- 12 by psm_confirm_commitment_for/psm_confirm_commitment_for's callers,
-- already defaulting to 1 per Pius's 2026-08-05 fix so an ordinary
-- tenant-tied plan does NOT recycle past its own rent cycle) -- no new
-- "12 cycles" concept is invented; a new cycles_disbursed counter on
-- partner_self_funding_lines tracks progress against it.
--
-- Deliberately NOT built here: what happens to principal once
-- cycles_disbursed reaches term_months (the doc's "released to the partner
-- after 12 cycles, or on an approved withdrawal"). partner_self_commitments
-- already has topup-eligibility lockout language referencing "the final
-- days are reserved for returning principal," implying a principal-return
-- mechanism may already exist or be planned elsewhere that this hasn't
-- located -- recycling simply stops once the cap is reached, rather than
-- guessing at an unverified release mechanism.

-- =========================================================================
-- 1. Per-line cycle counter.
-- =========================================================================

alter table public.partner_self_funding_lines
  add column if not exists cycles_disbursed integer not null default 0;

-- =========================================================================
-- 2. psm_disburse_landlord_float -- identical to the live definition, plus
--    one added line: bump cycles_disbursed for every line it successfully
--    disburses (whether called at initial approval or by the recycle below).
-- =========================================================================

create or replace function public.psm_disburse_landlord_float(p_commitment_id uuid, p_topup_id uuid DEFAULT NULL::uuid, p_rent_request_ids uuid[] DEFAULT NULL::uuid[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_partner uuid;
  v_line record;
  v_agent uuid;
  v_alloc uuid;
  v_alloc_ids uuid[] := ARRAY[]::uuid[];
  v_landlord_name text;
  v_ref text;
  v_cycle_no integer;
  v_funded integer := 0;
  v_skipped integer := 0;
  v_total numeric := 0;
  v_notices integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.psm_is_topup_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT partner_id INTO v_partner FROM public.partner_self_commitments WHERE id = p_commitment_id;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'commitment_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-float-' || p_commitment_id::text));

  FOR v_line IN
    SELECT l.id AS line_id,
           l.principal,
           l.rent_request_id,
           rr.status AS rr_status,
           rr.tenant_id,
           rr.landlord_id,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           ld.name AS landlord_name,
           COALESCE(ld.mobile_money_number, ld.phone) AS landlord_phone
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = p_commitment_id
       AND (p_rent_request_ids IS NULL OR l.rent_request_id = ANY(p_rent_request_ids))
     ORDER BY l.created_at
  LOOP
    v_agent := v_line.agent_id;

    IF v_agent IS NULL THEN
      v_skipped := v_skipped + 1;
      PERFORM public.psm_audit(auth.uid(), v_partner, 'float_disbursement_skipped',
        'partner_self_funding_lines', v_line.line_id,
        jsonb_build_object('reason', 'no_agent_assigned', 'rent_request_id', v_line.rent_request_id));
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.agent_landlord_float_allocations a
       WHERE a.rent_request_id = v_line.rent_request_id
         AND a.status IN ('open','partially_paid')
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_landlord_name := COALESCE(v_line.landlord_name, 'Unknown Landlord');
    -- Cycle-aware reference: uq_general_ledger_reference_dedupe is unique on
    -- (user_id, category, reference_id, direction, ledger_scope), so a
    -- second cycle for the same line needs a distinct reference_id, not just
    -- a distinct idempotency_key. Cycle 1 keeps the original bare format for
    -- backward compatibility with anything already parsing it.
    SELECT COALESCE(cycles_disbursed, 0) + 1 INTO v_cycle_no
      FROM public.partner_self_funding_lines WHERE id = v_line.line_id;
    v_ref := 'PSF-' || upper(substr(replace(v_line.line_id::text, '-', ''), 1, 8))
      || CASE WHEN v_cycle_no > 1 THEN '-C' || v_cycle_no::text ELSE '' END;

    INSERT INTO public.agent_landlord_float_allocations (
      agent_id, tenant_id, rent_request_id, landlord_id,
      landlord_name, landlord_phone, allocated_amount, source,
      funded_by_partner_id, funding_reference
    ) VALUES (
      v_agent, v_line.tenant_id, v_line.rent_request_id, v_line.landlord_id,
      v_landlord_name, v_line.landlord_phone, v_line.principal, 'partner_self_funding',
      v_partner, v_ref
    )
    RETURNING id INTO v_alloc;

    v_alloc_ids := v_alloc_ids || v_alloc;

    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount', v_line.principal,
          'category','rent_disbursement','ledger_scope','platform',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Partner self-managed funding released to agent landlord float for ' || v_landlord_name
        ),
        jsonb_build_object(
          'direction','cash_in','amount', v_line.principal,
          'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Landlord float credited (partner-funded) - ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.line_id::text || '-cycle-' || v_cycle_no::text
    );

    INSERT INTO public.agent_float_funding (agent_id, amount, funded_by, rent_request_id, notes)
    VALUES (v_agent, v_line.principal, auth.uid(), v_line.rent_request_id,
            'Partner-funded landlord float for ' || v_landlord_name)
    ON CONFLICT DO NOTHING;

    UPDATE public.rent_requests
       SET status = 'funded',
           funded_at = COALESCE(funded_at, now()),
           self_funding_partner_id = COALESCE(self_funding_partner_id, v_partner),
           self_funding_line_id = COALESCE(self_funding_line_id, v_line.line_id),
           updated_at = now()
     WHERE id = v_line.rent_request_id
       AND status IN ('approved','coo_approved','pending','agent_ops_approved',
                      'tenant_ops_approved','landlord_ops_approved','cfo_approved');

    UPDATE public.partner_self_funding_lines
       SET cycles_disbursed = cycles_disbursed + 1, updated_at = now()
     WHERE id = v_line.line_id;

    v_funded := v_funded + 1;
    v_total := v_total + v_line.principal;
  END LOOP;

  WITH grouped AS (
    SELECT a.agent_id, a.landlord_id,
           MIN(a.landlord_name) AS landlord_name,
           SUM(a.allocated_amount) AS amount,
           COUNT(DISTINCT a.rent_request_id)::int AS tenant_count,
           array_agg(DISTINCT a.rent_request_id) AS rent_request_ids
      FROM public.agent_landlord_float_allocations a
     WHERE a.id = ANY(v_alloc_ids)
       AND a.status NOT IN ('cancelled','reversed')
     GROUP BY a.agent_id, a.landlord_id
  ), ins AS (
    INSERT INTO public.partner_float_agent_notices (
      commitment_id, topup_id, partner_id, agent_id, landlord_id,
      landlord_name, amount, tenant_count, rent_request_ids
    )
    SELECT p_commitment_id, p_topup_id, v_partner, g.agent_id, g.landlord_id,
           COALESCE(g.landlord_name,'the landlord'), g.amount, g.tenant_count, g.rent_request_ids
      FROM grouped g
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_notices FROM ins;

  PERFORM public.psm_audit(auth.uid(), v_partner, 'landlord_float_disbursed',
    'partner_self_commitments', p_commitment_id,
    jsonb_build_object('funded_lines', v_funded, 'skipped_lines', v_skipped,
                       'total_amount', v_total, 'notices_queued', v_notices,
                       'topup_id', p_topup_id));

  RETURN jsonb_build_object('funded', v_funded, 'skipped', v_skipped,
                            'total_amount', v_total, 'notices_queued', v_notices);
END;
$function$;

-- =========================================================================
-- 3. apply_landlord_payout_to_allocation -- identical to the live
--    definition, plus one new block gated strictly on
--    source='partner_self_funding' AND the allocation just reaching
--    'fully_paid'. Every other source's behavior is unchanged.
-- =========================================================================

create or replace function public.apply_landlord_payout_to_allocation()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_alloc_id uuid;
  v_alloc public.agent_landlord_float_allocations%rowtype;
  v_line record;
  v_commitment record;
  v_rent_request record;
  v_days_since integer;
  v_expected_repaid numeric;
  v_has_arrears boolean;
begin
  -- Only act once the agent's float is actually committed to this payout.
  IF NEW.status NOT IN ('pending_finops_disbursement','awaiting_agent_receipt','disbursed','completed') THEN
    RETURN NEW;
  END IF;

  -- Idempotency: never apply the same payout twice as it moves through states.
  IF NEW.allocation_applied_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.rent_request_id IS NULL AND NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Prefer the allocation tied to the exact rent request.
  SELECT id INTO v_alloc_id
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = NEW.agent_id
    AND rent_request_id = NEW.rent_request_id
    AND status IN ('open','partially_paid')
  ORDER BY created_at ASC LIMIT 1;

  -- Fallback: match by tenant.
  IF v_alloc_id IS NULL THEN
    SELECT id INTO v_alloc_id
    FROM public.agent_landlord_float_allocations
    WHERE agent_id = NEW.agent_id
      AND tenant_id IS NOT DISTINCT FROM NEW.tenant_id
      AND status IN ('open','partially_paid')
    ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_alloc_id IS NOT NULL THEN
    UPDATE public.agent_landlord_float_allocations
    SET paid_out_amount = paid_out_amount + NEW.amount
    WHERE id = v_alloc_id
    RETURNING * INTO v_alloc;

    -- Lock this payout so later status changes can't re-apply it.
    UPDATE public.landlord_payouts
    SET allocation_applied_id = v_alloc_id
    WHERE id = NEW.id;

    -- Landlord Float Bucket recycle: this payout completing is the "day the
    -- tenant's rent is released to the landlord" -- the trigger for next
    -- cycle's float becoming available, gated on no arrears. Only for
    -- partner-funded (PSM) allocations that just reached fully_paid.
    if v_alloc.source = 'partner_self_funding' and v_alloc.status = 'fully_paid' then
      select l.id, l.commitment_id, l.term_months, l.cycles_disbursed, l.status
        into v_line
        from public.partner_self_funding_lines l
       where l.rent_request_id = v_alloc.rent_request_id
       order by l.created_at desc
       limit 1;

      if found and v_line.status = 'active' then
        select c.status into v_commitment
          from public.partner_self_commitments c
         where c.id = v_line.commitment_id;

        if found and v_commitment.status = 'active' and v_line.cycles_disbursed < v_line.term_months then
          select * into v_rent_request from public.rent_requests where id = v_alloc.rent_request_id;

          v_days_since := greatest(1, (current_date - coalesce(
            v_rent_request.disbursed_at, v_rent_request.funded_at, v_rent_request.created_at
          )::date));
          v_expected_repaid := least(
            coalesce(v_rent_request.daily_repayment, 0) * v_days_since,
            coalesce(v_rent_request.total_repayment, 0)
          );
          v_has_arrears := v_expected_repaid > coalesce(v_rent_request.amount_repaid, 0);

          if not v_has_arrears then
            -- Trusted-system escape hatch already used elsewhere in PSM for
            -- exactly this purpose: bypasses the human topup-reviewer gate
            -- inside psm_disburse_landlord_float for an automated recycle of
            -- an already-approved commitment.
            perform set_config('psm.owner_release', 'on', true);
            perform public.psm_disburse_landlord_float(v_line.commitment_id, NULL, ARRAY[v_alloc.rent_request_id]);
          end if;
        end if;
      end if;
    end if;
  END IF;

  RETURN NEW;
end;
$$;

-- Trigger definition unchanged -- same function, same attachment.
DROP TRIGGER IF EXISTS trg_landlord_payout_to_allocation ON public.landlord_payouts;
CREATE TRIGGER trg_landlord_payout_to_allocation
AFTER UPDATE OF status ON public.landlord_payouts
FOR EACH ROW EXECUTE FUNCTION public.apply_landlord_payout_to_allocation();

-- =========================================================================
-- 4. enforce_single_live_landlord_payout -- confirmed live (BEFORE INSERT ON
--    landlord_payouts) blocks a second payout for the same rent_request
--    while an earlier one is in ANY status except 'failed'/'escalated' --
--    including 'completed'. Written under the assumption a rent_request
--    only ever gets one landlord payout, ever; the recycle above breaks
--    that assumption on purpose. Per product decision (2026-09-07): only
--    stop treating an earlier payout as "live" once the allocation IT
--    actually applied to has itself reached 'fully_paid' -- i.e. that
--    payout's money is genuinely spent, so a new payout can only mean a
--    new cycle's fresh allocation, never a duplicate against the same
--    money. Every other blocking condition (still open/partially_paid,
--    or not yet resolved to any allocation) is unchanged.
-- =========================================================================

create or replace function public.enforce_single_live_landlord_payout()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_existing uuid;
  v_status text;
BEGIN
  IF NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;

  SELECT lp.id, lp.status INTO v_existing, v_status
  FROM public.landlord_payouts lp
  LEFT JOIN public.agent_landlord_float_allocations alfa ON alfa.id = lp.allocation_applied_id
  WHERE lp.rent_request_id = NEW.rent_request_id
    AND lp.id <> NEW.id
    AND lp.status IN ('otp_verified','pending_merchant_payout','pending_finops_disbursement','disbursing','awaiting_agent_receipt','completed')
    AND NOT (lp.allocation_applied_id IS NOT NULL AND alfa.status = 'fully_paid')
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'This rent cycle already has a landlord payout (%, status %). Refresh your list - this landlord has already been paid for this cycle.', v_existing, v_status
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

-- Trigger definition unchanged -- same function, same attachment.
DROP TRIGGER IF EXISTS trg_enforce_single_live_landlord_payout ON public.landlord_payouts;
CREATE TRIGGER trg_enforce_single_live_landlord_payout
BEFORE INSERT ON public.landlord_payouts
FOR EACH ROW EXECUTE FUNCTION public.enforce_single_live_landlord_payout();
