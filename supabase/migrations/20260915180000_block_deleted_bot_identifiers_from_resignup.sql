-- Gap: scan_and_quarantine_bot_referral_rings() soft-deletes bot accounts
-- (scrubbing their email/phone to a placeholder, per profiles.deleted_at)
-- but NEVER added their original email/phone/national_id to
-- fraud_identity_blocks first. handle_new_user() already refuses signup for
-- any blocked identifier (public.is_fraud_identifier_blocked checks) — but
-- since the purge never populated that table for individual bot accounts
-- (only for the referrer), the exact same email/phone that was just purged
-- as fraud was free to sign up again immediately after deletion.
--
-- Two parts:
--   1. Fix scan_and_quarantine_bot_referral_rings() so every purge, from now
--      on, blocks the account's identifiers BEFORE scrubbing them away
--      (order matters: fraud_block_user_identifiers reads live profiles
--      data, so it must run before the UPDATE that nulls it out).
--   2. One-time backfill: block every identifier already sitting in
--      deleted_accounts (captured pre-scrub, so it still holds the original
--      values) for every account purged before this fix existed.
CREATE OR REPLACE FUNCTION public.scan_and_quarantine_bot_referral_rings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_reason text;
  r RECORD;
  v_bot_ids uuid[];
  v_bot_id uuid;
  v_bot_count int;
  v_detections int := 0;
  v_frozen int := 0;
  v_purged int := 0;
  v_orphan_purged int := 0;
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

    -- Always block the referrer's identifiers, not only when newly frozen —
    -- an account frozen by some other path (manual review, a different
    -- sweep) may never have had its identifiers blocked either.
    BEGIN
      PERFORM public.fraud_block_user_identifiers(r.referrer_id, v_reason, v_actor);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'scan_and_quarantine_bot_referral_rings: fraud_block_user_identifiers failed for referrer %: %', r.referrer_id, SQLERRM;
    END;
    IF NOT r.referrer_already_frozen THEN
      v_frozen := v_frozen + 1;
    END IF;

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

      -- Block each bot's identifiers BEFORE the scrub below overwrites them —
      -- fraud_block_user_identifiers reads live profiles.email/phone/etc.
      FOREACH v_bot_id IN ARRAY v_bot_ids LOOP
        BEGIN
          PERFORM public.fraud_block_user_identifiers(v_bot_id, v_reason, v_actor);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'scan_and_quarantine_bot_referral_rings: fraud_block_user_identifiers failed for bot %: %', v_bot_id, SQLERRM;
        END;
      END LOOP;

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

  -- Orphan sweep (see docs/HANDOVER/24): a signup attempt naming an
  -- ALREADY-frozen referrer gets its referrer_id silently stripped by
  -- handle_new_user(), so the bot account survives with no referrer_id at
  -- all and is invisible to the loop above. Recover the original attempted
  -- referrer_id from raw_user_meta_data and purge if it points at any
  -- currently-frozen profile.
  SELECT array_agg(p.id) INTO v_bot_ids
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  JOIN public.profiles rp ON rp.id = (u.raw_user_meta_data->>'referrer_id')::uuid
  WHERE p.deleted_at IS NULL
    AND p.referrer_id IS NULL
    AND u.email_confirmed_at IS NULL
    AND u.raw_user_meta_data->>'referrer_id' IS NOT NULL
    AND rp.is_frozen = true
    AND p.created_at > now() - interval '7 days';

  v_orphan_purged := COALESCE(array_length(v_bot_ids, 1), 0);

  IF v_orphan_purged > 0 THEN
    v_reason := format('Automated bot-referral-ring hunter (orphan sweep): signup metadata names an already-frozen referrer, so profiles.referrer_id was stripped at creation time. Detected %s.', now());

    INSERT INTO public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
    SELECT p.id, p.full_name, p.email, p.phone, p.national_id,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true)) FROM public.user_roles ur WHERE ur.user_id = p.id), '[]'::jsonb),
           'soft_deleted', v_reason, v_actor
    FROM public.profiles p WHERE p.id = ANY(v_bot_ids);

    FOREACH v_bot_id IN ARRAY v_bot_ids LOOP
      BEGIN
        PERFORM public.fraud_block_user_identifiers(v_bot_id, v_reason, v_actor);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'scan_and_quarantine_bot_referral_rings (orphan sweep): fraud_block_user_identifiers failed for bot %: %', v_bot_id, SQLERRM;
      END;
    END LOOP;

    DELETE FROM public.user_roles WHERE user_id = ANY(v_bot_ids);
    DELETE FROM public.push_subscriptions WHERE user_id = ANY(v_bot_ids);

    UPDATE public.profiles p SET
      full_name = CASE WHEN p.full_name LIKE '[DELETED]%' THEN p.full_name ELSE '[DELETED] ' || COALESCE(p.full_name,'Account') END,
      previous_full_name = COALESCE(p.previous_full_name, p.full_name),
      email = 'deleted+' || p.id::text || '@deleted.invalid',
      phone = NULL, national_id = NULL, mobile_money_number = NULL,
      is_frozen = true, frozen_at = COALESCE(p.frozen_at, now()),
      frozen_reason = 'Account deleted: automated bot-referral-ring hunter orphan sweep, ' || now()::text,
      deleted_at = now(), deleted_by = v_actor, deletion_reason = v_reason
    WHERE p.id = ANY(v_bot_ids);

    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    SELECT v_actor, 'soft_delete_account', 'soft_delete_account', 'profiles', bot_id::text,
      jsonb_build_object('reason', v_reason, 'performed_by', v_actor, 'automated', true)
    FROM unnest(v_bot_ids) AS bot_id;
  END IF;

  RETURN jsonb_build_object(
    'scanned_at', now(),
    'rings_detected', v_detections,
    'referrers_newly_frozen', v_frozen,
    'bot_accounts_purged', v_purged,
    'orphaned_bots_purged', v_orphan_purged
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- One-time backfill: block every identifier already sitting in
-- deleted_accounts (captured pre-scrub, still holding the original values)
-- for every account purged before this fix existed, so historical fraud
-- emails/phones/national IDs are covered too, not just future purges.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE
  r RECORD;
  v_reason text;
  v_users int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (user_id) user_id, full_name, email, phone, national_id, reason, deleted_by
    FROM public.deleted_accounts
    ORDER BY user_id, deleted_at DESC NULLS LAST, created_at DESC
  LOOP
    v_reason := coalesce(nullif(btrim(r.reason), ''), 'Backfilled from deleted_accounts: previously purged bot/fraud account.');
    v_users := v_users + 1;

    IF nullif(btrim(coalesce(r.email, '')), '') IS NOT NULL THEN
      INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
      VALUES ('email', r.email, public.fraud_normalize_identifier('email', r.email), r.user_id, v_reason, r.deleted_by, jsonb_build_object('source', 'deleted_accounts_backfill'))
      ON CONFLICT (identifier_type, normalized_value) DO NOTHING;
    END IF;

    IF nullif(btrim(coalesce(r.phone, '')), '') IS NOT NULL THEN
      INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
      VALUES ('phone', r.phone, public.fraud_normalize_identifier('phone', r.phone), r.user_id, v_reason, r.deleted_by, jsonb_build_object('source', 'deleted_accounts_backfill'))
      ON CONFLICT (identifier_type, normalized_value) DO NOTHING;
    END IF;

    IF nullif(btrim(coalesce(r.national_id, '')), '') IS NOT NULL THEN
      INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
      VALUES ('national_id', r.national_id, public.fraud_normalize_identifier('national_id', r.national_id), r.user_id, v_reason, r.deleted_by, jsonb_build_object('source', 'deleted_accounts_backfill'))
      ON CONFLICT (identifier_type, normalized_value) DO NOTHING;
    END IF;

    IF length(public.fraud_normalize_identifier('full_name', coalesce(r.full_name, ''))) >= 5 THEN
      INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
      VALUES ('full_name', r.full_name, public.fraud_normalize_identifier('full_name', r.full_name), r.user_id, v_reason, r.deleted_by, jsonb_build_object('source', 'deleted_accounts_backfill'))
      ON CONFLICT (identifier_type, normalized_value) DO NOTHING;
    END IF;
  END LOOP;

  RAISE NOTICE 'fraud_identity_blocks backfill: processed % previously-deleted accounts', v_users;
END
$backfill$;
