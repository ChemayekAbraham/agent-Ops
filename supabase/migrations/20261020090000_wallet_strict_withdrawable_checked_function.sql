-- 2026-10-20 (doc 247, step 31): checked function that replaces the browser read of v_user_wallet_strict.
-- ProxyPartnerFunds was the only screen reading the view. The view scans the whole ledger (about 8 s for one user, over the 8 s browser limit), so
-- _wallet_strict_for_users_impl is generated from the LIVE view definition with the user filter pushed into the ledger, anchors, holds and universe
-- (checked identical to the view on 80 random users: 0 mismatches). Nothing is cached. Closed to clients; only the checked wrapper below is callable.
-- Re-run this migration if the view definition changes (the generator asserts the four anchor strings are still unique).
do $do$
declare v text := pg_get_viewdef('public.v_user_wallet_strict'::regclass, true); s int; e int; inner_sql text; n1 int; n2 int; n3 int; n4 int;
begin
  s := position('WITH anchors AS' in v);
  e := position(E') q\n  WHERE CURRENT_USER' in v);
  if s = 0 or e = 0 then raise exception 'view shape changed: % %', s, e; end if;
  inner_sql := substr(v, s, e - s);
  n1 := (length(inner_sql) - length(replace(inner_sql, 'WHERE gl.ledger_scope = ''wallet''::text AND (', '')))/length('WHERE gl.ledger_scope = ''wallet''::text AND (');
  n2 := (length(inner_sql) - length(replace(inner_sql, 'WHERE (wr.status = ANY (ARRAY[', '')))/length('WHERE (wr.status = ANY (ARRAY[');
  n3 := (length(inner_sql) - length(replace(inner_sql, 'FROM wallets_physical', '')))/length('FROM wallets_physical');
  n4 := (length(inner_sql) - length(replace(inner_sql, 'LEFT JOIN holds h ON h.user_id = u.user_id', '')))/length('LEFT JOIN holds h ON h.user_id = u.user_id');
  if (n1,n2,n3,n4) <> (1,1,1,1) then raise exception 'anchors not unique: %,%,%,%', n1,n2,n3,n4; end if;
  inner_sql := replace(inner_sql, 'WHERE gl.ledger_scope = ''wallet''::text AND (', 'WHERE gl.user_id = ANY (p_ids) AND gl.ledger_scope = ''wallet''::text AND (');
  inner_sql := replace(inner_sql, 'WHERE (wr.status = ANY (ARRAY[', 'WHERE (wr.user_id = ANY (p_ids) OR wr.agent_id = ANY (p_ids)) AND (wr.status = ANY (ARRAY[');
  inner_sql := replace(inner_sql, 'FROM wallets_physical', 'FROM wallets_physical WHERE wallets_physical.user_id = ANY (p_ids)');
  inner_sql := replace(inner_sql, 'LEFT JOIN holds h ON h.user_id = u.user_id', 'LEFT JOIN holds h ON h.user_id = u.user_id WHERE u.user_id = ANY (p_ids)');
  execute 'create or replace function public._wallet_strict_for_users_impl(p_ids uuid[]) returns table (user_id uuid, withdrawable numeric, float_balance numeric, advance_balance numeric, pending_holds numeric, restricted_held numeric, total_visible numeric, float_balance_signed numeric) language sql stable security definer set search_path = public as $f$ ' || inner_sql || ' $f$';
  execute 'revoke all on function public._wallet_strict_for_users_impl(uuid[]) from public, anon, authenticated';
  execute 'grant execute on function public._wallet_strict_for_users_impl(uuid[]) to service_role';
end $do$;

create or replace function public.wallet_strict_withdrawable_for_users(p_user_ids uuid[])
returns table (user_id uuid, withdrawable numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ids uuid[] := p_user_ids;
begin
  if public._direct_client_call() then
    if not public.can_view_staff_reports(auth.uid()) then
      select coalesce(array_agg(i), '{}') into v_ids
      from unnest(p_user_ids) i
      where i in (select public.agent_wallet_network_ids(auth.uid()));
    end if;
  end if;
  return query
    select f.user_id, f.withdrawable
    from public._wallet_strict_for_users_impl(v_ids) f;
end;
$$;
revoke all on function public.wallet_strict_withdrawable_for_users(uuid[]) from public, anon;
grant execute on function public.wallet_strict_withdrawable_for_users(uuid[]) to authenticated, service_role;
-- The view stays open to signed-in users until the screen change is published; a later migration closes it.
