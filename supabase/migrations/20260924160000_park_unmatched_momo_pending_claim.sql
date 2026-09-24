-- PR A: Park unmatched MoMo as pending claim (no identity mint, no credit).
-- CEO Faith LOCKED defaults (2026-09-24): encode in config + auto_match_audit only.
--
-- 1) Unclaimed TTL: 30 days FinOps queue; no auto-forfeit without Benjamin.
-- 2) Amount ceiling: park ALL sizes; FinOps confirm before invite if > UGX 500,000
--    (invite is PR B — PR A only records needs_finops_confirm_before_invite).
-- 3) Pre-claim visibility: pending amount HIDDEN until OTP claim (user-facing).
-- 4) Withdrawal: no extra hold beyond today's wallet OTP/KYC.
-- 5) Third-party payer: record payer_name for later FinOps confirm in PR C.
-- 6) Credit timing: park only; NEVER approve-deposit until claim_state=claimed (PR C).
--
-- user_id is nullable so Slice A can park without minting an auth user (Slice B).
-- Rows with auto_match_audit.pending_claim=true may have user_id NULL until claim attach.

ALTER TABLE public.deposit_requests
  ALTER COLUMN user_id DROP NOT NULL;

COMMENT ON COLUMN public.deposit_requests.user_id IS
  'Owner profile. NULL allowed only for unmatched MoMo park rows '
  '(auto_match_audit.pending_claim=true / claim_state=awaiting_otp) until PR B attaches a user.';

-- Expression index so FinOps / poller can find parked claims cheaply.
CREATE INDEX IF NOT EXISTS idx_deposit_requests_pending_claim
  ON public.deposit_requests ((auto_match_audit->>'pending_claim'))
  WHERE (auto_match_audit->>'pending_claim') = 'true';

CREATE INDEX IF NOT EXISTS idx_deposit_requests_claim_state
  ON public.deposit_requests ((auto_match_audit->>'claim_state'))
  WHERE (auto_match_audit->>'claim_state') IS NOT NULL;

-- Master kill switch — DEFAULT OFF. Do not enable in prod from this PR.
INSERT INTO public.system_config (key, value, updated_at)
VALUES (
  'auto_account_on_unmatched_momo',
  jsonb_build_object(
    'enabled', false,
    'credit_on_claim', true,
    'finops_confirm_above_ugx', 500000,
    'unclaimed_ttl_days', 30,
    'notes', 'PR A parks only. Invite=PR B. Claim+credit=PR C. Flag OFF by default.'
  ),
  now()
)
ON CONFLICT (key) DO NOTHING;

-- Executives may flip the kill switch (same role set as momo_sender_signup_sms).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'system_config'
      AND policyname = 'Executives update auto_account_on_unmatched_momo'
  ) THEN
    CREATE POLICY "Executives update auto_account_on_unmatched_momo"
    ON public.system_config
    FOR UPDATE
    TO authenticated
    USING (
      key = 'auto_account_on_unmatched_momo'
      AND (
        has_role(auth.uid(), 'manager'::app_role)
        OR has_role(auth.uid(), 'super_admin'::app_role)
        OR has_role(auth.uid(), 'cfo'::app_role)
        OR has_role(auth.uid(), 'ceo'::app_role)
        OR has_role(auth.uid(), 'coo'::app_role)
      )
    )
    WITH CHECK (
      key = 'auto_account_on_unmatched_momo'
      AND (
        has_role(auth.uid(), 'manager'::app_role)
        OR has_role(auth.uid(), 'super_admin'::app_role)
        OR has_role(auth.uid(), 'cfo'::app_role)
        OR has_role(auth.uid(), 'ceo'::app_role)
        OR has_role(auth.uid(), 'coo'::app_role)
      )
    );
  END IF;
END $$;
