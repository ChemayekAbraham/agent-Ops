-- Automated bot-referral-ring hunter.
--
-- Everything up to this point (docs/HANDOVER/21, 22) was manual: a human
-- (Claude, directed by Josh) noticed a screenshot, investigated, and ran a
-- one-time cleanup. This migration turns the exact detection logic that was
-- validated by hand this session into a standing, scheduled job that finds
-- and neutralizes new rings on its own, on a 30-minute cadence.
--
-- Detection signal (validated 2026-09-14 against real data): a referrer
-- whose referred cohort, in a recent window, is BOTH large AND reuses one
-- or two names across most of it AND is mostly non-synthetic email. This
-- combination correctly identified all 24 confirmed fraud referrers and
-- correctly cleared the one real high-volume agent checked
-- (864b1df4..., 1,456 real sub-agent signups, 89% distinct names, 99%
-- synthetic @welile.agent emails -- excluded by both thresholds below).
--
--   referred_count   >= 15   in the last 48 hours
--   distinct_names / referred_count < 0.4   (a bot reuses 1-2 fake names)
--   synthetic_email / referred_count < 0.5  (excludes @welile.agent/@welile.user/
--                                             @noapp.welile.user -- the legitimate
--                                             agent-assisted registration paths)
--
-- Action taken, both reversible, neither touches ledger history:
--   1. Freeze the referrer via the existing fraud_block_user_identifiers()
--      (blocks every identifier they've used for payouts too).
--   2. Soft-delete the referred bot cohort (unconfirmed email, not already
--      deleted) the same way admin_soft_delete_account() does.
-- Every detection is logged to bot_referral_ring_detections regardless of
-- outcome, so this is fully auditable and any action can be reviewed or
-- reversed.
--
-- This is a backstop, not a replacement for the real-time signup-velocity
-- guard in handle_new_user() (20260914170000) -- that one blocks the
-- account from ever being created; this one cleans up whatever gets
-- through it (e.g. several different referrer identities each staying
-- under that guard's per-referrer cap). It does not cover a bot ring with
-- no referrer_id at all -- see "Known limits" in
-- docs/HANDOVER/23-automated-bot-referral-ring-hunter.md.

CREATE TABLE IF NOT EXISTS public.bot_referral_ring_detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  referred_count integer NOT NULL,
  distinct_names integer NOT NULL,
  synthetic_email_count integer NOT NULL,
  span_hours numeric,
  action_taken text NOT NULL, -- 'frozen_and_purged' | 'already_frozen_purged_new' | 'skipped_already_handled'
  bots_soft_deleted integer NOT NULL DEFAULT 0,
  notes text
);

CREATE INDEX IF NOT EXISTS idx_bot_referral_ring_detections_referrer
  ON public.bot_referral_ring_detections (referrer_id, detected_at DESC);

ALTER TABLE public.bot_referral_ring_detections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cto_ops_can_view_bot_ring_detections"
  ON public.bot_referral_ring_detections FOR SELECT
  USING (
    has_role(auth.uid(), 'cto') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'ceo')
  );
-- No INSERT/UPDATE/DELETE policies for any client-facing role: only the
-- SECURITY DEFINER function below (and manual superuser/migration access)
-- writes to this table.

CREATE OR REPLACE FUNCTION public.scan_and_quarantine_bot_referral_rings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6'; -- Josh Wanda, standing authorization for this policy
  v_reason text;
  r RECORD;
  v_bot_ids uuid[];
  v_bot_count int;
  v_detections int := 0;
  v_frozen int := 0;
  v_purged int := 0;
BEGIN
  FOR r IN
    WITH recent AS (
      SELECT p.id, p.referrer_id, p.full_name
      FROM public.profiles p
      WHERE p.referrer_id IS NOT NULL
        AND p.deleted_at IS NULL
        AND p.created_at > now() - interval '48 hours'
    ),
    agg AS (
      SELECT
        rec.referrer_id,
        count(*) AS referred_count,
        count(DISTINCT rec.full_name) AS distinct_names,
        min(p2.created_at) AS first_seen,
        max(p2.created_at) AS last_seen,
        count(*) FILTER (
          WHERE u.email LIKE '%@welile.agent'
             OR u.email LIKE '%@welile.user'
             OR u.email LIKE '%@noapp.welile.user'
        ) AS synthetic_email_count
      FROM recent rec
      JOIN public.profiles p2 ON p2.id = rec.id
      LEFT JOIN auth.users u ON u.id = rec.id
      GROUP BY rec.referrer_id
    )
    SELECT a.*, rp.is_frozen AS referrer_already_frozen,
           extract(epoch FROM (a.last_seen - a.first_seen)) / 3600.0 AS span_hours
    FROM agg a
    JOIN public.profiles rp ON rp.id = a.referrer_id
    WHERE a.referred_count >= 15
      AND (a.distinct_names::numeric / a.referred_count) < 0.4
      AND (a.synthetic_email_count::numeric / a.referred_count) < 0.5
  LOOP
    v_detections := v_detections + 1;
    v_reason := format(
      'Automated bot-referral-ring hunter: %s referred accounts in the last 48h, only %s distinct name(s), %s%% non-synthetic email. Detected %s.',
      r.referred_count, r.distinct_names,
      round(100 - (r.synthetic_email_count::numeric / r.referred_count * 100), 0),
      now()
    );

    IF NOT r.referrer_already_frozen THEN
      PERFORM public.fraud_block_user_identifiers(r.referrer_id, v_reason, v_actor);
      v_frozen := v_frozen + 1;
    END IF;

    -- Soft-delete this referrer's not-yet-purged bot cohort (unconfirmed
    -- email), mirroring admin_soft_delete_account()'s effect, using the same
    -- explicit capture-then-act sequence already run manually (and verified)
    -- three times today rather than a single chained-CTE statement that has
    -- never actually fired against a real match in production. Naturally
    -- idempotent: an account already soft-deleted (deleted_at set) is
    -- excluded, so re-running this scan is always safe.
    SELECT array_agg(p.id) INTO v_bot_ids
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
    WHERE p.deleted_at IS NULL
      AND p.referrer_id = r.referrer_id
      AND u.email_confirmed_at IS NULL;

    v_bot_count := COALESCE(array_length(v_bot_ids, 1), 0);

    IF v_bot_count > 0 THEN
      INSERT INTO public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
      SELECT p.id, p.full_name, p.email, p.phone, p.national_id,
             COALESCE(
               (SELECT jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true))
                FROM public.user_roles ur WHERE ur.user_id = p.id),
               '[]'::jsonb
             ),
             'soft_deleted',
             v_reason || ' Referred by ' || r.referrer_id::text || '.',
             v_actor
      FROM public.profiles p
      WHERE p.id = ANY(v_bot_ids);

      DELETE FROM public.user_roles WHERE user_id = ANY(v_bot_ids);
      DELETE FROM public.push_subscriptions WHERE user_id = ANY(v_bot_ids);

      UPDATE public.profiles p SET
        full_name = CASE WHEN p.full_name LIKE '[DELETED]%' THEN p.full_name ELSE '[DELETED] ' || COALESCE(p.full_name,'Account') END,
        previous_full_name = COALESCE(p.previous_full_name, p.full_name),
        email = 'deleted+' || p.id::text || '@deleted.invalid',
        phone = NULL, national_id = NULL, mobile_money_number = NULL,
        is_frozen = true, frozen_at = COALESCE(p.frozen_at, now()),
        frozen_reason = 'Account deleted: automated bot-referral-ring hunter, ' || now()::text,
        deleted_at = now(), deleted_by = v_actor,
        deletion_reason = v_reason
      WHERE p.id = ANY(v_bot_ids);

      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      SELECT v_actor, 'soft_delete_account', 'soft_delete_account', 'profiles', bot_id::text,
        jsonb_build_object('reason', v_reason, 'performed_by', v_actor, 'automated', true, 'referrer_id', r.referrer_id)
      FROM unnest(v_bot_ids) AS bot_id;
    END IF;

    v_purged := v_purged + v_bot_count;

    INSERT INTO public.bot_referral_ring_detections (
      referrer_id, referred_count, distinct_names, synthetic_email_count,
      span_hours, action_taken, bots_soft_deleted, notes
    ) VALUES (
      r.referrer_id, r.referred_count, r.distinct_names, r.synthetic_email_count,
      r.span_hours,
      CASE WHEN r.referrer_already_frozen THEN 'already_frozen_purged_new' ELSE 'frozen_and_purged' END,
      v_bot_count, v_reason
    );
  END LOOP;

  RETURN jsonb_build_object(
    'scanned_at', now(),
    'rings_detected', v_detections,
    'referrers_newly_frozen', v_frozen,
    'bot_accounts_purged', v_purged
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.scan_and_quarantine_bot_referral_rings() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'scan-bot-referral-rings',
  '*/30 * * * *',
  $$SELECT public.scan_and_quarantine_bot_referral_rings();$$
);
