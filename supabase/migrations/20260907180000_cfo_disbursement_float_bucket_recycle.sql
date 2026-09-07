-- Indirect (company-funded, cfo_disbursement) landlord float bucket recycle
-- (2026-09-07, follow-up to 20260907150000/160000 which only covered
-- Direct/partner-funded float).
--
-- Confirmed before writing this: fund-agent-landlord-float is a one-time,
-- manual CFO/manager click per rent_request -- it explicitly refuses to
-- re-fund once rent_requests.status='funded', and there is no PSM-style
-- upfront term commitment for company capital (no equivalent of
-- partner_self_commitments/partner_self_funding_lines.term_months on the
-- company side). Product decision (2026-09-07): treat it like PSM's
-- 12-cycle cap anyway, fully automatically, using a fixed default term
-- since there's no per-request term selection today. No principal
-- "release" step is needed here (unlike PSM) -- it's the company's own
-- money, not owed back to an external partner; reaching the cap just
-- means recycling stops.
--
-- Tracking lives on rent_requests (cfo_float_cycles_disbursed) rather than
-- a dedicated line table, since company float has no PSM-style commitment
-- row to hang a counter off -- rent_requests is the one stable record
-- that persists across every cycle's allocation. A row where this is still
-- 0 (never touched) is treated as "1 cycle already happened" (the one that
-- just triggered this very event), so no edge-function change is needed to
-- seed it.
--
-- Reuses create_landlord_float_allocation (already source-agnostic, already
-- dedupes on live open/partially_paid rows) for the recycle itself, then
-- posts the same rent_disbursement/rent_receivable_created ledger pair
-- fund-agent-landlord-float already uses for the initial funding -- with a
-- cycle-numbered idempotency_key so a second cycle doesn't collide with
-- the first (fund-agent-landlord-float's entries carry no reference_id at
-- all, so uq_general_ledger_reference_dedupe never applies here, only the
-- idempotency_key needs to be distinct per cycle).

alter table public.rent_requests
  add column if not exists cfo_float_cycles_disbursed integer not null default 0;

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
  v_cfo_cycles_so_far integer;
  v_ref text;
  v_new_alloc_id uuid;
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

    if v_alloc.status = 'fully_paid' and v_alloc.rent_request_id is not null then
      select * into v_rent_request from public.rent_requests where id = v_alloc.rent_request_id;

      if found then
        v_days_since := greatest(1, (current_date - coalesce(
          v_rent_request.disbursed_at, v_rent_request.funded_at, v_rent_request.created_at
        )::date));
        v_expected_repaid := least(
          coalesce(v_rent_request.daily_repayment, 0) * v_days_since,
          coalesce(v_rent_request.total_repayment, 0)
        );
        v_has_arrears := v_expected_repaid > coalesce(v_rent_request.amount_repaid, 0);

        if v_alloc.source = 'partner_self_funding' then
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
                if not v_has_arrears then
                  perform set_config('psm.owner_release', 'on', true);
                  perform public.psm_disburse_landlord_float(v_line.commitment_id, NULL, ARRAY[v_alloc.rent_request_id]);
                end if;
              else
                perform public.psm_release_line_principal(
                  v_line.id,
                  'Cycle cap reached (' || v_line.cycles_disbursed::text || '/' || v_line.term_months::text || ')'
                );
              end if;
            end if;
          end if;

        elsif v_alloc.source = 'cfo_disbursement' then
          -- Indirect float: fully automatic once first funded, capped at
          -- 12 cycles, no principal release step (it's the company's own
          -- money). A row that's never been recycled reads 0 -- treat that
          -- as "1 cycle already happened" (this very one).
          v_cfo_cycles_so_far := greatest(1, coalesce(v_rent_request.cfo_float_cycles_disbursed, 0));

          if v_cfo_cycles_so_far < 12 and not v_has_arrears then
            -- enforce_single_rent_disbursement blocks a second
            -- category='rent_disbursement' ledger row keyed on
            -- source_table='rent_requests' for the same rent_request,
            -- permanently, with no fully_paid exception -- discovered only
            -- by dry-running this. Point the recycle's ledger entries at
            -- the NEW allocation row instead (same categories, different
            -- source_table/source_id), which the guard's early-exit
            -- condition never matches, exactly how the PSM recycle already
            -- avoids it by using source_table='partner_self_funding_lines'.
            v_new_alloc_id := public.create_landlord_float_allocation(
              v_alloc.agent_id, v_alloc.rent_request_id, v_rent_request.rent_amount, 'cfo_disbursement'
            );

            v_ref := 'fund-agent-landlord-float:' || v_alloc.rent_request_id::text || ':float:cycle-' || (v_cfo_cycles_so_far + 1)::text;
            perform public.create_ledger_transaction(
              entries := jsonb_build_array(
                jsonb_build_object(
                  'direction','cash_out','amount', v_rent_request.rent_amount,
                  'category','rent_disbursement','ledger_scope','platform',
                  'source_table','agent_landlord_float_allocations','source_id', v_new_alloc_id,
                  'user_id', v_alloc.agent_id,
                  'linked_party', v_alloc.landlord_id,
                  'description','Rent float recycled for agent to pay landlord (cycle ' || (v_cfo_cycles_so_far + 1)::text || ')'
                ),
                jsonb_build_object(
                  'direction','cash_in','amount', v_rent_request.rent_amount,
                  'category','rent_receivable_created','ledger_scope','bridge',
                  'source_table','agent_landlord_float_allocations','source_id', v_new_alloc_id,
                  'user_id', v_alloc.agent_id,
                  'linked_party', v_alloc.landlord_id,
                  'description','Landlord float credited (company-funded recycle, cycle ' || (v_cfo_cycles_so_far + 1)::text || ')'
                )
              ),
              idempotency_key := v_ref
            );

            update public.rent_requests
               set cfo_float_cycles_disbursed = v_cfo_cycles_so_far + 1, updated_at = now()
             where id = v_alloc.rent_request_id;
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
