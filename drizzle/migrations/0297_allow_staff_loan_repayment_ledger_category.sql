do $mig$
declare v_before integer; v_list text; v_sql text; v_after integer;
begin
  v_before := cardinality(public.ledger_category_allowlist());
  if v_before <> 125 then
    raise exception 'ABORT: allowlist holds %, expected 125. It changed since this was written.', v_before;
  end if;

  select string_agg(quote_literal(c), ', ' order by c) into v_list
  from (select distinct unnest(public.ledger_category_allowlist()
                               || array['staff_loan_repayment']) as c) x;

  v_sql := 'create or replace function public.ledger_category_allowlist() '
        || 'returns text[] language sql immutable as $body$ select array['
        || v_list || ']::text[] $body$;';
  execute v_sql;

  v_after := cardinality(public.ledger_category_allowlist());
  if v_after <> 126 then raise exception 'FAIL A: allowlist holds %, expected 126', v_after; end if;
  if not public.validate_ledger_category('staff_loan_repayment') then
    raise exception 'FAIL B: staff_loan_repayment not allowed';
  end if;
  if not (public.validate_ledger_category('salary_payout')
      and public.validate_ledger_category('facilitation_disbursement')
      and public.validate_ledger_category('rent_repayment')
      and public.validate_ledger_category('wallet_withdrawal')
      and public.validate_ledger_category('🔧 Manual Adjustment')) then
    raise exception 'FAIL C: an existing category was lost';
  end if;

  raise notice 'LEDGER-CATEGORY-LOAN-2026-09-21-Z PASSED — % categories, was %', v_after, v_before;
end $mig$;