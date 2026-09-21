-- =====================================================================
-- LEDGER-CATEGORY-2026-09-21-V
-- Declare one new ledger category: facilitation_disbursement
--
-- Treasury strict_mode is on, so any posting outside the allowlist is
-- refused. PSO facilitation released to an officer's wallet needs its own
-- category rather than borrowing one, so it can be reported separately.
--
-- The new list is built FROM the live list at migration time rather than
-- retyped, so no existing category can be lost to a typing error.
-- =====================================================================

do $mig$
declare
  v_before integer;
  v_list   text;
  v_sql    text;
  v_after  integer;
begin
  v_before := cardinality(public.ledger_category_allowlist());
  if v_before <> 124 then
    raise exception 'ABORT: allowlist holds % categories, expected 124. It changed since this was written.', v_before;
  end if;

  select string_agg(quote_literal(c), ', ' order by c)
    into v_list
  from (
    select distinct unnest(
      public.ledger_category_allowlist() || array['facilitation_disbursement']
    ) as c
  ) x;

  v_sql := 'create or replace function public.ledger_category_allowlist() '
        || 'returns text[] language sql immutable as $body$ select array['
        || v_list || ']::text[] $body$;';

  execute v_sql;

  v_after := cardinality(public.ledger_category_allowlist());
  if v_after <> 125 then
    raise exception 'FAIL A: allowlist now holds %, expected 125', v_after;
  end if;
  if not public.validate_ledger_category('facilitation_disbursement') then
    raise exception 'FAIL B: facilitation_disbursement not allowed';
  end if;
  if not (public.validate_ledger_category('salary_payout')
      and public.validate_ledger_category('rent_repayment')
      and public.validate_ledger_category('wallet_withdrawal')
      and public.validate_ledger_category('agent_commission')
      and public.validate_ledger_category('payroll_expense')
      and public.validate_ledger_category('🔧 Manual Adjustment')) then
    raise exception 'FAIL C: an existing category was lost';
  end if;

  raise notice 'LEDGER-CATEGORY-2026-09-21-V PASSED — % categories, was %', v_after, v_before;
end
$mig$;

-- =====================================================================
-- END LEDGER-CATEGORY-2026-09-21-V
-- =====================================================================
