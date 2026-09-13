-- get_transfer_peers_by_ids: profile (name + photo) for users the caller has
-- personally exchanged wallet transfers with. Same exposure rule as
-- get_transfer_peers — the EXISTS gate limits results to counterparties of
-- the caller's own wallet_transactions, so arbitrary profile enumeration is
-- impossible. Read-only; exists so person-to-person timelines that key on
-- user ids (not ledger reference ids) can show WHO the money moved with.
create or replace function public.get_transfer_peers_by_ids(p_user_ids uuid[])
returns table (
  peer_user_id uuid,
  peer_name text,
  peer_avatar_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id as peer_user_id,
    coalesce(p.full_name, 'Welile user') as peer_name,
    p.avatar_url as peer_avatar_url
  from profiles p
  where p.id = any(p_user_ids)
    and coalesce(array_length(p_user_ids, 1), 0) between 1 and 100
    and exists (
      select 1
      from wallet_transactions wt
      where (wt.sender_id = auth.uid() and wt.recipient_id = p.id)
         or (wt.recipient_id = auth.uid() and wt.sender_id = p.id)
    )
$$;

revoke all on function public.get_transfer_peers_by_ids(uuid[]) from public;
grant execute on function public.get_transfer_peers_by_ids(uuid[]) to authenticated;