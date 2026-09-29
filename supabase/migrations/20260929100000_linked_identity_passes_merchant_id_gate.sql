-- Linked-identity accounts were still invisible to Merchant Agents.
--
-- 20260924100000 let an account that borrows another person's National ID
-- (with that person's OTP consent + staff approval) complete its identity
-- binding, so `submit_withdrawal_request` accepts its withdrawals. It missed the
-- second gate: `withdrawal_user_id_verified`, which `withdrawal_merchant_id_gate`
-- uses to decide what the merchant queue shows, what `claim_withdrawal_verified`
-- lets a merchant claim and what `auto_dispatch_withdrawals` dispatches. That
-- function still demanded the account's OWN id photo and selfie - which a
-- linked account by definition does not have.
--
-- Result: the withdrawal is accepted and then sits in `pending` forever, never
-- shown to any merchant. Mukisa juli (+256707911662), UGX 92,000 since
-- 2026-09-24 13:51 EAT, is the case that surfaced it. Twahir Ngobya and Hassan
-- Hussein are in the same state (no open withdrawal at the time of writing).
--
-- THE RULE ADDED
-- A non-revoked binding with capture_source = 'linked_id_owner' counts as
-- verified, but only while the consent behind it still stands:
--   * the account's national_id_link_requests row is 'active' (holder OTP +
--     holder approval + staff decision), and
--   * the ID owner's own binding is still non-revoked.
-- The binding itself already guarantees the stricter linked-account bar from
-- 20260924100000: the owner's documents exist and the account proved ownership
-- of its own payout number with a code.
--
-- NOT CHANGED: every existing path (exceptions, funders, own documents + a
-- verified destination) is restated verbatim.

CREATE OR REPLACE FUNCTION public.withdrawal_user_id_verified(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.id_verification_exceptions e
    where e.user_id = p_user_id and e.revoked_at is null
  )
  or public.user_is_funder_with_portfolio(p_user_id)
  or (
    exists (
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
  )
  -- Linked identity: bound against a verified owner's documents, consent live.
  or exists (
    select 1
    from public.user_identity_bindings b
    join public.national_id_link_requests l
      on l.requester_id = p_user_id
     and l.status = 'active'
    join public.profiles o
      on btrim(coalesce(o.national_id, '')) = btrim(coalesce(b.linked_national_id, ''))
     and btrim(coalesce(o.national_id, '')) <> ''
    join public.user_identity_bindings ob
      on ob.user_id = o.id
     and ob.status <> 'revoked'
    where b.user_id = p_user_id
      and b.status <> 'revoked'
      and b.capture_source = 'linked_id_owner'
  )
$function$;

-- Verify ------------------------------------------------------------------------
DO $verify$
BEGIN
  IF NOT public.withdrawal_user_id_verified('0a460971-9272-4bf5-b909-99b9617d42b0'::uuid) THEN
    RAISE EXCEPTION 'Mukisa juli still fails the merchant ID gate - rolled back';
  END IF;
END $verify$;
