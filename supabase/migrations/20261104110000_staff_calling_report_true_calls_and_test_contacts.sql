-- =============================================================================
-- Migration: 20261104110000_staff_calling_report_true_calls_and_test_contacts.sql
-- Purpose:   Fix the Calling & Pipeline report (`public.staff_calling_detailed_report`):
--              1. Include every timestamped dial in the period (`cc_call_attempts`
--                 where `outcome IS NULL` and `landlord_call_dials` where
--                 `call_id IS NULL`) with `outcome = 'awaiting_result'` so the
--                 report headline shows "Calls made: N (M recorded, K awaiting a result)".
--              2. Shorten the cross-source same-person dedupe window from 15 minutes
--                 (900s) to 3 minutes (180s), and only apply it across different
--                 logging systems (`h.r_source <> m.r_source`) for what is clearly
--                 the same physical call, never to two recorded calls placed in
--                 the same system.
--              3. Replace the name-based `\mtest\M` regex exclusion with an explicit
--                 `is_test_contact boolean NOT NULL DEFAULT false` column on
--                 `public.profiles`, `public.landlords`, and `public.landlord_leads`.
--              4. Report exact counts of cross-source merged duplicate rows and
--                 excluded test-contact rows so the UI can explain any exclusions
--                 in plain English near the headline total.
-- =============================================================================

-- 1. Add `is_test_contact` column to profiles, landlords, and landlord_leads
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_test_contact boolean NOT NULL DEFAULT false;

ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS is_test_contact boolean NOT NULL DEFAULT false;

ALTER TABLE public.landlord_leads
  ADD COLUMN IF NOT EXISTS is_test_contact boolean NOT NULL DEFAULT false;

-- Backfill known synthetic test records so they are marked via `is_test_contact`
UPDATE public.profiles
SET is_test_contact = true
WHERE is_test_contact IS FALSE
  AND (
    COALESCE(is_test, false) IS TRUE
    OR id IN (
      '1eb12d3a-b7c2-4568-ab97-36689aaa22c7'::uuid, -- Amina Test Tenant
      '6f2ce166-42dd-44d3-8730-e811c45915f6'::uuid, -- Kato Test Tenant
      '4033539e-486d-42d6-8706-b7d0968c9722'::uuid, -- TENANT TEST
      'dcb9a33c-33e2-4d08-9618-4e9065ee7484'::uuid, -- TEST TENANT
      '409948c0-a9b8-47a5-af41-1dac6616d6bb'::uuid, -- test user
      '0b109aad-212a-4fd0-ab03-3d7aee9cf397'::uuid  -- QA Test User
    )
  );

UPDATE public.landlords
SET is_test_contact = true
WHERE is_test_contact IS FALSE
  AND id IN (
    'aaaa2222-bbbb-3333-cccc-444455556666'::uuid, -- Okello Test Landlord
    '3370b396-f894-4b88-b4b4-cc80fe46ef67'::uuid, -- SSEWANYANA DENIS TEST
    'e15eb4d6-82c0-4094-b14b-d8602e9f0a03'::uuid, -- Test Landloard
    'c56dbe8a-b39a-4055-b67b-8cff4b0a780e'::uuid  -- Test Landloard
  );

-- 2. Update `public.staff_calling_detailed_report(p_from, p_to)`
CREATE OR REPLACE FUNCTION public.staff_calling_detailed_report(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (
  staff_id uuid,
  short_name text,
  staff_name text,
  ts timestamptz,
  day date,
  hhmm text,
  source text,
  role text,
  name text,
  phone text,
  phone9 text,
  answered boolean,
  outcome text,
  feedback text,
  extra jsonb,
  rr_id uuid,
  person_id uuid,
  prio integer,
  excluded_reveals integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_can_view_all boolean := false;
  v_is_calling_staff boolean := false;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'Invalid report window: p_from (%) must be before p_to (%)', p_from, p_to
      USING ERRCODE = '22023';
  END IF;

  -- Service-role / SQL editor (v_uid IS NULL) or head of calling (Jane) or HR (Mark Bwayo) or oversight roles
  IF v_uid IS NULL
     OR v_uid = '5295252d-f477-42a9-92f5-af56e503e33d'::uuid -- Jane (Head)
     OR v_uid = 'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid -- Mark Bwayo (HR)
     OR public.has_role(v_uid, 'hr'::app_role)
     OR public.has_role(v_uid, 'coo'::app_role)
     OR public.has_role(v_uid, 'cfo'::app_role)
     OR public.has_role(v_uid, 'ceo'::app_role)
     OR public.has_role(v_uid, 'manager'::app_role)
     OR public.has_role(v_uid, 'super_admin'::app_role)
     OR public.has_role(v_uid, 'operations'::app_role)
  THEN
    v_can_view_all := true;
  END IF;

  IF v_uid IN (
    '5295252d-f477-42a9-92f5-af56e503e33d'::uuid, -- Jane
    'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid, -- Winnie
    'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid  -- Hanisha
  ) THEN
    v_is_calling_staff := true;
  END IF;

  IF NOT v_can_view_all AND NOT v_is_calling_staff THEN
    RAISE EXCEPTION 'Access denied to staff calling reports'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH staff(id, s_short, s_full) AS (
    SELECT *
    FROM (
      VALUES
        ('5295252d-f477-42a9-92f5-af56e503e33d'::uuid, 'Jane'::text, 'Janehephzibar Gimono'::text),
        ('a9258d45-3e27-4827-af71-64344e76fb4f'::uuid, 'Winnie'::text, 'Winfred Asiimwe'::text),
        ('fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid, 'Hanisha'::text, 'Hanishah Amber Kawuki'::text)
    ) AS t(id, s_short, s_full)
    WHERE v_can_view_all OR t.id = v_uid
  ),
  raw AS (
    -- 1. Calling Center attempts (Tenant Ops & Landlord Ops) — both recorded outcomes and timestamped dials awaiting a result
    SELECT
      a.caller_id AS r_staff_id,
      coalesce(a.recorded_at, a.revealed_at, a.created_at) AS r_ts,
      CASE
        WHEN r.subject_type::text = 'landlord' THEN 'Landlord Ops - Calling Center'
        ELSE 'Tenant Ops - Calling Center'
      END AS r_source,
      CASE WHEN a.outcome IS NOT NULL THEN 1 ELSE 6 END AS r_prio,
      CASE
        WHEN r.subject_type::text IN ('tenant', 'landlord', 'agent') THEN r.subject_type::text
        ELSE 'other'
      END AS r_role,
      coalesce(
        nullif(btrim(pp.full_name), ''),
        nullif(btrim(ll.name), ''),
        nullif(btrim(lld.full_name), ''),
        nullif(btrim(mvr.full_name), ''),
        nullif(btrim(lr.full_name), ''),
        'Unnamed'
      ) AS r_name,
      coalesce(
        nullif(btrim(pp.phone), ''),
        nullif(btrim(pp.mobile_money_number), ''),
        nullif(btrim(ll.phone), ''),
        nullif(btrim(ll.mobile_money_number), ''),
        nullif(btrim(lld.phone), ''),
        nullif(btrim(mvr.phones[1]), ''),
        nullif(btrim(lr.phone), ''),
        CASE
          WHEN pp.email ~ '^[0-9+]+@noapp\.welile\.user$'
          THEN regexp_replace(pp.email, '@noapp\.welile\.user$', '')
          ELSE NULL
        END,
        (SELECT nullif(btrim(u.raw_user_meta_data->>'phone'), '') FROM auth.users u WHERE u.id = r.subject_id)
      ) AS r_phone,
      r.subject_id AS r_person_id,
      NULL::uuid AS r_rr_id,
      CASE WHEN a.outcome IS NOT NULL THEN (a.outcome::text = 'engaged') ELSE false END AS r_answered,
      coalesce(a.outcome::text, 'awaiting_result') AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        CASE
          WHEN fc.label IS NOT NULL THEN fc.label || coalesce(' (' || fb.severity::text || ')', '')
          ELSE NULL
        END,
        nullif(btrim(coalesce(fb.note, a.legacy_note)), '')
      )), '') AS r_feedback,
      jsonb_build_object(
        'channel', a.channel::text,
        'subject_type', r.subject_type::text,
        'category', fc.label,
        'severity', fb.severity::text,
        'note', nullif(btrim(coalesce(fb.note, a.legacy_note)), ''),
        'awaiting_result', (a.outcome IS NULL)
      ) AS r_extra,
      coalesce(pp.is_test_contact, ll.is_test_contact, lld.is_test_contact, false) AS r_is_test_contact
    FROM public.cc_call_attempts a
    JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
    LEFT JOIN public.profiles pp ON pp.id = r.subject_id
    LEFT JOIN public.landlords ll ON ll.id = r.subject_id
    LEFT JOIN public.landlord_leads lld ON lld.id = r.subject_id
    LEFT JOIN public.mv_landlord_hub_registry mvr
      ON r.subject_type = 'landlord'::cc_subject_type
      AND pp.id IS NULL
      AND ll.id IS NULL
      AND lld.id IS NULL
      AND mvr.landlord_key = r.subject_id
    LEFT JOIN LATERAL (
      SELECT v.full_name, v.phones[1] AS phone
      FROM public.v_landlord_registry_all v
      WHERE r.subject_type = 'landlord'::cc_subject_type
        AND pp.id IS NULL
        AND ll.id IS NULL
        AND lld.id IS NULL
        AND mvr.landlord_key IS NULL
        AND v.landlord_key = r.subject_id
      LIMIT 1
    ) lr ON true
    LEFT JOIN LATERAL (
      SELECT f.category_id, f.severity, f.note
      FROM public.cc_feedback f
      WHERE f.attempt_id = a.id
      ORDER BY f.created_at DESC
      LIMIT 1
    ) fb ON true
    LEFT JOIN public.cc_feedback_categories fc ON fc.id = fb.category_id
    WHERE a.void_reason IS NULL
      AND a.caller_id IN (SELECT id FROM staff)
      AND coalesce(a.recorded_at, a.revealed_at, a.created_at) >= p_from
      AND coalesce(a.recorded_at, a.revealed_at, a.created_at) < p_to

    UNION ALL

    -- 2. Calls received at the Calling Center (Inbound)
    SELECT
      c.recorded_by AS r_staff_id,
      c.called_at AS r_ts,
      'Calling Center - Inbound call received' AS r_source,
      1 AS r_prio,
      CASE
        WHEN c.linked_kind IN ('tenant', 'landlord', 'agent') THEN c.linked_kind
        ELSE 'other'
      END AS r_role,
      coalesce(nullif(btrim(c.caller_name), ''), 'Unnamed') AS r_name,
      nullif(btrim(c.caller_phone), '') AS r_phone,
      c.linked_user_id AS r_person_id,
      NULL::uuid AS r_rr_id,
      true AS r_answered,
      'received'::text AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        CASE
          WHEN nullif(btrim(c.concern), '') IS NOT NULL THEN 'Concern: ' || btrim(c.concern)
          ELSE NULL
        END,
        nullif(btrim(c.notes), '')
      )), '') AS r_feedback,
      jsonb_build_object(
        'concern', nullif(btrim(c.concern), ''),
        'notes', nullif(btrim(c.notes), ''),
        'linked_kind', c.linked_kind
      ) AS r_extra,
      coalesce(pp.is_test_contact, ll.is_test_contact, false) AS r_is_test_contact
    FROM public.cc_received_calls c
    LEFT JOIN public.profiles pp ON pp.id = c.linked_user_id
    LEFT JOIN public.landlords ll ON ll.id = c.linked_user_id
    WHERE c.recorded_by IN (SELECT id FROM staff)
      AND c.called_at >= p_from
      AND c.called_at < p_to

    UNION ALL

    -- 3. Rent Plan Pipeline — Awareness calls (Landlord Ops / Tenant Ops pipeline)
    SELECT
      w.caller_id AS r_staff_id,
      coalesce(w.recorded_at, w.dial_started_at) AS r_ts,
      'Rent Pipeline - Awareness call' AS r_source,
      2 AS r_prio,
      CASE
        WHEN w.subject_type IN ('tenant', 'landlord', 'agent') THEN w.subject_type
        ELSE 'other'
      END AS r_role,
      coalesce(
        CASE w.subject_type
          WHEN 'tenant' THEN nullif(btrim(tp.full_name), '')
          WHEN 'landlord' THEN nullif(btrim(ll.name), '')
          WHEN 'agent' THEN nullif(btrim(ap.full_name), '')
        END,
        'Unnamed'
      ) AS r_name,
      coalesce(
        nullif(btrim(w.subject_phone), ''),
        CASE w.subject_type
          WHEN 'tenant' THEN coalesce(nullif(btrim(tp.phone), ''), nullif(btrim(tp.mobile_money_number), ''))
          WHEN 'landlord' THEN coalesce(nullif(btrim(ll.phone), ''), nullif(btrim(ll.mobile_money_number), ''))
          WHEN 'agent' THEN coalesce(nullif(btrim(ap.phone), ''), nullif(btrim(ap.mobile_money_number), ''))
        END
      ) AS r_phone,
      w.subject_user_id AS r_person_id,
      w.rent_request_id AS r_rr_id,
      (w.call_result = 'answered') AS r_answered,
      w.call_result::text AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        nullif(btrim(w.note), ''),
        CASE
          WHEN w.subject_type = 'landlord'
           AND q.landlord_ops_reviewed_by = w.caller_id
           AND q.landlord_ops_reviewed_at IS NOT NULL
           AND abs(extract(epoch FROM (coalesce(w.recorded_at, w.dial_started_at) - q.landlord_ops_reviewed_at))) <= 180
          THEN nullif(btrim(concat_ws(' - ',
            CASE
              WHEN nullif(btrim(q.landlord_call_notes), '') IS NOT NULL
              THEN 'Verification: ' || btrim(q.landlord_call_notes)
              ELSE NULL
            END,
            CASE
              WHEN nullif(btrim(q.landlord_ops_comment), '') IS NOT NULL
              THEN 'Decision note: ' || btrim(q.landlord_ops_comment)
              ELSE NULL
            END
          )), '')
          ELSE NULL
        END
      )), '') AS r_feedback,
      jsonb_build_object(
        'aware_30m', w.aware_30m,
        'explained', w.explained,
        'merchant_codes', w.aware_merchant_codes,
        'landlord_consent', w.landlord_consent,
        'payout_otp', w.aware_payout_otp,
        'stage', w.pipeline_stage,
        'note', nullif(btrim(w.note), ''),
        'landlord_ops_comment', CASE
          WHEN w.subject_type = 'landlord' AND q.landlord_ops_reviewed_by = w.caller_id
          THEN nullif(btrim(q.landlord_ops_comment), '')
          ELSE NULL
        END
      ) AS r_extra,
      coalesce(
        CASE w.subject_type
          WHEN 'tenant' THEN tp.is_test_contact
          WHEN 'landlord' THEN ll.is_test_contact
          WHEN 'agent' THEN ap.is_test_contact
          ELSE false
        END,
        false
      ) AS r_is_test_contact
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests q ON q.id = w.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = q.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = q.agent_id
    LEFT JOIN public.landlords ll ON ll.id = q.landlord_id
    WHERE w.caller_id IN (SELECT id FROM staff)
      AND coalesce(w.recorded_at, w.dial_started_at) >= p_from
      AND coalesce(w.recorded_at, w.dial_started_at) < p_to

    UNION ALL

    -- 3b. Landlord Calling Hub calls (v_landlord_calls_effective, non-voided)
    SELECT
      lc.caller_id AS r_staff_id,
      coalesce(lc.recorded_at, lc.dial_started_at) AS r_ts,
      'Landlord Ops - Calling Hub' AS r_source,
      2 AS r_prio,
      'landlord'::text AS r_role,
      coalesce(
        nullif(btrim(lc.landlord_name), ''),
        nullif(btrim(ll.name), ''),
        nullif(btrim(pp.full_name), ''),
        nullif(btrim(lld.full_name), ''),
        'Unnamed'
      ) AS r_name,
      nullif(btrim(lc.phone_dialed), '') AS r_phone,
      coalesce(
        lc.landlord_id,
        CASE
          WHEN lc.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN lc.landlord_key::uuid
          ELSE NULL
        END
      ) AS r_person_id,
      lc.tenants_discussed[1] AS r_rr_id,
      (lc.result = 'answered') AS r_answered,
      lc.result AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        CASE
          WHEN coalesce(fc.label, lc.feedback_category) IS NOT NULL
            THEN coalesce(
              fc.label,
              CASE lc.feedback_category
                WHEN 'reached_ok' THEN 'Reached — all okay'
                WHEN 'confirmed_payout_number' THEN 'Confirmed payout number'
                WHEN 'wants_more_tenants' THEN 'Wants more tenants'
                WHEN 'complaint' THEN 'Landlord complaint'
                WHEN 'payout_issue' THEN 'Payout issue'
                WHEN 'not_landlord' THEN 'Not a landlord'
                WHEN 'wrong_number' THEN 'Wrong phone number'
                ELSE lc.feedback_category
              END
            ) || coalesce(' (' || lc.severity || ')', '')
          ELSE NULL
        END,
        nullif(btrim(lc.note), '')
      )), '') AS r_feedback,
      jsonb_build_object(
        'aware_30m', lc.aware_30m,
        'landlord_consent', lc.landlord_consent,
        'aware_payout_otp', lc.aware_payout_otp,
        'payout_otp', lc.aware_payout_otp,
        'explained', lc.explained,
        'category', coalesce(
          fc.label,
          CASE lc.feedback_category
            WHEN 'reached_ok' THEN 'Reached — all okay'
            WHEN 'confirmed_payout_number' THEN 'Confirmed payout number'
            WHEN 'wants_more_tenants' THEN 'Wants more tenants'
            WHEN 'complaint' THEN 'Landlord complaint'
            WHEN 'payout_issue' THEN 'Payout issue'
            WHEN 'not_landlord' THEN 'Not a landlord'
            WHEN 'wrong_number' THEN 'Wrong phone number'
            ELSE lc.feedback_category
          END
        ),
        'feedback_category', lc.feedback_category,
        'severity', lc.severity,
        'call_back_at', lc.call_back_at,
        'note', nullif(btrim(lc.note), '')
      ) AS r_extra,
      coalesce(ll.is_test_contact, pp.is_test_contact, lld.is_test_contact, false) AS r_is_test_contact
    FROM public.v_landlord_calls_effective lc
    LEFT JOIN public.landlords ll ON ll.id = lc.landlord_id
    LEFT JOIN public.profiles pp ON pp.id = CASE
      WHEN lc.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN lc.landlord_key::uuid
      ELSE NULL
    END
    LEFT JOIN public.landlord_leads lld ON lld.id = CASE
      WHEN lc.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN lc.landlord_key::uuid
      ELSE NULL
    END
    LEFT JOIN public.cc_feedback_categories fc ON fc.code = lc.feedback_category
    WHERE lc.caller_id IN (SELECT id FROM staff)
      AND lc.voided_at IS NULL
      AND coalesce(lc.recorded_at, lc.dial_started_at) >= p_from
      AND coalesce(lc.recorded_at, lc.dial_started_at) < p_to

    UNION ALL

    -- 3c. Landlord Calling Hub timestamped dials awaiting a saved outcome (landlord_call_dials where call_id IS NULL)
    SELECT
      d.caller_id AS r_staff_id,
      d.started_at AS r_ts,
      'Landlord Ops - Calling Hub' AS r_source,
      6 AS r_prio,
      'landlord'::text AS r_role,
      coalesce(
        nullif(btrim(ll.name), ''),
        nullif(btrim(pp.full_name), ''),
        nullif(btrim(lld.full_name), ''),
        nullif(btrim(mvr.full_name), ''),
        'Unnamed'
      ) AS r_name,
      coalesce(
        nullif(btrim(d.phone), ''),
        nullif(btrim(ll.phone), ''),
        nullif(btrim(pp.phone), ''),
        nullif(btrim(lld.phone), ''),
        nullif(btrim(mvr.phones[1]), '')
      ) AS r_phone,
      coalesce(
        CASE
          WHEN d.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN d.landlord_key::uuid
          ELSE NULL
        END,
        ll.id,
        mvr.landlord_id
      ) AS r_person_id,
      NULL::uuid AS r_rr_id,
      false AS r_answered,
      'awaiting_result'::text AS r_outcome,
      NULL::text AS r_feedback,
      jsonb_build_object(
        'awaiting_result', true,
        'dial_id', d.id
      ) AS r_extra,
      coalesce(ll.is_test_contact, pp.is_test_contact, lld.is_test_contact, false) AS r_is_test_contact
    FROM public.landlord_call_dials d
    LEFT JOIN public.landlords ll ON ll.id = CASE
      WHEN d.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN d.landlord_key::uuid
      ELSE NULL
    END
    LEFT JOIN public.profiles pp ON pp.id = CASE
      WHEN d.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN d.landlord_key::uuid
      ELSE NULL
    END
    LEFT JOIN public.landlord_leads lld ON lld.id = CASE
      WHEN d.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN d.landlord_key::uuid
      ELSE NULL
    END
    LEFT JOIN public.mv_landlord_hub_registry mvr ON mvr.landlord_key_text = d.landlord_key
    WHERE d.caller_id IN (SELECT id FROM staff)
      AND d.call_id IS NULL
      AND d.started_at >= p_from
      AND d.started_at < p_to

    UNION ALL

    -- 4. Rent Plan Pipeline — Landlord Ops verification & review call feedback before approving or declining
    SELECT
      q.landlord_ops_reviewed_by AS r_staff_id,
      q.landlord_ops_reviewed_at AS r_ts,
      CASE
        WHEN q.landlord_called IS TRUE AND q.landlord_verification_method = 'phone_call'
        THEN 'Rent Pipeline - Landlord Ops verification call'
        ELSE 'Rent Pipeline - Landlord Ops review feedback'
      END AS r_source,
      3 AS r_prio,
      'landlord'::text AS r_role,
      coalesce(nullif(btrim(ll.name), ''), 'Unnamed') AS r_name,
      coalesce(nullif(btrim(ll.phone), ''), nullif(btrim(ll.mobile_money_number), '')) AS r_phone,
      ll.id AS r_person_id,
      q.id AS r_rr_id,
      CASE
        WHEN q.landlord_called IS TRUE AND coalesce(q.landlord_acknowledged, false) THEN true
        WHEN q.landlord_ops_comment ~* '(number off|phone is off|phone off|number is off|unreachable|busy|doesn''t exist|does not exist)' THEN false
        WHEN q.landlord_ops_comment ~* '(refused|arrears|not the landlord|wrong landlord)' THEN true
        ELSE false
      END AS r_answered,
      CASE
        WHEN q.landlord_called IS TRUE AND coalesce(q.landlord_acknowledged, false) THEN 'verified'
        WHEN q.landlord_ops_comment ~* '(number off|phone is off|phone off|number is off|unreachable)' THEN 'phone_off'
        WHEN q.landlord_ops_comment ~* '(busy)' THEN 'no_answer'
        WHEN q.landlord_ops_comment ~* '(doesn''t exist|does not exist|not the landlord|wrong landlord)' THEN 'wrong_number'
        WHEN q.landlord_ops_comment ~* '(refused|arrears)' THEN 'engaged'
        ELSE 'review recorded'
      END AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        nullif(btrim(q.landlord_call_notes), ''),
        nullif(btrim(q.landlord_ops_comment), ''),
        CASE
          WHEN q.status = 'rejected'
           AND nullif(btrim(q.rejected_reason), '') IS NOT NULL
           AND btrim(q.rejected_reason) IS DISTINCT FROM btrim(coalesce(q.landlord_ops_comment, ''))
          THEN 'Declined: ' || btrim(q.rejected_reason)
          ELSE NULL
        END
      )), '') AS r_feedback,
      jsonb_build_object(
        'stage', 'landlord_ops',
        'verification_method', q.landlord_verification_method,
        'landlord_called', q.landlord_called,
        'landlord_acknowledged', q.landlord_acknowledged,
        'request_status', q.status,
        'landlord_call_notes', nullif(btrim(q.landlord_call_notes), ''),
        'landlord_ops_comment', nullif(btrim(q.landlord_ops_comment), '')
      ) AS r_extra,
      coalesce(ll.is_test_contact, false) AS r_is_test_contact
    FROM public.rent_requests q
    LEFT JOIN public.landlords ll ON ll.id = q.landlord_id
    WHERE q.landlord_ops_reviewed_by IN (SELECT id FROM staff)
      AND q.landlord_ops_reviewed_at IS NOT NULL
      AND q.landlord_ops_reviewed_at >= p_from
      AND q.landlord_ops_reviewed_at < p_to
      AND (
        (q.landlord_called IS TRUE AND q.landlord_verification_method = 'phone_call')
        OR nullif(btrim(q.landlord_ops_comment), '') IS NOT NULL
        OR nullif(btrim(q.landlord_call_notes), '') IS NOT NULL
      )
      AND coalesce(q.landlord_verification_method, '') <> 'physical_visit'

    UNION ALL

    -- 5. Rent Plan Pipeline — Tenant Ops review feedback before approving or declining
    SELECT
      q.tenant_ops_reviewed_by AS r_staff_id,
      q.tenant_ops_reviewed_at AS r_ts,
      'Rent Pipeline - Tenant Ops review feedback' AS r_source,
      3 AS r_prio,
      'tenant'::text AS r_role,
      coalesce(nullif(btrim(tp.full_name), ''), 'Unnamed') AS r_name,
      coalesce(
        nullif(btrim(tp.phone), ''),
        nullif(btrim(tp.mobile_money_number), ''),
        CASE
          WHEN tp.email ~ '^[0-9+]+@noapp\.welile\.user$'
          THEN regexp_replace(tp.email, '@noapp\.welile\.user$', '')
          ELSE NULL
        END,
        (SELECT nullif(btrim(u.raw_user_meta_data->>'phone'), '') FROM auth.users u WHERE u.id = q.tenant_id)
      ) AS r_phone,
      q.tenant_id AS r_person_id,
      q.id AS r_rr_id,
      NULL::boolean AS r_answered,
      'review recorded'::text AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        nullif(btrim(q.tenant_ops_comment), ''),
        CASE
          WHEN q.status = 'rejected'
           AND nullif(btrim(q.rejected_reason), '') IS NOT NULL
           AND btrim(q.rejected_reason) IS DISTINCT FROM btrim(coalesce(q.tenant_ops_comment, ''))
          THEN 'Declined: ' || btrim(q.rejected_reason)
          ELSE NULL
        END
      )), '') AS r_feedback,
      jsonb_build_object(
        'stage', 'tenant_ops',
        'request_status', q.status,
        'tenant_ops_comment', nullif(btrim(q.tenant_ops_comment), '')
      ) AS r_extra,
      coalesce(tp.is_test_contact, false) AS r_is_test_contact
    FROM public.rent_requests q
    LEFT JOIN public.profiles tp ON tp.id = q.tenant_id
    WHERE q.tenant_ops_reviewed_by IN (SELECT id FROM staff)
      AND q.tenant_ops_reviewed_at IS NOT NULL
      AND q.tenant_ops_reviewed_at >= p_from
      AND q.tenant_ops_reviewed_at < p_to
      AND nullif(btrim(q.tenant_ops_comment), '') IS NOT NULL

    UNION ALL

    -- 6. In-app voice calls (CRM call sessions)
    SELECT
      s.staff_id AS r_staff_id,
      s.created_at AS r_ts,
      'In-app voice call' AS r_source,
      4 AS r_prio,
      CASE s.target_role
        WHEN 'tenant' THEN 'tenant'
        WHEN 'agent' THEN 'agent'
        WHEN 'landlord' THEN 'landlord'
        ELSE 'other'
      END AS r_role,
      coalesce(nullif(btrim(s.target_name), ''), 'Unnamed') AS r_name,
      nullif(btrim(s.target_phone), '') AS r_phone,
      s.target_user_id AS r_person_id,
      NULL::uuid AS r_rr_id,
      (s.answered_at IS NOT NULL) AS r_answered,
      s.status::text AS r_outcome,
      nullif(btrim(s.summary), '') AS r_feedback,
      jsonb_build_object(
        'seconds', s.duration_seconds,
        'target_role', s.target_role
      ) AS r_extra,
      coalesce(pp.is_test_contact, ll.is_test_contact, false) AS r_is_test_contact
    FROM public.crm_call_sessions s
    LEFT JOIN public.profiles pp ON pp.id = s.target_user_id
    LEFT JOIN public.landlords ll ON ll.id = s.target_user_id
    WHERE s.staff_id IN (SELECT id FROM staff)
      AND s.created_at >= p_from
      AND s.created_at < p_to

    UNION ALL

    -- 7. Direct Landlord call logs (landlord_call_reports)
    SELECT
      lcr.called_by AS r_staff_id,
      lcr.called_at AS r_ts,
      'Landlord Ops - Direct call log' AS r_source,
      5 AS r_prio,
      'landlord'::text AS r_role,
      coalesce(nullif(btrim(ll.name), ''), 'Unnamed') AS r_name,
      coalesce(nullif(btrim(ll.phone), ''), nullif(btrim(ll.mobile_money_number), '')) AS r_phone,
      lcr.landlord_id AS r_person_id,
      NULL::uuid AS r_rr_id,
      (lcr.status = 'picked_up') AS r_answered,
      CASE
        WHEN lcr.status = 'picked_up' THEN 'engaged'
        WHEN lcr.follow_up_at IS NOT NULL THEN 'callback_booked'
        ELSE coalesce(lcr.status, 'no_answer')
      END AS r_outcome,
      nullif(btrim(lcr.comment), '') AS r_feedback,
      jsonb_build_object(
        'status', lcr.status,
        'follow_up_at', lcr.follow_up_at
      ) AS r_extra,
      coalesce(ll.is_test_contact, false) AS r_is_test_contact
    FROM public.landlord_call_reports lcr
    LEFT JOIN public.landlords ll ON ll.id = lcr.landlord_id
    WHERE lcr.called_by IN (SELECT id FROM staff)
      AND lcr.called_at >= p_from
      AND lcr.called_at < p_to

    UNION ALL

    -- 8. Direct Tenant call logs (tenant_call_reports)
    SELECT
      tcr.called_by AS r_staff_id,
      tcr.called_at AS r_ts,
      'Tenant Ops - Direct call log' AS r_source,
      5 AS r_prio,
      'tenant'::text AS r_role,
      coalesce(nullif(btrim(tp.full_name), ''), 'Unnamed') AS r_name,
      coalesce(
        nullif(btrim(tp.phone), ''),
        nullif(btrim(tp.mobile_money_number), ''),
        CASE
          WHEN tp.email ~ '^[0-9+]+@noapp\.welile\.user$'
          THEN regexp_replace(tp.email, '@noapp\.welile\.user$', '')
          ELSE NULL
        END
      ) AS r_phone,
      tcr.tenant_id AS r_person_id,
      tcr.rent_request_id AS r_rr_id,
      (tcr.outcome IN ('engaged', 'picked_up', 'answered')) AS r_answered,
      coalesce(nullif(btrim(tcr.outcome), ''), coalesce(tcr.status, 'no_answer')) AS r_outcome,
      nullif(btrim(tcr.comment), '') AS r_feedback,
      jsonb_build_object(
        'status', tcr.status,
        'follow_up_at', tcr.follow_up_at
      ) AS r_extra,
      coalesce(tp.is_test_contact, false) AS r_is_test_contact
    FROM public.tenant_call_reports tcr
    LEFT JOIN public.profiles tp ON tp.id = tcr.tenant_id
    WHERE tcr.called_by IN (SELECT id FROM staff)
      AND tcr.called_at >= p_from
      AND tcr.called_at < p_to
  ),
  raw_window AS MATERIALIZED (
    SELECT
      row_number() OVER (ORDER BY x.r_staff_id, x.r_ts, x.r_prio, x.r_source) AS r_seq,
      right(regexp_replace(coalesce(x.r_phone, ''), '\D', '', 'g'), 9) AS r_phone9,
      x.*
    FROM raw x
    WHERE x.r_ts IS NOT NULL
      AND x.r_ts >= p_from
      AND x.r_ts < p_to
  ),
  in_win AS MATERIALIZED (
    SELECT w.*
    FROM raw_window w
    WHERE NOT coalesce(w.r_is_test_contact, false)
  ),
  -- Deduplicate within 3 minutes (180 seconds) ONLY across different logging systems
  -- (or when an unrecorded awaiting_result dial is superseded by a recorded call within 3 minutes).
  -- Never drop two recorded calls placed in the same logging system.
  kept AS MATERIALIZED (
    SELECT m.*
    FROM in_win m
    WHERE NOT EXISTS (
      SELECT 1
      FROM in_win h
      WHERE h.r_seq <> m.r_seq
        AND h.r_staff_id = m.r_staff_id
        AND abs(extract(epoch FROM (h.r_ts - m.r_ts))) <= 180
        AND (
          -- Case A: Cross-source duplicate of the same physical call (must be different logging systems)
          (
            h.r_source <> m.r_source
            AND (
              h.r_prio < m.r_prio
              OR (
                h.r_prio = 2
                AND m.r_prio = 2
                AND h.r_source = 'Landlord Ops - Calling Hub'
                AND m.r_source = 'Rent Pipeline - Awareness call'
              )
            )
          )
          OR
          -- Case B: An unrecorded dial (`awaiting_result`) superseded within 3 minutes by a recorded call or an earlier dial for the same person
          (
            m.r_outcome = 'awaiting_result'
            AND (
              h.r_outcome <> 'awaiting_result'
              OR h.r_seq < m.r_seq
            )
          )
        )
        AND (
          (h.r_person_id IS NOT NULL AND h.r_person_id = m.r_person_id)
          OR (length(h.r_phone9) = 9 AND h.r_phone9 = m.r_phone9)
          OR (h.r_rr_id IS NOT NULL AND h.r_rr_id = m.r_rr_id AND h.r_role = m.r_role)
        )
    )
  ),
  exclusions_by_staff AS (
    SELECT
      s.id AS s_id,
      coalesce((
        SELECT count(*)::integer
        FROM in_win m
        WHERE m.r_staff_id = s.id
          AND NOT EXISTS (SELECT 1 FROM kept k WHERE k.r_seq = m.r_seq)
      ), 0) AS dropped_dupes_cnt,
      coalesce((
        SELECT count(*)::integer
        FROM raw_window w
        WHERE w.r_staff_id = s.id
          AND coalesce(w.r_is_test_contact, false)
      ), 0) AS excluded_test_cnt
    FROM staff s
  )
  SELECT
    k.r_staff_id AS staff_id,
    s.s_short AS short_name,
    s.s_full AS staff_name,
    k.r_ts AS ts,
    (k.r_ts AT TIME ZONE 'Africa/Kampala')::date AS day,
    to_char(k.r_ts AT TIME ZONE 'Africa/Kampala', 'HH24:MI') AS hhmm,
    k.r_source AS source,
    k.r_role AS role,
    k.r_name AS name,
    k.r_phone AS phone,
    k.r_phone9 AS phone9,
    k.r_answered AS answered,
    k.r_outcome AS outcome,
    k.r_feedback AS feedback,
    k.r_extra || jsonb_build_object(
      'excluded_cross_source_dupes', coalesce(ex.dropped_dupes_cnt, 0),
      'excluded_test_contacts', coalesce(ex.excluded_test_cnt, 0)
    ) AS extra,
    k.r_rr_id AS rr_id,
    k.r_person_id AS person_id,
    k.r_prio AS prio,
    (coalesce(ex.dropped_dupes_cnt, 0) + coalesce(ex.excluded_test_cnt, 0))::integer AS excluded_reveals
  FROM kept k
  JOIN staff s ON s.id = k.r_staff_id
  LEFT JOIN exclusions_by_staff ex ON ex.s_id = k.r_staff_id
  ORDER BY s.s_short, k.r_ts;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_calling_detailed_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_calling_detailed_report(timestamptz, timestamptz) TO authenticated, service_role;
