-- 2026-10-27: Special Advances, Phase 3: CFO-only server functions. NOT APPLIED. Production apply needs explicit CFO
-- approval. Additive only (new functions, one index, one constraint on the Phase 2 external-borrower table). No money
-- moves: nothing here reads or writes general_ledger, wallets or payments; payout is Phase 4.
--
-- CFO decisions 2026-10-27:
--   * the CFO is the sole authority and may record and approve the same advance (no second person); every function
--     re-checks an enabled cfo role + staff MFA (Super Admin, CEO, admin cannot);
--   * external borrowers: an individual needs a NIN, an entity a company registration number (plus name and phone);
--   * a Welile borrower is blocked when they have an open Special Advance, an overdue agent advance
--     (agent_advances.status = 'overdue' with a balance) or a defaulted business advance (business_advances.status =
--     'defaulted' with a balance), or when their account is deleted or has no enabled role;
--   * one open Special Advance per borrower (Welile account, or the same external phone / NIN / registration number).
-- Safety default (not a stated decision; flagged for CFO confirmation): a CFO cannot record or approve a Special
-- Advance to themselves.
--
-- Functions (all SECURITY DEFINER, authenticated EXECUTE, CFO-checked inside; anon none):
--   special_advance_quote(request)   read-only: server schedule (dated from the planned payout date or Kampala today)
--                                     + eligibility; available while issuance is off (preview).
--   special_advance_create(request)  records a pending agreement. Requires issuance_enabled. Idempotent on
--                                     request.idempotency_key (same key + same request returns the same advance; a
--                                     different request with that key is refused). The CFO must confirm the total:
--                                     request.expected_total_repayable must equal the server total.
--   special_advance_approve(id, expected_updated_at, reason)   requires issuance_enabled; re-checks eligibility.
--   special_advance_reject(id, expected_updated_at, reason)    pending only; always available.
--   special_advance_cancel(id, expected_updated_at, reason)    pending or approved (not yet paid out); always available.
--   special_advance_get(id), special_advance_list(status, limit, offset)   CFO read.
-- Concurrency: transaction-scoped advisory locks per idempotency key and per borrower identity, row locks on decisions,
-- optimistic version check (updated_at), and a unique partial index so a Welile account can never hold two open
-- Special Advances even under a race.
-- Rollback: supabase/rollbacks/20261028152000_special_advances_functions.rollback.sql
-- Tests: src/test/specialAdvanceFunctions.test.ts (PGlite).

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.special_advances') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances storage (20261028151000) is not applied; nothing was changed';
  END IF;
  IF to_regprocedure('public.special_advance_create(jsonb)') IS NOT NULL
     OR to_regclass('public.special_advances_one_open_per_user') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances functions already exist; nothing was changed';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND (table_name, column_name) IN (('profiles', 'id'), ('profiles', 'full_name'), ('profiles', 'deleted_at'),
                                          ('agent_advances', 'agent_id'), ('agent_advances', 'status'), ('agent_advances', 'outstanding_balance'),
                                          ('business_advances', 'tenant_id'), ('business_advances', 'status'), ('business_advances', 'outstanding_balance'),
                                          ('user_roles', 'user_id'), ('user_roles', 'enabled'))) <> 11 THEN
    RAISE EXCEPTION 'precondition failed: a column the eligibility checks read is missing; nothing was changed';
  END IF;
END
$pre$;

-- ── Additional constraints ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.special_advance_external_borrowers
  ADD CONSTRAINT special_advance_external_borrowers_identity CHECK (
    (borrower_type = 'individual' AND national_id IS NOT NULL)
    OR (borrower_type = 'entity' AND registration_number IS NOT NULL));

CREATE UNIQUE INDEX special_advances_one_open_per_user ON public.special_advances (borrower_user_id)
  WHERE borrower_user_id IS NOT NULL AND status IN ('pending_approval', 'approved', 'disbursed');

-- ── Internals ──────────────────────────────────────────────────────────────────────────────────────
-- Raises 42501 unless the caller is an enabled CFO with staff MFA satisfied. Returns the caller.
CREATE FUNCTION public._special_advance_require_cfo()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT public._has_enabled_role(v_actor, ARRAY['cfo']) OR NOT COALESCE(public.staff_mfa_ok(), false) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  RETURN v_actor;
END $$;

CREATE FUNCTION public._special_advance_issuance_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT issuance_enabled FROM public.special_advance_settings WHERE id), false);
$$;

CREATE FUNCTION public._special_advance_kampala_today()
RETURNS date LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT (now() AT TIME ZONE 'Africa/Kampala')::date;
$$;

CREATE FUNCTION public._special_advance_norm_phone(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  -- 0772123456 / +256772123456 / 256 772 123 456 -> 256772123456
  SELECT CASE
    WHEN v ~ '^0[0-9]{9}$' THEN '256' || substr(v, 2)
    ELSE v END
  FROM (SELECT regexp_replace(COALESCE(p, ''), '[^0-9]', '', 'g') AS v) x;
$$;

-- Eligibility codes for a borrower (empty array = eligible). p_exclude: the advance being approved.
CREATE FUNCTION public._special_advance_eligibility(
  p_kind text, p_user uuid, p_phone text, p_national_id text, p_registration_number text, p_exclude uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v text[] := '{}';
  v_phone text := NULLIF(public._special_advance_norm_phone(p_phone), '');
  v_nin text := NULLIF(upper(btrim(COALESCE(p_national_id, ''))), '');
  v_reg text := NULLIF(upper(btrim(COALESCE(p_registration_number, ''))), '');
BEGIN
  IF p_kind = 'welile_user' THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user) THEN
      RETURN ARRAY['UNKNOWN_ACCOUNT'];
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p_user AND pr.deleted_at IS NOT NULL) THEN
      v := v || 'ACCOUNT_DELETED'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user AND ur.enabled) THEN
      v := v || 'NO_ENABLED_ROLE'::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advances sa WHERE sa.borrower_user_id = p_user
                AND sa.status IN ('pending_approval', 'approved', 'disbursed') AND sa.id IS DISTINCT FROM p_exclude) THEN
      v := v || 'OPEN_SPECIAL_ADVANCE'::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.agent_advances a WHERE a.agent_id = p_user AND a.status::text = 'overdue'
                AND COALESCE(a.outstanding_balance, 0) > 0) THEN
      v := v || 'OVERDUE_AGENT_ADVANCE'::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.business_advances b WHERE b.tenant_id = p_user AND b.status::text = 'defaulted'
                AND COALESCE(b.outstanding_balance, 0) > 0) THEN
      v := v || 'DEFAULTED_BUSINESS_ADVANCE'::text;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.special_advances sa
                 JOIN public.special_advance_external_borrowers eb ON eb.id = sa.external_borrower_id
                WHERE sa.status IN ('pending_approval', 'approved', 'disbursed') AND sa.id IS DISTINCT FROM p_exclude
                  AND ((v_phone IS NOT NULL AND public._special_advance_norm_phone(eb.phone) = v_phone)
                       OR (v_nin IS NOT NULL AND upper(eb.national_id) = v_nin)
                       OR (v_reg IS NOT NULL AND upper(btrim(eb.registration_number)) = v_reg))) THEN
      v := v || 'OPEN_SPECIAL_ADVANCE'::text;
    END IF;
  END IF;
  RETURN v;
END $$;

-- Borrower part of a request -> normalised fields + field errors. Never creates anything.
CREATE FUNCTION public._special_advance_parse_borrower(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b jsonb := COALESCE(p -> 'borrower', 'null'::jsonb);
  e text[] := '{}';
  v_kind text := b ->> 'kind';
  v_user uuid;
  v_type text;
  v_name text;
  v_phone text;
  v_nin text;
  v_reg text;
BEGIN
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR v_kind IS NULL OR v_kind NOT IN ('welile_user', 'external') THEN
    RETURN jsonb_build_object('errors', to_jsonb(ARRAY['borrower']));
  END IF;
  IF v_kind = 'welile_user' THEN
    IF COALESCE(b ->> 'user_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('errors', to_jsonb(ARRAY['borrower_user_id']));
    END IF;
    v_user := (b ->> 'user_id')::uuid;
    RETURN jsonb_build_object('errors', '[]'::jsonb, 'kind', v_kind, 'user_id', v_user);
  END IF;
  v_type := b ->> 'borrower_type';
  v_name := NULLIF(btrim(COALESCE(b ->> 'full_name', '')), '');
  v_phone := NULLIF(regexp_replace(COALESCE(b ->> 'phone', ''), '[\s-]', '', 'g'), '');
  v_nin := NULLIF(upper(regexp_replace(COALESCE(b ->> 'national_id', ''), '\s', '', 'g')), '');
  v_reg := NULLIF(btrim(COALESCE(b ->> 'registration_number', '')), '');
  IF v_type IS NULL OR v_type NOT IN ('individual', 'entity') THEN e := e || 'borrower_type'::text; END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 2 AND 200 THEN e := e || 'full_name'::text; END IF;
  IF v_phone IS NULL OR v_phone !~ '^\+?[0-9]{9,15}$' THEN e := e || 'phone'::text; END IF;
  IF v_type = 'individual' AND (v_nin IS NULL OR v_nin !~ '^[A-Z0-9]{8,20}$') THEN e := e || 'national_id'::text; END IF;
  IF v_type = 'entity' AND (v_reg IS NULL OR length(v_reg) NOT BETWEEN 2 AND 60) THEN e := e || 'registration_number'::text; END IF;
  IF v_nin IS NOT NULL AND v_nin !~ '^[A-Z0-9]{8,20}$' AND NOT 'national_id' = ANY (e) THEN e := e || 'national_id'::text; END IF;
  RETURN jsonb_build_object('errors', to_jsonb(e), 'kind', v_kind, 'borrower_type', v_type, 'full_name', v_name,
    'phone', v_phone, 'national_id', v_nin, 'registration_number', v_reg,
    'organization', NULLIF(btrim(COALESCE(b ->> 'organization', '')), ''), 'notes', NULLIF(btrim(COALESCE(b ->> 'notes', '')), ''));
END $$;

-- Terms part of a request -> engine schedule (or field errors). p_start: date the schedule is dated from.
CREATE FUNCTION public._special_advance_parse_terms(p jsonb, p_start date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t jsonb := COALESCE(p -> 'terms', 'null'::jsonb);
  v_principal numeric;
  v_rate numeric;
  v_term numeric;
  v_err text[];
BEGIN
  IF jsonb_typeof(t) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('errors', to_jsonb(ARRAY['terms']));
  END IF;
  BEGIN
    v_principal := (t ->> 'principal')::numeric;
    v_rate := (t ->> 'rate_percent')::numeric;
    v_term := (t ->> 'term_days')::numeric;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('errors', to_jsonb(ARRAY['terms']));
  END;
  v_err := public._special_advance_term_errors(v_principal, v_rate, t ->> 'rate_basis', v_term, t ->> 'frequency', p_start);
  IF cardinality(v_err) > 0 THEN
    RETURN jsonb_build_object('errors', to_jsonb(v_err));
  END IF;
  RETURN jsonb_build_object('errors', '[]'::jsonb,
    'schedule', public._special_advance_schedule(v_principal, v_rate, t ->> 'rate_basis', v_term, t ->> 'frequency', p_start));
END $$;

-- One agreement with schedule, history and borrower display fields (CFO read).
CREATE FUNCTION public._special_advance_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(a) || jsonb_build_object(
    'borrower_name', COALESCE(eb.full_name, NULLIF(btrim(pr.full_name), '')),
    'external_borrower', CASE WHEN eb.id IS NULL THEN NULL ELSE to_jsonb(eb) END,
    'schedule', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', i.number, 'due_offset_days', i.due_offset_days, 'due_date', i.due_date, 'amount', i.amount,
        'access_fee', i.access_fee, 'registration_fee', i.registration_fee, 'principal', i.principal) ORDER BY i.number)
      FROM public.special_advance_instalments i WHERE i.advance_id = a.id), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'event_type', e.event_type, 'from_status', e.from_status, 'to_status', e.to_status, 'actor_id', e.actor_id,
        'actor_name', NULLIF(btrim(ap.full_name), ''), 'reason', e.reason, 'details', e.details, 'created_at', e.created_at)
        ORDER BY e.created_at, e.id)
      FROM public.special_advance_events e LEFT JOIN public.profiles ap ON ap.id = e.actor_id WHERE e.advance_id = a.id), '[]'::jsonb))
  FROM public.special_advances a
  LEFT JOIN public.special_advance_external_borrowers eb ON eb.id = a.external_borrower_id
  LEFT JOIN public.profiles pr ON pr.id = a.borrower_user_id
  WHERE a.id = p_id;
$$;

-- Lock + load an agreement for a decision, with the optimistic version check.
CREATE FUNCTION public._special_advance_lock(p_id uuid, p_expected_updated_at timestamptz)
RETURNS public.special_advances LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.special_advances%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'VERSION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = '40001';
  END IF;
  RETURN a;
END $$;

CREATE FUNCTION public._special_advance_reason(p text, p_required boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v text := NULLIF(btrim(COALESCE(p, '')), '');
BEGIN
  IF (p_required AND v IS NULL) OR (v IS NOT NULL AND length(v) NOT BETWEEN 5 AND 1000) THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023', DETAIL = 'A reason of 5 to 1000 characters is required';
  END IF;
  RETURN v;
END $$;

-- ── Public functions ───────────────────────────────────────────────────────────────────────────────
-- Read-only quote: the authoritative schedule + eligibility. Changes nothing.
CREATE FUNCTION public.special_advance_quote(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  v_start date;
  b jsonb;
  t jsonb;
  v_elig text[] := '{}';
BEGIN
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_start := COALESCE(NULLIF(p_request ->> 'planned_payout_date', '')::date, v_today);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["planned_payout_date"]';
  END;
  t := public._special_advance_parse_terms(p_request, v_start);
  IF p_request ? 'borrower' THEN
    b := public._special_advance_parse_borrower(p_request);
    IF jsonb_array_length(b -> 'errors') = 0 THEN
      v_elig := public._special_advance_eligibility(b ->> 'kind', (b ->> 'user_id')::uuid, b ->> 'phone',
                                                     b ->> 'national_id', b ->> 'registration_number', NULL);
      IF b ->> 'kind' = 'welile_user' AND (b ->> 'user_id')::uuid = v_actor THEN v_elig := v_elig || 'SELF_ADVANCE'::text; END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'issuance_enabled', public._special_advance_issuance_enabled(),
    'dated_from', to_char(v_start, 'YYYY-MM-DD'),
    'dated_from_is_planned', p_request ? 'planned_payout_date',
    'term_errors', t -> 'errors',
    'schedule', t -> 'schedule',
    'borrower_errors', COALESCE(b -> 'errors', '[]'::jsonb),
    'eligibility', to_jsonb(v_elig),
    'eligible', b IS NOT NULL AND jsonb_array_length(b -> 'errors') = 0 AND cardinality(v_elig) = 0);
END $$;

-- Records a pending agreement (the CFO's confirmed terms). No money moves.
CREATE FUNCTION public.special_advance_create(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_planned date;
  v_purpose text := NULLIF(btrim(COALESCE(p_request ->> 'purpose', '')), '');
  b jsonb;
  t jsonb;
  s jsonb;
  v_errs text[] := '{}';
  v_elig text[];
  v_ext uuid;
  v_id uuid := gen_random_uuid();
  v_seq bigint;
  e public.special_advances%ROWTYPE;
  r jsonb;
BEGIN
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- Same key, concurrently or later: serialise, then return the advance already recorded for it.
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:key:' || v_key, 0));
  SELECT * INTO e FROM public.special_advances WHERE idempotency_key = v_key;

  BEGIN
    v_planned := NULLIF(p_request ->> 'planned_payout_date', '')::date;
  EXCEPTION WHEN others THEN
    v_errs := v_errs || 'planned_payout_date'::text;
  END;
  IF v_planned IS NOT NULL AND v_planned < v_today THEN v_errs := v_errs || 'planned_payout_date'::text; END IF;
  IF v_purpose IS NULL OR length(v_purpose) NOT BETWEEN 15 AND 1000 THEN v_errs := v_errs || 'purpose'::text; END IF;
  b := public._special_advance_parse_borrower(p_request);
  t := public._special_advance_parse_terms(p_request, COALESCE(v_planned, v_today));
  v_errs := v_errs || ARRAY(SELECT jsonb_array_elements_text(b -> 'errors')) || ARRAY(SELECT jsonb_array_elements_text(t -> 'errors'));
  IF cardinality(v_errs) > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = to_jsonb(v_errs)::text;
  END IF;
  s := t -> 'schedule';

  IF e.id IS NOT NULL THEN
    -- Replay: identical request -> the same advance; anything different -> refused.
    IF e.created_by = v_actor AND e.borrower_kind = b ->> 'kind'
       AND e.borrower_user_id IS NOT DISTINCT FROM (b ->> 'user_id')::uuid
       AND (e.principal, e.rate_percent, e.rate_basis, e.term_days, e.frequency)
           = ((s ->> 'principal')::bigint, (s ->> 'rate_percent')::numeric, s ->> 'rate_basis', (s ->> 'term_days')::int, s ->> 'frequency')
       AND e.purpose = v_purpose AND e.planned_payout_date IS NOT DISTINCT FROM v_planned
       AND (e.borrower_kind = 'welile_user' OR EXISTS (
             SELECT 1 FROM public.special_advance_external_borrowers x
              WHERE x.id = e.external_borrower_id AND x.borrower_type = b ->> 'borrower_type' AND x.full_name = b ->> 'full_name'
                AND x.phone = b ->> 'phone' AND x.national_id IS NOT DISTINCT FROM b ->> 'national_id'
                AND x.registration_number IS NOT DISTINCT FROM b ->> 'registration_number')) THEN
      RETURN public._special_advance_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505',
      DETAIL = 'This idempotency key was already used for a different request';
  END IF;

  IF NOT public._special_advance_issuance_enabled() THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCES_DISABLED' USING ERRCODE = '55000',
      DETAIL = 'Special Advance issuance is switched off (special_advance_settings.issuance_enabled)';
  END IF;
  -- CFO confirmation: the total the CFO saw must be the total the server computes.
  IF NULLIF(p_request ->> 'expected_total_repayable', '') IS NULL
     OR (p_request ->> 'expected_total_repayable') !~ '^[0-9]+$'
     OR (p_request ->> 'expected_total_repayable')::bigint <> (s ->> 'total_repayable')::bigint THEN
    RAISE EXCEPTION 'QUOTE_CHANGED' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('total_repayable', (s ->> 'total_repayable')::bigint)::text;
  END IF;

  -- One open advance per borrower: serialise on every identity the borrower has.
  IF b ->> 'kind' = 'welile_user' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:user:' || (b ->> 'user_id'), 0));
    IF (b ->> 'user_id')::uuid = v_actor THEN
      RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501', DETAIL = 'A CFO cannot record a Special Advance to themselves';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:phone:' || public._special_advance_norm_phone(b ->> 'phone'), 0));
    IF b ->> 'national_id' IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:nin:' || (b ->> 'national_id'), 0));
    END IF;
    IF b ->> 'registration_number' IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:reg:' || upper(b ->> 'registration_number'), 0));
    END IF;
  END IF;
  v_elig := public._special_advance_eligibility(b ->> 'kind', (b ->> 'user_id')::uuid, b ->> 'phone',
                                                 b ->> 'national_id', b ->> 'registration_number', NULL);
  IF cardinality(v_elig) > 0 THEN
    RAISE EXCEPTION 'BORROWER_NOT_ELIGIBLE' USING ERRCODE = '22023', DETAIL = to_jsonb(v_elig)::text;
  END IF;

  IF b ->> 'kind' = 'external' THEN
    INSERT INTO public.special_advance_external_borrowers (borrower_type, full_name, phone, national_id, registration_number,
                                                            organization, notes, created_by)
    VALUES (b ->> 'borrower_type', b ->> 'full_name', b ->> 'phone', b ->> 'national_id', b ->> 'registration_number',
            b ->> 'organization', b ->> 'notes', v_actor)
    RETURNING id INTO v_ext;
  END IF;

  v_seq := nextval('public.special_advance_ref_seq');
  INSERT INTO public.special_advances (
    id, reference, borrower_kind, borrower_user_id, external_borrower_id,
    principal, rate_percent, rate_basis, term_days, frequency,
    access_fee, registration_fee, total_repayable, instalments, instalment_amount, calc_version,
    purpose, planned_payout_date, idempotency_key, created_by)
  VALUES (
    v_id, 'SA-' || CASE WHEN length(v_seq::text) < 6 THEN lpad(v_seq::text, 6, '0') ELSE v_seq::text END,
    b ->> 'kind', (b ->> 'user_id')::uuid, v_ext,
    (s ->> 'principal')::bigint, (s ->> 'rate_percent')::numeric, s ->> 'rate_basis', (s ->> 'term_days')::int, s ->> 'frequency',
    (s ->> 'access_fee')::bigint, (s ->> 'registration_fee')::bigint, (s ->> 'total_repayable')::bigint,
    (s ->> 'instalments')::int, (s ->> 'instalment_amount')::bigint, s ->> 'calc_version',
    v_purpose, v_planned, v_key, v_actor);

  FOR r IN SELECT x FROM jsonb_array_elements(s -> 'schedule') x LOOP
    INSERT INTO public.special_advance_instalments (advance_id, number, due_offset_days, amount, access_fee, registration_fee, principal)
    VALUES (v_id, (r ->> 'number')::int, (r ->> 'due_date')::date - COALESCE(v_planned, v_today),
            (r ->> 'amount')::bigint, (r ->> 'access_fee')::bigint, (r ->> 'registration_fee')::bigint, (r ->> 'principal')::bigint);
  END LOOP;

  RETURN public._special_advance_json(v_id) || jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION public.special_advance_approve(p_id uuid, p_expected_updated_at timestamptz, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_reason text := public._special_advance_reason(p_reason, false);
  a public.special_advances%ROWTYPE := public._special_advance_lock(p_id, p_expected_updated_at);
  eb public.special_advance_external_borrowers%ROWTYPE;
  v_elig text[];
BEGIN
  IF a.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_PENDING' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF NOT public._special_advance_issuance_enabled() THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCES_DISABLED' USING ERRCODE = '55000';
  END IF;
  IF a.borrower_user_id = v_actor THEN
    RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501', DETAIL = 'A CFO cannot approve a Special Advance to themselves';
  END IF;
  SELECT * INTO eb FROM public.special_advance_external_borrowers WHERE id = a.external_borrower_id;
  v_elig := public._special_advance_eligibility(a.borrower_kind, a.borrower_user_id, eb.phone, eb.national_id,
                                                 eb.registration_number, a.id);
  IF cardinality(v_elig) > 0 THEN
    RAISE EXCEPTION 'BORROWER_NOT_ELIGIBLE' USING ERRCODE = '22023', DETAIL = to_jsonb(v_elig)::text;
  END IF;
  UPDATE public.special_advances
     SET status = 'approved', approved_by = v_actor, approved_at = clock_timestamp(), decision_reason = v_reason
   WHERE id = a.id;
  RETURN public._special_advance_json(a.id);
END $$;

CREATE FUNCTION public.special_advance_reject(p_id uuid, p_expected_updated_at timestamptz, p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_reason text := public._special_advance_reason(p_reason, true);
  a public.special_advances%ROWTYPE := public._special_advance_lock(p_id, p_expected_updated_at);
BEGIN
  IF a.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_PENDING' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  UPDATE public.special_advances
     SET status = 'rejected', rejected_by = v_actor, rejected_at = clock_timestamp(), decision_reason = v_reason
   WHERE id = a.id;
  RETURN public._special_advance_json(a.id);
END $$;

CREATE FUNCTION public.special_advance_cancel(p_id uuid, p_expected_updated_at timestamptz, p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_reason text := public._special_advance_reason(p_reason, true);
  a public.special_advances%ROWTYPE := public._special_advance_lock(p_id, p_expected_updated_at);
BEGIN
  IF a.status NOT IN ('pending_approval', 'approved') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CANCELLABLE' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  UPDATE public.special_advances
     SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = clock_timestamp(), decision_reason = v_reason
   WHERE id = a.id;
  RETURN public._special_advance_json(a.id);
END $$;

CREATE FUNCTION public.special_advance_get(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._special_advance_require_cfo();
  v := public._special_advance_json(p_id);
  IF v IS NULL THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION public.special_advance_list(p_status text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  PERFORM public._special_advance_require_cfo();
  RETURN jsonb_build_object(
    'issuance_enabled', public._special_advance_issuance_enabled(),
    'total_count', (SELECT count(*) FROM public.special_advances a WHERE p_status IS NULL OR a.status = p_status),
    'items', COALESCE((SELECT jsonb_agg(x.j ORDER BY x.created_at DESC, x.reference DESC) FROM (
        SELECT a.created_at, a.reference, to_jsonb(a) || jsonb_build_object(
                 'borrower_name', COALESCE(eb.full_name, NULLIF(btrim(pr.full_name), ''))) AS j
          FROM public.special_advances a
          LEFT JOIN public.special_advance_external_borrowers eb ON eb.id = a.external_borrower_id
          LEFT JOIN public.profiles pr ON pr.id = a.borrower_user_id
         WHERE p_status IS NULL OR a.status = p_status
         ORDER BY a.created_at DESC, a.reference DESC
         LIMIT v_limit OFFSET v_offset) x), '[]'::jsonb));
END $$;

-- ── Privileges ─────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._special_advance_require_cfo() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_issuance_enabled() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_kampala_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_norm_phone(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_eligibility(text, uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_parse_borrower(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_parse_terms(jsonb, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_json(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_lock(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_reason(text, boolean) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.special_advance_quote(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_create(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_approve(uuid, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_reject(uuid, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_cancel(uuid, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_get(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_list(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_quote(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_create(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_approve(uuid, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_reject(uuid, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_cancel(uuid, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_get(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_list(text, integer, integer) TO authenticated;

RESET lock_timeout;
