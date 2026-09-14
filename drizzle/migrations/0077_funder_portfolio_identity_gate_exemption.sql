-- Funders holding an investor portfolio are onboarded and vetted through the
-- portfolio flow (signed agreement, payout details captured on the portfolio),
-- so they are exempt from the National ID / selfie identity gate and from the
-- payout-destination verification gate on self-service withdrawals.

CREATE OR REPLACE FUNCTION public.user_is_funder_with_portfolio(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select exists (
    select 1
    from public.investor_portfolios ip
    where ip.investor_id = p_user_id
      and lower(coalesce(ip.status, '')) not in ('cancelled', 'rejected', 'deleted')
  )
$$;

GRANT EXECUTE ON FUNCTION public.user_is_funder_with_portfolio(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.withdrawal_user_id_verified(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.enforce_withdrawal_destination_verified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF lower(coalesce(NEW.payout_method,'')) NOT IN ('mobile_money','bank_transfer') THEN
    RETURN NEW;
  END IF;
  -- Only the self-service path is gated here; ops/system-initiated rows keep working.
  IF NEW.initiated_by IS DISTINCT FROM NEW.user_id THEN
    RETURN NEW;
  END IF;
  -- Funders with an investor portfolio are exempt.
  IF public.user_is_funder_with_portfolio(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  IF NOT public.payout_destination_is_verified(
       NEW.user_id, NEW.payout_method, NEW.mobile_money_number, NEW.bank_name, NEW.bank_account_number) THEN
    RAISE EXCEPTION 'This payout destination is not yet verified. Financial Ops will call you to confirm it belongs to you.';
  END IF;

  RETURN NEW;
END;
$$;