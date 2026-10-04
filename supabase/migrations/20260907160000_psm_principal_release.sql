-- PSM: Principal release, either after the cycle cap or on an
-- ops-approved early withdrawal (2026-09-07, follow-up to
-- 20260907150000_psm_landlord_float_bucket_recycle.sql).
--
-- Confirmed live (before writing this) that nothing anywhere pays PSM
-- principal back to a partner: psm_complete_line_on_plan_close only flips a
-- line's status to 'completed' with no money movement; psm_release_self_
-- funding_line is a pre-payout CANCELLATION path that explicitly refuses to
-- run once anything has been paid out; no trigger reacts to
-- partner_self_commitments.status='matured'. The "final days are reserved
-- for returning principal" language in partner_self_topup_eligibility is a
-- lockout-window description only -- it does not imply a payout mechanism
-- exists, and none was found.
--
-- psm_release_line_principal(p_line_id, p_reason) is the one new function,
-- usable two ways:
--   - Natural completion: called automatically from
--     apply_landlord_payout_to_allocation the moment a line's final cycle
--     (cycles_disbursed already at term_months) is fully paid out -- no
--     approval needed, it's just paying out what the term always implied.
--   - Approved early withdrawal: the same function, called directly by an
--     ops/finance role, works at any point before the cap is reached --
--     gated by the same role check psm_set_line_accrual_mode already uses.
-- Reuses the roi_expense/roi_wallet_credit category pair PSM's own
-- pay_partner_self_cycles already uses for "platform pays partner" --
-- the ledger-category allowlist has nothing more specific for a principal
-- return, and this keeps the convention consistent with returns payouts.

create or replace function public.psm_release_line_principal(
  p_line_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_uid uuid := auth.uid();
  v_line public.partner_self_funding_lines%rowtype;
  v_entries jsonb;
  v_group uuid;
begin
  select * into v_line from public.partner_self_funding_lines where id = p_line_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'line_not_found');
  end if;

  if v_line.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'line_not_active', 'status', v_line.status);
  end if;

  -- Natural completion (the cap was already reached) needs no approval --
  -- it is just paying out what the term always implied. Anything earlier
  -- is an early withdrawal and must be ops-approved.
  if v_line.cycles_disbursed < v_line.term_months then
    if v_uid is null or not (
      public.is_ops_role(v_uid)
      or public.has_role(v_uid, 'cfo'::app_role) or public.has_role(v_uid, 'ceo'::app_role)
      or public.has_role(v_uid, 'partner_ops'::app_role) or public.has_role(v_uid, 'financial_ops'::app_role)
      or public.has_role(v_uid, 'super_admin'::app_role)
    ) then
      raise exception 'NOT_AUTHORIZED: early principal release requires ops approval' using errcode = '42501';
    end if;
  end if;

  v_entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_line.partner_id, 'amount', v_line.principal, 'direction', 'cash_out',
      'category', 'roi_expense', 'ledger_scope', 'platform',
      'source_table', 'partner_self_funding_lines', 'source_id', v_line.id,
      'linked_party', 'platform',
      'description', 'Direct Funding principal released to partner'
        || case when p_reason is not null then ' (' || p_reason || ')' else '' end
    ),
    jsonb_build_object(
      'user_id', v_line.partner_id, 'amount', v_line.principal, 'direction', 'cash_in',
      'category', 'roi_wallet_credit', 'ledger_scope', 'wallet',
      'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'partner_self_funding_lines', 'source_id', v_line.id,
      'linked_party', 'platform',
      'description', 'Principal release payout'
    )
  );

  v_group := public.create_ledger_transaction(
    entries := v_entries,
    idempotency_key := 'psm-principal-release-' || v_line.id::text
  );

  update public.partner_self_funding_lines
     set status = 'completed', completed_at = now(), updated_at = now()
   where id = p_line_id;

  perform public.psm_audit(v_uid, v_line.partner_id, 'principal_released',
    'partner_self_funding_lines', p_line_id,
    jsonb_build_object('amount', v_line.principal, 'cycles_disbursed', v_line.cycles_disbursed,
                       'term_months', v_line.term_months, 'reason', p_reason, 'ledger_group_id', v_group));

  return jsonb_build_object('ok', true, 'line_id', p_line_id, 'amount_released', v_line.principal, 'ledger_group_id', v_group);
end;
$fn$;

revoke all on function public.psm_release_line_principal(uuid, text) from public, anon;
grant execute on function public.psm_release_line_principal(uuid, text) to authenticated, service_role;

-- =========================================================================
-- apply_landlord_payout_to_allocation -- same block as
-- 20260907150000, plus: once cycles_disbursed reaches term_months (no
-- more cycles left to recycle), release the principal instead of doing
-- nothing. Everything else in this function is unchanged.
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
  IF NEW.status NOT IN ('pending_finops_disbursement','awaiting_agent_receipt','disbursed','completed') THEN
    RETURN NEW;
  END IF;

  IF NEW.allocation_applied_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.rent_request_id IS NULL AND NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_alloc_id
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = NEW.agent_id
    AND rent_request_id = NEW.rent_request_id
    AND status IN ('open','partially_paid')
  ORDER BY created_at ASC LIMIT 1;

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

    UPDATE public.landlord_payouts
    SET allocation_applied_id = v_alloc_id
    WHERE id = NEW.id;

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

        if found and v_commitment.status = 'active' then
          if v_line.cycles_disbursed < v_line.term_months then
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
              perform set_config('psm.owner_release', 'on', true);
              perform public.psm_disburse_landlord_float(v_line.commitment_id, NULL, ARRAY[v_alloc.rent_request_id]);
            end if;
          else
            -- No cycles left under the term -- the partner's capital has
            -- run its full course. Release the principal instead of
            -- recycling it into another cycle.
            perform public.psm_release_line_principal(
              v_line.id,
              'Cycle cap reached (' || v_line.cycles_disbursed::text || '/' || v_line.term_months::text || ')'
            );
          end if;
        end if;
      end if;
    end if;
  END IF;

  RETURN NEW;
end;
$$;

DROP TRIGGER IF EXISTS trg_landlord_payout_to_allocation ON public.landlord_payouts;
CREATE TRIGGER trg_landlord_payout_to_allocation
AFTER UPDATE OF status ON public.landlord_payouts
FOR EACH ROW EXECUTE FUNCTION public.apply_landlord_payout_to_allocation();
