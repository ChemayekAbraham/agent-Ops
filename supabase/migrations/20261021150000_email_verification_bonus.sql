-- Move the UGX 100 field bonus from GPS capture to VERIFIED email capture.
--
-- Why
-- ---
-- `profiles.email` is currently a claim, not a fact. EmailEditor.tsx (self mode)
-- calls auth.updateUser() and then writes profiles.email immediately, without
-- waiting for the confirmation link to be clicked; agent mode writes it with no
-- verification at all. That is how 740 ProtonMail addresses landed in a single
-- week (693 of them 18-24 Aug 2026, 212 in one day, local-parts that read like
-- names off a register), and it is almost certainly behind the Supabase bounce
-- warning of 2026-10-20 that `_shared/recipientMailbox.ts` documents.
--
-- Measured 2026-10-21 against production:
--   54,341  placeholder emails (@welile.agent / @welile.user / @noapp.welile.user)
--       94  undeliverable or mistyped (gmsil.com, gmail.comm, mailinator.com, ...)
--    5,313  already valid (gmail, yahoo, icloud, PROTONMAIL, ...) -> NOT eligible
--   37,820  closed accounts (@deleted.invalid)                    -> NOT eligible
-- Eligible population 54,435, so the ceiling is UGX 5,443,500.
--
-- The bonus it replaces, `contact_location_capture`, has paid 20 times ever for
-- UGX 2,000 lifetime. This is therefore NOT a reallocation of spend; it is a new
-- budget line, opened deliberately to make profiles.email mean something.
--
-- Rules (set by Josh, 2026-10-21)
--   * Pays only when the email being REPLACED could not receive mail.
--   * ProtonMail and every other real provider count as valid -> no bonus, but
--     those users may still change address freely.
--   * Self-entered only. An agent cannot claim on a user's behalf.
--   * Accounts created on or after the go-live date are excluded, so the bonus
--     cleans up the existing book instead of paying for new signups
--     (~105 new placeholder accounts a week would otherwise qualify).
--   * One bonus per user, ever.
--
-- Ledger impact: the same shape the GPS bonus already posts, so no new account,
-- no ledger_account_map row and no ledger_category_allowlist change.
--   wallet   referral_bonus    / withdrawable / cash_in  100  -> falls back to L1
--   platform marketing_expense /              / cash_out 100  -> X1
--   => DR X1 100 / CR L1 100
-- Both categories are live under strict mode (marketing_expense posted
-- 2026-10-21, referral_bonus 2026-10-07). The group carries no treasury
-- category, so trg_enforce_ledger_group_mapped_balance logs rather than raises.

-- ---------------------------------------------------------------------------
-- 1. Go-live anchor. Same pattern as rent_arrears_go_live() /
--    agent_arrears_billing_go_live(). Accounts created before this qualify.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_verification_bonus_go_live()
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$ SELECT date '2026-10-21' $fn$;

COMMENT ON FUNCTION public.email_verification_bonus_go_live() IS
  'Accounts created before this date may earn the UGX 100 verified-email bonus. Later signups are excluded so the bonus cleans up the existing book rather than paying for new accounts.';

-- ---------------------------------------------------------------------------
-- 2. Challenge table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_verification_challenges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Normalised (lower/trim) by the caller.
  new_email           text NOT NULL,
  -- Snapshot of profiles.email when the code was requested. The credit step
  -- refuses to pay if the live value has drifted from this.
  old_email           text NOT NULL,
  -- Computed server-side by isPlaceholderRecipient() in the edge function,
  -- which is the single source of truth for deliverability.
  old_email_eligible  boolean NOT NULL DEFAULT false,
  code_hash           text NOT NULL,
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 5,
  send_count          integer NOT NULL DEFAULT 1,
  last_sent_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  verified_at         timestamptz,
  consumed_at         timestamptz,
  bonus_credited_at   timestamptz,
  bonus_skipped_reason text,
  ip_address          text,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_verification_challenges_new_email_shape
    CHECK (position('@' IN new_email) > 1 AND new_email = lower(btrim(new_email)))
);

CREATE INDEX IF NOT EXISTS idx_evc_user_created
  ON public.email_verification_challenges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evc_new_email
  ON public.email_verification_challenges (new_email);
-- One bonus per user, ever — belt to the idempotency key's braces.
CREATE UNIQUE INDEX IF NOT EXISTS uq_evc_one_bonus_per_user
  ON public.email_verification_challenges (user_id)
  WHERE bonus_credited_at IS NOT NULL;

ALTER TABLE public.email_verification_challenges ENABLE ROW LEVEL SECURITY;

-- Readable by the owner only, and never by the code_hash. The client has no
-- need for the hash, but RLS cannot hide a column, so the UI reads through the
-- view below instead and the base table carries no client grants beyond SELECT
-- for staff debugging via service_role.
DROP POLICY IF EXISTS evc_self_read ON public.email_verification_challenges;
CREATE POLICY evc_self_read ON public.email_verification_challenges
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- No client writes at all: both edge functions use the service role.
REVOKE ALL ON public.email_verification_challenges FROM anon, authenticated;
GRANT SELECT ON public.email_verification_challenges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_verification_challenges TO service_role;

COMMENT ON TABLE public.email_verification_challenges IS
  'Email ownership challenges. A row proves a 6-digit code was mailed to new_email and, once verified_at is set, that the owner read it. Written only by the email-verify-request / email-verify-confirm edge functions.';

-- ---------------------------------------------------------------------------
-- 3. Verify the code, adopt the address, and pay — atomically.
--
--    Called only by the email-verify-confirm edge function (service role), so
--    it takes a pre-computed hash: the plaintext code never reaches the
--    database. Closed by default per doc 247 step 23 — no grant to
--    authenticated, deliberately.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_email_verification(
  p_challenge_id uuid,
  p_user_id      uuid,
  p_code_hash    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ch       email_verification_challenges%ROWTYPE;
  v_now      timestamptz := now();
  v_live     text;
  v_created  timestamptz;
  v_amount   numeric := 100;
  v_desc     text := 'Bonus: Email address verified';
  v_group_id uuid;
  v_skip     text;
  v_dom      text;
  -- Mirrors REAL_PROVIDER_DOMAINS in _shared/recipientMailbox.ts. Belt and
  -- braces: even if old_email_eligible arrived wrong, a real provider is never
  -- paid. ProtonMail sits here on purpose — it is a valid mailbox.
  v_real     text[] := ARRAY[
    'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.fr','ymail.com','rocketmail.com',
    'outlook.com','hotmail.com','hotmail.co.uk','live.com','msn.com','icloud.com','me.com','mac.com',
    'protonmail.com','proton.me','pm.me','mail.com','aol.com','gmx.com','zoho.com','privaterelay.appleid.com'
  ];
BEGIN
  SELECT * INTO v_ch FROM email_verification_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','error','reason','challenge_not_found');
  END IF;
  -- Defence in depth: the edge function already checks this, but the challenge
  -- must belong to the caller or a leaked id would be enough to hijack it.
  IF v_ch.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('status','error','reason','challenge_not_found');
  END IF;
  IF v_ch.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status','error','reason','already_used');
  END IF;
  IF v_ch.expires_at <= v_now THEN
    RETURN jsonb_build_object('status','error','reason','expired');
  END IF;
  IF v_ch.attempts >= v_ch.max_attempts THEN
    RETURN jsonb_build_object('status','error','reason','too_many_attempts');
  END IF;

  IF p_code_hash IS NULL OR p_code_hash IS DISTINCT FROM v_ch.code_hash THEN
    UPDATE email_verification_challenges SET attempts = attempts + 1 WHERE id = v_ch.id;
    RETURN jsonb_build_object(
      'status','error','reason','wrong_code',
      'attempts_left', GREATEST(v_ch.max_attempts - (v_ch.attempts + 1), 0)
    );
  END IF;

  -- Correct code. Nobody else may already hold this address.
  IF EXISTS (
    SELECT 1 FROM profiles
     WHERE lower(btrim(email)) = v_ch.new_email AND id <> v_ch.user_id
  ) THEN
    UPDATE email_verification_challenges
       SET consumed_at = v_now, bonus_skipped_reason = 'email_taken'
     WHERE id = v_ch.id;
    RETURN jsonb_build_object('status','error','reason','email_taken');
  END IF;

  -- Read the PRE-update state; the drift check below depends on this ordering.
  SELECT lower(btrim(email)), created_at INTO v_live, v_created
    FROM profiles WHERE id = v_ch.user_id;

  -- Ownership is proven, so adopt the address regardless of whether it pays.
  UPDATE profiles SET email = v_ch.new_email WHERE id = v_ch.user_id;
  UPDATE email_verification_challenges
     SET verified_at = COALESCE(verified_at, v_now), consumed_at = v_now
   WHERE id = v_ch.id;

  v_dom := split_part(v_ch.old_email, '@', 2);
  v_skip := CASE
    WHEN NOT v_ch.old_email_eligible                            THEN 'old_email_was_valid'
    WHEN v_dom = ANY (v_real)                                   THEN 'old_email_was_valid'
    WHEN v_live IS DISTINCT FROM lower(btrim(v_ch.old_email))   THEN 'old_email_changed'
    WHEN (v_created AT TIME ZONE 'Africa/Kampala')::date
           >= public.email_verification_bonus_go_live()         THEN 'account_after_go_live'
    WHEN EXISTS (SELECT 1 FROM email_verification_challenges
                  WHERE user_id = v_ch.user_id AND bonus_credited_at IS NOT NULL)
                                                                THEN 'already_credited'
    ELSE NULL
  END;

  IF v_skip IS NOT NULL THEN
    UPDATE email_verification_challenges SET bonus_skipped_reason = v_skip WHERE id = v_ch.id;
    RETURN jsonb_build_object('status','verified','bonus','skipped',
                              'reason',v_skip,'email',v_ch.new_email);
  END IF;

  BEGIN
    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id',        v_ch.user_id,
          'amount',         v_amount,
          'direction',      'cash_in',
          'category',       'referral_bonus',
          'ledger_scope',   'wallet',
          'wallet_bucket',  'withdrawable',
          'recipient_type', 'user',
          'source_table',   'email_verification_challenges',
          'source_id',      v_ch.id::text,
          'currency',       'UGX',
          'description',    v_desc
        ),
        jsonb_build_object(
          'user_id',      v_ch.user_id,
          'amount',       v_amount,
          'direction',    'cash_out',
          'category',     'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', 'email_verification_challenges',
          'source_id',    v_ch.id::text,
          'currency',     'UGX',
          'description',  'Marketing expense: ' || v_desc
        )
      ),
      'email_verification_bonus:' || v_ch.user_id::text
    );
  EXCEPTION WHEN unique_violation THEN
    UPDATE email_verification_challenges
       SET bonus_skipped_reason = 'already_credited' WHERE id = v_ch.id;
    RETURN jsonb_build_object('status','verified','bonus','skipped',
                              'reason','already_credited','email',v_ch.new_email);
  END;

  -- Two challenges for the same user racing past the EXISTS check would both
  -- reach here; uq_evc_one_bonus_per_user is the last word. Swallow it rather
  -- than rolling back the verified address the user just proved they own.
  BEGIN
    UPDATE email_verification_challenges SET bonus_credited_at = v_now WHERE id = v_ch.id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE email_verification_challenges
       SET bonus_skipped_reason = 'already_credited' WHERE id = v_ch.id;
    RETURN jsonb_build_object('status','verified','bonus','skipped',
                              'reason','already_credited','email',v_ch.new_email);
  END;

  RETURN jsonb_build_object('status','verified','bonus','credited','amount',v_amount,
                            'email',v_ch.new_email,'transaction_group_id',v_group_id);
END;
$fn$;

COMMENT ON FUNCTION public.confirm_email_verification(uuid, uuid, text) IS
  'Verifies an emailed code, adopts the address onto profiles.email, and pays the UGX 100 bonus when the replaced address could not receive mail. Service-role only.';

-- ---------------------------------------------------------------------------
-- 4. Retire the GPS capture bonus.
--
--    The Agent Field Mandate gate stays exactly as it is — agents still must
--    capture a contact's address and GPS before acting on that contact. It
--    simply stops paying, because the UGX 100 now buys a verified mailbox
--    instead. 20 payments were ever made (UGX 2,000, 26 Sep - 20 Oct 2026);
--    none are clawed back.
--
--    Done as a guarded insertion at a stable anchor rather than surgery on the
--    two CASE arms, so the exact whitespace of the live body does not matter.
-- ---------------------------------------------------------------------------
DO $gps$
DECLARE
  v_def text;
  v_anchor text :=
    '  IF p_agent_id IS NULL THEN' || E'\n' ||
    '    RETURN jsonb_build_object(''status'', ''skipped'', ''reason'', ''no_agent'');' || E'\n' ||
    '  END IF;' || E'\n';
  v_guard text :=
    E'\n' ||
    '  -- Retired 2026-10-21: the UGX 100 moved to the verified-email bonus.' || E'\n' ||
    '  -- The Field Mandate still forces capture; it just no longer pays.' || E'\n' ||
    '  IF p_event_type = ''contact_location_capture'' THEN' || E'\n' ||
    '    RETURN jsonb_build_object(''status'', ''skipped'', ''reason'', ''bonus_retired_2026_10_21'');' || E'\n' ||
    '  END IF;' || E'\n';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'credit_agent_event_bonus';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'credit_agent_event_bonus not found';
  END IF;

  IF position('bonus_retired_2026_10_21' IN v_def) > 0 THEN
    RAISE NOTICE 'GPS capture bonus already retired; leaving as is.';
    RETURN;
  END IF;

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Anchor block not found in credit_agent_event_bonus — refusing to patch blind.';
  END IF;

  v_def := replace(v_def, v_anchor, v_anchor || v_guard);
  EXECUTE v_def;
  RAISE NOTICE 'GPS capture bonus retired.';
END
$gps$;
