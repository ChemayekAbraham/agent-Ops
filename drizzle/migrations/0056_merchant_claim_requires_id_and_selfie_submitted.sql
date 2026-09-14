-- Merchant agents may only see/claim a withdrawal when the customer has
-- (a) submitted their National ID number, (b) submitted both the National ID
-- photo and the selfie, and (c) had a payout destination verified by
-- Financial Ops. All three merchant paths (RLS select, RLS claim update,
-- auto-dispatch and claim_withdrawal_verified) call this one helper.
create or replace function public.withdrawal_user_id_verified(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = p_user_id
      and coalesce(btrim(p.national_id), '') <> ''
      and coalesce(btrim(p.national_id_photo_path), '') <> ''
      and coalesce(btrim(p.selfie_photo_path), '') <> ''
  )
  and exists (
    select 1
    from public.payout_destination_verifications v
    where v.user_id = p_user_id
      and v.status = 'verified'
  )
$$;