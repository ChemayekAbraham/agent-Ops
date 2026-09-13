-- Closes the account-takeover gap flagged 2026-09-14: submit_withdrawal_request
-- lets anyone with an open session on an account type in ANY mobile-money
-- number/name or bank account and submit it as the payout destination. The
-- only existing guard, trg_enforce_withdrawal_payout_account_lock (2026-09-13),
-- only blocks CHANGING an already-registered number -- it does nothing on a
-- first-ever destination for an account, and Financial Ops' own manual
-- call-based verification (finops_decide_payout_destination) only proves the
-- typed-in number is live and answered, not that whoever answered is the
-- account's real owner. Someone who merely gained session/credential access
-- (not the victim's real phone) could register their own number as the
-- account's permanent payout destination.
--
-- Fix: gate mobile_money and bank_transfer withdrawals (destination-bearing
-- methods only -- cash pickup has no destination-redirection surface) behind
-- an OTP sent to the account's OWN registered profiles.phone (the channel
-- tied to signup/login), separate from the payout number being entered.
-- Whoever completes the withdrawal must currently control that original
-- phone, independent of whether they merely have an open session. Mirrors
-- the existing landlord_payout_otp_challenges / verify-landlord-payout-otp
-- pattern already in production for the equivalent landlord-payout case.
--
-- KNOWN REMAINING GAP (not addressed by this migration, flagging for a
-- follow-up decision): profiles.phone itself can be changed via Settings
-- without re-verifying the OLD number first -- trg_normalize_validate_profile_
-- phone and trg_prevent_duplicate_phone_update only normalise/dedupe, they do
-- not require proving control of the phone being replaced. This migration
-- still closes the realistic case (stolen session/credentials on an account
-- whose real registered phone the attacker does NOT also control) but does
-- not close the compound case of an attacker who ALSO first changes the
-- account's registered phone. That would need the same OTP-the-old-number
-- treatment applied to profile phone changes -- out of scope here.

CREATE TABLE public.wallet_withdrawal_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_request_id uuid NOT NULL,
  amount numeric NOT NULL,
  payout_method text NOT NULL CHECK (payout_method IN ('mobile_money', 'bank_transfer')),
  mobile_money_number text,
  mobile_money_name text,
  mobile_money_provider text,
  bank_name text,
  bank_account_number text,
  bank_account_name text,
  reason text,
  -- Snapshot of profiles.phone at issue time -- the channel the OTP was
  -- actually sent to, kept for audit even if the profile phone later changes.
  account_phone text NOT NULL,
  otp_hash text NOT NULL,
  otp_expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'failed')),
  verified_at timestamptz,
  resulting_withdrawal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_request_id)
);

CREATE INDEX idx_wallet_withdrawal_otp_challenges_user_status
  ON public.wallet_withdrawal_otp_challenges (user_id, status);

CREATE TABLE public.wallet_withdrawal_otp_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL REFERENCES public.wallet_withdrawal_otp_challenges(id),
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  failure_reason text,
  detail text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_withdrawal_otp_events_challenge
  ON public.wallet_withdrawal_otp_events (challenge_id, created_at DESC);

-- RLS enabled, deliberately zero policies: the client never queries these
-- tables directly (not even to poll status). Every interaction goes through
-- issue-wallet-withdrawal-otp / verify-wallet-withdrawal-otp, which run as
-- service_role (bypasses RLS) and return only a whitelisted subset of fields
-- (masked phone, expiry, attempts_left) -- otp_hash and the full account
-- phone are never exposed to the client, unlike a direct-select policy would.
ALTER TABLE public.wallet_withdrawal_otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_withdrawal_otp_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.wallet_withdrawal_otp_challenges_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_wallet_withdrawal_otp_challenges_touch
  BEFORE UPDATE ON public.wallet_withdrawal_otp_challenges
  FOR EACH ROW EXECUTE FUNCTION public.wallet_withdrawal_otp_challenges_touch_updated_at();
