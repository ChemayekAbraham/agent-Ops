-- Agent assistant: wallet transactions no longer list admin corrections or reversals.
--
-- The agent's wallet list used to return every wallet ledger row, so "System balance correction"
-- lines (and the totals they feed) reached the agent. It now follows the same rule as a customer's
-- own wallet history:
--   * the platform's is_customer_wallet_history_visible() (hides classification 'admin_correction',
--     correction and reconciliation categories, reversal descriptions);
--   * plus a category exclusion for the kinds that rule does not cover (reversals, bucket
--     reclassifications, balance re-seeds, write-downs, migration and rollback entries);
--   * only production and legacy-real rows.
-- Balances are untouched (the wallet balance is the real balance), so the list may not add up to it.
-- The tool description and prompt tell the model never to try to reconcile the two.

create or replace function public.assistant_agent_wallet_transactions(
  p_from      date default null,
  p_to        date default null,
  p_direction text default null,
  p_limit     integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_from  date;
  v_to    date;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_dir   text := lower(nullif(btrim(coalesce(p_direction, '')), ''));
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  v_to   := coalesce(p_to, v_today);
  v_from := coalesce(p_from, v_to - 6);
  if v_from > v_to or v_to - v_from > 92 or v_to > v_today then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_dir is not null and v_dir not in ('in', 'out') then
    raise exception 'invalid_direction' using errcode = '22023';
  end if;

  with rows_in_range as (
    select gl.transaction_date, gl.amount, gl.category,
           case when gl.direction in ('cash_in', 'credit') then 'in' else 'out' end as dir
      from public.general_ledger gl
     where gl.user_id = v_uid
       and gl.ledger_scope = 'wallet'
       and coalesce(gl.classification, 'production') in ('production', 'legacy_real')
       and public.is_customer_wallet_history_visible(
             gl.user_id, gl.classification, gl.category, gl.source_table, gl.description, gl.reference_id, gl.source_id)
       and gl.category !~* '(revers|correct|adjust|reclass|reseed|writedown|migration|rollback|backfill|reconcil)'
       and lower(coalesce(gl.description, '')) !~ '(revers|correct|adjust|erroneous|reconcil|rollback)'
       and (gl.transaction_date at time zone 'Africa/Kampala')::date between v_from and v_to
  ),
  filtered as (
    select * from rows_in_range where v_dir is null or dir = v_dir
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'direction_filter', v_dir,
    'count', (select count(*) from filtered),
    'total_in',  coalesce((select sum(amount) from filtered where dir = 'in'), 0),
    'total_out', coalesce((select sum(amount) from filtered where dir = 'out'), 0),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', (f.transaction_date at time zone 'Africa/Kampala')::date,
               'direction', f.dir,
               'amount', f.amount,
               'category', f.category) order by f.transaction_date desc)
        from (select * from filtered order by transaction_date desc limit v_limit) f
    ), '[]'::jsonb),
    'note', 'Customer-facing entries only. This list is not a full ledger and may not add up to the wallet balance.'
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_agent_wallet_transactions(date, date, text, integer) from public, anon;
grant  execute on function public.assistant_agent_wallet_transactions(date, date, text, integer) to authenticated, service_role;