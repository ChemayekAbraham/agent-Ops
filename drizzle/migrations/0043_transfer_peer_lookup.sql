-- get_transfer_peers: lets a signed-in user see WHO was on the other side of
-- their own wallet transfers (name + photo), keyed by the shared transfer
-- reference that both ledger legs carry.
--
-- Why SECURITY DEFINER: the peer's profiles row is not readable through RLS
-- for an ordinary user, and we deliberately do NOT widen profiles policies.
-- The function can only ever expose the counterparty of a transfer the caller
-- personally took part in — the `me.user_id = auth.uid()` leg is the caller's
-- own ledger entry, so enumerating other users' profiles is impossible.
-- Read-only; writes nothing.
create or replace function public.get_transfer_peers(p_reference_ids text[])
returns table (
  reference_id text,
  peer_user_id uuid,
  peer_name text,
  peer_avatar_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (me.reference_id)
    me.reference_id,
    peer.user_id as peer_user_id,
    coalesce(p.full_name, me.linked_party, 'Welile user') as peer_name,
    p.avatar_url as peer_avatar_url
  from general_ledger me
  join general_ledger peer
    on peer.reference_id = me.reference_id
   and peer.ledger_scope = 'wallet'
   and peer.source_table = 'wallet_transactions'
   and peer.user_id <> me.user_id
  left join profiles p on p.id = peer.user_id
  where me.user_id = auth.uid()
    and me.ledger_scope = 'wallet'
    and me.source_table = 'wallet_transactions'
    and me.reference_id = any(p_reference_ids)
    -- Hard cap: one call enriches at most one feed page / timeline batch.
    and coalesce(array_length(p_reference_ids, 1), 0) between 1 and 100
$$;

revoke all on function public.get_transfer_peers(text[]) from public;
grant execute on function public.get_transfer_peers(text[]) to authenticated;