-- Special Advances: reverse a top-up recorded in error (CFO, 12 Nov 2026). Requires 20261119120000.
-- A third correction kind, 'topup_reversal', in special_advance_record_correction (CFO only, reason + proof, one
-- transaction, one posting per key). Opposite legs of the top-up (source special_advance_corrections):
--   CR A24 principal + fee | DR L1 (wallet: taken back from the borrower's wallet) or DR A1 (external) | DR R1 fee
-- Refused if a standing repayment was applied to the top-up's instalments (reverse it first), or if the borrower's
-- wallet no longer holds the top-up (available balance only, under the wallet lock; never an overdraft).
-- The top-up and its instalments stay on record, marked reversed, and stop counting in the position, allocation and
-- the borrower's view; the advance settles if nothing else is owed. A payout reversal is allowed again once every
-- top-up is reversed. Preflight pins production's definitions of 12 Nov 2026.
-- Rollback: supabase/rollbacks/20261119140000_special_advance_topup_reversal.rollback.sql

DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.special_advance_record_correction(uuid,jsonb)'::regprocedure)) <> '44a450f19d2af25f65154f5a926db723'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._special_advance_position(uuid)'::regprocedure)) <> 'c48edc39689d6080363d4c5d98b3754b'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._special_advance_apply_repayment(uuid,uuid,bigint)'::regprocedure)) <> '8586a5b49565a3980c2be13e43538ec0'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.special_advance_my_advances()'::regprocedure)) <> '91efb9fc3dc9c57040a773683e9ef90a'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._special_advance_correction_json(uuid)'::regprocedure)) <> '738f20100e14525d056a399e2d4c3bbb' THEN
    RAISE EXCEPTION 'precondition failed: a replaced function is no longer production''s definition of 12 Nov 2026; re-derive this migration';
  END IF;
  IF to_regclass('public.special_advance_topups') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: apply 20261119120000_special_advance_topups first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.special_advance_corrections'::regclass AND attname = 'topup_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'precondition failed: top-up reversal is already installed';
  END IF;
END $pre$;

-- 1. a correction can name a top-up; a top-up records the correction that reversed it
ALTER TABLE public.special_advance_corrections ADD COLUMN topup_id uuid REFERENCES public.special_advance_topups(id);
ALTER TABLE public.special_advance_corrections DROP CONSTRAINT special_advance_corrections_kind_check;
ALTER TABLE public.special_advance_corrections ADD CONSTRAINT special_advance_corrections_kind_check
  CHECK (kind = ANY (ARRAY['repayment_reversal'::text, 'payout_reversal'::text, 'topup_reversal'::text]));
ALTER TABLE public.special_advance_corrections ADD CONSTRAINT special_advance_corrections_topup_target
  CHECK ((kind = 'topup_reversal') = (topup_id IS NOT NULL));
CREATE UNIQUE INDEX special_advance_corrections_one_per_topup ON public.special_advance_corrections (topup_id) WHERE topup_id IS NOT NULL;
ALTER TABLE public.special_advance_topups ADD COLUMN reversed_by_correction uuid REFERENCES public.special_advance_corrections(id);

-- 2. top-ups stay insert-only, except that a posted top-up reversal marks its top-up, once
CREATE OR REPLACE FUNCTION public._special_advance_guard_topup()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT public._has_enabled_role(NEW.recorded_by, ARRAY['cfo']) THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_RECORDER_NOT_CFO' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.reversed_by_correction IS NULL AND NEW.reversed_by_correction IS NOT NULL
     AND (to_jsonb(NEW) - 'reversed_by_correction') = (to_jsonb(OLD) - 'reversed_by_correction')
     AND EXISTS (SELECT 1 FROM public.special_advance_corrections c
                  WHERE c.id = NEW.reversed_by_correction AND c.kind = 'topup_reversal' AND c.topup_id = OLD.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
END $function$;
REVOKE ALL ON FUNCTION public._special_advance_guard_topup() FROM PUBLIC, anon, authenticated;
DROP TRIGGER special_advance_topups_guard ON public.special_advance_topups;
CREATE TRIGGER special_advance_topups_guard BEFORE INSERT OR UPDATE OR DELETE ON public.special_advance_topups
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_topup();

-- 3. functions (production definitions + marked edits)
CREATE OR REPLACE FUNCTION public._special_advance_position(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH adv AS (
    -- the agreement plus every top-up recorded against it
    SELECT a.total_repayable + COALESCE((SELECT sum(t.total_repayable) FROM public.special_advance_topups t WHERE t.advance_id = a.id AND t.reversed_by_correction IS NULL), 0) AS total_repayable,
           a.status IN ('disbursed', 'settled') AS paid_out
      FROM public.special_advances a WHERE a.id = p_id
  ), inst AS (
    -- one access fee per instalment (a sa-calc-1 instalment stored the fixed part as registration_fee)
    SELECT i.number, i.topup_id, i.due_date, i.amount, i.access_fee + i.registration_fee AS access_fee, i.principal,
           COALESCE(s.a, 0) AS paid_access, COALESCE(s.p, 0) AS paid_principal
      FROM public.special_advance_instalments i
      LEFT JOIN (SELECT x.instalment_number, sum(x.access_fee + x.registration_fee) a, sum(x.principal) p
                   FROM public.special_advance_repayment_allocations x
                   JOIN public.special_advance_repayments r ON r.id = x.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE x.advance_id = p_id GROUP BY x.instalment_number) s
        ON s.instalment_number = i.number
     WHERE i.advance_id = p_id
       AND NOT EXISTS (SELECT 1 FROM public.special_advance_topups tr WHERE tr.id = i.topup_id AND tr.reversed_by_correction IS NOT NULL)  -- reversed top-up
  ), rows AS (
    SELECT *, amount - paid_access - paid_principal AS outstanding FROM inst
  ), g AS (
    SELECT COALESCE((SELECT paid_out FROM adv), false) AS paid_out
  )
  SELECT jsonb_build_object(
    'total_repayable', (SELECT total_repayable FROM adv),
    'paid_out', g.paid_out,
    'scheduled_outstanding', COALESCE((SELECT sum(outstanding) FROM rows), 0),
    'total_paid', COALESCE((SELECT sum(paid_access + paid_principal) FROM rows), 0),
    'outstanding', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(outstanding) FROM rows), 0) ELSE 0 END,
    'outstanding_access_fee', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(access_fee - paid_access) FROM rows), 0) ELSE 0 END,
    'outstanding_principal', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(principal - paid_principal) FROM rows), 0) ELSE 0 END,
    'overdue_amount', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(outstanding) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0), 0) ELSE 0 END,
    'overdue_instalments', CASE WHEN g.paid_out THEN (SELECT count(*) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0) ELSE 0 END,
    'instalments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', number, 'topup', topup_id IS NOT NULL, 'due_date', due_date, 'amount', amount,
        'paid', paid_access + paid_principal, 'outstanding', outstanding,
        'status', CASE WHEN outstanding = 0 THEN 'paid'
                       WHEN due_date IS NULL THEN 'not_due'
                       WHEN due_date < public._special_advance_kampala_today() THEN 'overdue'
                       WHEN outstanding < amount THEN 'part_paid' ELSE 'due' END) ORDER BY due_date NULLS LAST, number) FROM rows), '[]'::jsonb))
  FROM g;
$function$;

CREATE OR REPLACE FUNCTION public._special_advance_apply_repayment(p_advance_id uuid, p_repayment_id uuid, p_amount bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Allocates one recorded repayment across the instalments and settles the advance when nothing is outstanding.
-- Moved verbatim out of special_advance_record_repayment (production, 12 Nov 2026) so the CFO's Merchant Line
-- recording and the borrower's Pay from Wallet share ONE allocation rule. The caller holds the advance row lock.
DECLARE
  v_left bigint := p_amount;
  i record;
  v_split jsonb;
BEGIN
  FOR i IN
    -- one access fee per instalment (CFO decision 2026-11-03); allocations never record a registration fee
    SELECT x.number,
           x.access_fee + x.registration_fee - COALESCE(s.a, 0) AS access_fee,
           x.principal - COALESCE(s.p, 0) AS principal
      FROM public.special_advance_instalments x
      LEFT JOIN (SELECT al.instalment_number, sum(al.access_fee + al.registration_fee) a, sum(al.principal) p
                   FROM public.special_advance_repayment_allocations al
                   JOIN public.special_advance_repayments r ON r.id = al.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE al.advance_id = p_advance_id GROUP BY al.instalment_number) s
        ON s.instalment_number = x.number
     WHERE x.advance_id = p_advance_id
       AND NOT EXISTS (SELECT 1 FROM public.special_advance_topups tr WHERE tr.id = x.topup_id AND tr.reversed_by_correction IS NOT NULL)  -- reversed top-up
     ORDER BY x.due_date NULLS LAST, x.number  -- top-up instalments interleave by due date
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN i.access_fee + i.principal = 0;
    v_split := public._special_advance_allocate(jsonb_build_object('late_fee', 0, 'access_fee', i.access_fee,
                 'registration_fee', 0, 'principal', i.principal), v_left);
    INSERT INTO public.special_advance_repayment_allocations (repayment_id, advance_id, instalment_number, access_fee, registration_fee, principal)
    VALUES (p_repayment_id, p_advance_id, i.number, (v_split ->> 'access_fee')::bigint, 0, (v_split ->> 'principal')::bigint);
    v_left := (v_split ->> 'excess')::bigint;
  END LOOP;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF (public._special_advance_position(p_advance_id) ->> 'outstanding')::bigint = 0 THEN
    UPDATE public.special_advances SET status = 'settled', settled_at = clock_timestamp() WHERE id = p_advance_id;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_my_advances()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The signed-in borrower's own paid-out Special Advances, with what is owed, the schedule, their repayments and the
-- wallet balance they can pay from. Nothing about anyone else, no proof files, no staff names.
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'wallet_available', public.get_user_available_balance__impl(v_uid),
    'advances', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'reference', a.reference, 'status', a.status, 'principal', a.principal,
        'access_fee', a.access_fee + a.registration_fee, 'total_repayable', (public._special_advance_position(a.id) ->> 'total_repayable')::bigint,
        'topups', COALESCE((SELECT jsonb_agg(jsonb_build_object('reference', t.reference, 'date', t.topup_date, 'principal', t.principal,
            'access_fee', t.access_fee, 'total', t.total_repayable) ORDER BY t.recorded_at)
          FROM public.special_advance_topups t WHERE t.advance_id = a.id AND t.reversed_by_correction IS NULL), '[]'::jsonb),
        'payout_date', a.payout_date, 'settled_at', a.settled_at,
        'position', public._special_advance_position(a.id),
        'repayments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', r.id, 'amount', r.amount, 'paid_on', r.received_date, 'method', r.method, 'reference', r.reference,
            'reversed', r.reversed_by_correction IS NOT NULL) ORDER BY r.recorded_at DESC)
          FROM public.special_advance_repayments r WHERE r.advance_id = a.id), '[]'::jsonb))
        ORDER BY a.created_at DESC)
      FROM public.special_advances a
      WHERE a.borrower_kind = 'welile_user' AND a.borrower_user_id = v_uid AND a.status IN ('disbursed', 'settled')), '[]'::jsonb));
END $function$;

CREATE OR REPLACE FUNCTION public._special_advance_correction_json(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT to_jsonb(c) || jsonb_build_object(
    'advance_reference', a.reference,
    'recorded_by_name', NULLIF(btrim(rp.full_name), ''),
    'repayment', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', r.id, 'amount', r.amount, 'received_date', r.received_date, 'method', r.method, 'reference', r.reference) END,
    'topup', CASE WHEN tp.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', tp.id, 'reference', tp.reference, 'principal', tp.principal, 'access_fee', tp.access_fee,
        'total_repayable', tp.total_repayable, 'payout_method', tp.payout_method, 'topup_date', tp.topup_date) END)
    FROM public.special_advance_corrections c
    JOIN public.special_advances a ON a.id = c.advance_id
    LEFT JOIN public.special_advance_repayments r ON r.id = c.repayment_id
    LEFT JOIN public.special_advance_topups tp ON tp.id = c.topup_id
    LEFT JOIN public.profiles rp ON rp.id = c.recorded_by
   WHERE c.id = p_id;
$function$;

CREATE OR REPLACE FUNCTION public.special_advance_record_correction(p_id uuid, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_kind text := p_request ->> 'kind';
  v_reason text := NULLIF(btrim(COALESCE(p_request ->> 'reason', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_request ->> 'proof_path', '')), '');
  v_rep_id uuid;
  v_topup_id uuid;
  t public.special_advance_topups%ROWTYPE;
  v_avail numeric;
  a public.special_advances%ROWTYPE;
  r public.special_advance_repayments%ROWTYPE;
  e public.special_advance_corrections%ROWTYPE;
  v_amount bigint;
  v_id uuid := gen_random_uuid();
  v_ref text;
  v_today date := public._special_advance_kampala_today();
  v_src jsonb;
  v_legs jsonb;
  v_desc text;
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  BEGIN v_rep_id := NULLIF(p_request ->> 'repayment_id', '')::uuid; EXCEPTION WHEN others THEN v_rep_id := NULL; END;
  BEGIN v_topup_id := NULLIF(p_request ->> 'topup_id', '')::uuid; EXCEPTION WHEN others THEN v_topup_id := NULL; END;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:correction:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_corrections WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND e.kind = v_kind AND e.repayment_id IS NOT DISTINCT FROM v_rep_id
       AND e.topup_id IS NOT DISTINCT FROM v_topup_id
       AND e.proof_path = v_proof AND e.reason = v_reason THEN
      RETURN public._special_advance_correction_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.borrower_user_id = v_actor THEN
    RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('repayment_reversal', 'payout_reversal', 'topup_reversal') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["kind"]';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 20 AND 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023', DETAIL = 'Explain the error in 20 to 1000 characters';
  END IF;

  IF v_kind = 'repayment_reversal' THEN
    SELECT * INTO r FROM public.special_advance_repayments WHERE id = v_rep_id AND advance_id = a.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REPAYMENT_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF r.reversed_by_correction IS NOT NULL THEN
      RAISE EXCEPTION 'REPAYMENT_ALREADY_REVERSED' USING ERRCODE = '22023';
    END IF;
    IF a.status NOT IN ('disbursed', 'settled') THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF a.status = 'settled' AND a.borrower_user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.special_advances o WHERE o.borrower_user_id = a.borrower_user_id AND o.id <> a.id
                    AND o.status IN ('pending_approval', 'approved', 'disbursed')) THEN
      RAISE EXCEPTION 'BORROWER_HAS_OPEN_ADVANCE' USING ERRCODE = '22023',
        DETAIL = 'Reopening this advance would give the borrower two open Special Advances';
    END IF;
    v_amount := r.amount;
  ELSIF v_kind = 'topup_reversal' THEN
    -- a top-up recorded in error (CFO, 12 Nov 2026): undo its payout, fee and receivable; it stays on record, reversed
    SELECT * INTO t FROM public.special_advance_topups WHERE id = v_topup_id AND advance_id = a.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TOPUP_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF t.reversed_by_correction IS NOT NULL THEN
      RAISE EXCEPTION 'TOPUP_ALREADY_REVERSED' USING ERRCODE = '22023';
    END IF;
    IF a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    -- money already applied to the top-up's instalments must be reversed first (as for a payout reversal)
    IF EXISTS (SELECT 1 FROM public.special_advance_repayment_allocations x
                 JOIN public.special_advance_repayments rr ON rr.id = x.repayment_id AND rr.reversed_by_correction IS NULL
                 JOIN public.special_advance_instalments i ON i.advance_id = x.advance_id AND i.number = x.instalment_number
                WHERE x.advance_id = a.id AND i.topup_id = t.id) THEN
      RAISE EXCEPTION 'TOPUP_HAS_REPAYMENTS' USING ERRCODE = '22023';
    END IF;
    IF t.payout_method = 'wallet' THEN
      -- the money goes back out of the borrower's wallet: only what is available now, never an overdraft
      PERFORM 1 FROM public.wallet_balances_projection WHERE user_id = a.borrower_user_id FOR UPDATE;
      v_avail := COALESCE(public.get_user_available_balance__impl(a.borrower_user_id), 0);
      IF v_avail < t.principal THEN
        RAISE EXCEPTION 'TOPUP_FUNDS_NOT_IN_WALLET' USING ERRCODE = '22023',
          DETAIL = jsonb_build_object('available', v_avail, 'needed', t.principal)::text;
      END IF;
    END IF;
    v_amount := t.total_repayable;
  ELSE
    IF a.borrower_kind <> 'external' THEN  -- D11c: a wallet payout is not reversed here
      RAISE EXCEPTION 'PAYOUT_REVERSAL_NOT_SUPPORTED' USING ERRCODE = '22023',
        DETAIL = 'A payout to a Welile wallet cannot be reversed; only an external payout recorded in error';
    END IF;
    IF a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_topups t2 WHERE t2.advance_id = a.id AND t2.reversed_by_correction IS NULL) THEN
      RAISE EXCEPTION 'PAYOUT_REVERSAL_HAS_TOPUP' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_repayments x WHERE x.advance_id = a.id AND x.reversed_by_correction IS NULL) THEN
      RAISE EXCEPTION 'REPAYMENTS_MUST_BE_REVERSED_FIRST' USING ERRCODE = '22023';
    END IF;
    v_amount := a.total_repayable;
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D11d

  v_ref := 'SAC-' || lpad(nextval('public.special_advance_correction_seq')::text, 6, '0');
  v_desc := format('Special Advance %s correction %s', a.reference, v_ref);
  v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_corrections', 'source_id', v_id,
                              'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
  IF v_kind = 'repayment_reversal' AND r.method = 'wallet' THEN
    -- paid from the borrower's wallet: the money goes back to that wallet (CR L1) and the receivable is restored (DR A24)
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_wallet_repayment',
                                  'description', format('%s: wallet repayment ref %s reversed (receivable restored)', v_desc, r.reference)),
      v_src || jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_wallet_repayment',
                                  'user_id', a.borrower_user_id, 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
                                  'description', format('%s: wallet repayment ref %s returned to the borrower''s wallet', v_desc, r.reference)));
  ELSIF v_kind = 'repayment_reversal' THEN
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_repayment_received',
                                  'description', format('%s: repayment ref %s reversed (company cash)', v_desc, r.reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_repayment',
                                  'description', format('%s: repayment ref %s reversed (receivable restored)', v_desc, r.reference)));
  ELSIF v_kind = 'topup_reversal' THEN
    -- the opposite of the top-up's own legs
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', t.principal, 'category', 'special_advance_receivable',
                                  'description', format('%s: top-up %s principal receivable reversed', v_desc, t.reference)));
    IF t.payout_method = 'wallet' THEN
      v_legs := v_legs || (v_src || jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_out', 'amount', t.principal,
                                  'category', 'special_advance_credit', 'user_id', a.borrower_user_id, 'wallet_bucket', 'withdrawable',
                                  'recipient_type', 'user',
                                  'description', format('%s: top-up %s taken back from the borrower''s wallet', v_desc, t.reference)));
    ELSE
      v_legs := v_legs || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', t.principal, 'category', 'special_advance_payout_cash',
                                  'description', format('%s: top-up %s payout ref %s reversed (company cash)', v_desc, t.reference, t.payout_reference)));
    END IF;
    IF t.access_fee > 0 THEN
      v_legs := v_legs
        || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', t.access_fee, 'category', 'special_advance_fee_revenue',
                                        'description', format('%s: top-up %s access fee reversed', v_desc, t.reference)))
        || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', t.access_fee, 'category', 'special_advance_receivable',
                                        'description', format('%s: top-up %s access fee receivable reversed', v_desc, t.reference)));
    END IF;
  ELSE
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.principal, 'category', 'special_advance_payout_cash',
                                  'description', format('%s: payout ref %s reversed (company cash)', v_desc, a.payout_reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.principal, 'category', 'special_advance_receivable',
                                  'description', v_desc || ': principal receivable reversed'));
    -- one access fee (CFO decision 2026-11-03), as posted at payout
    IF a.access_fee + a.registration_fee > 0 THEN
      v_legs := v_legs
        || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.access_fee + a.registration_fee, 'category', 'special_advance_fee_revenue',
                                        'description', v_desc || ': access fee reversed'))
        || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.access_fee + a.registration_fee, 'category', 'special_advance_receivable',
                                        'description', v_desc || ': access fee receivable reversed'));
    END IF;
  END IF;

  -- one key per correction: it can post only once
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:correction:' || v_id::text, false);

  INSERT INTO public.special_advance_corrections (id, reference, advance_id, kind, repayment_id, topup_id, amount, reason, proof_path,
                                                  idempotency_key, ledger_group_id, recorded_by)
  VALUES (v_id, v_ref, a.id, v_kind, CASE WHEN v_kind = 'repayment_reversal' THEN r.id END,
          CASE WHEN v_kind = 'topup_reversal' THEN t.id END, v_amount, v_reason, v_proof,
          v_key, v_group, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'correction_posted', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('correction_id', v_id, 'kind', v_kind, 'amount', v_amount, 'repayment_id', r.id, 'topup_id', t.id,
                             'ledger_group_id', v_group));

  PERFORM set_config('special_advance.correction', v_id::text, true);
  IF v_kind = 'repayment_reversal' THEN
    UPDATE public.special_advance_repayments SET reversed_by_correction = v_id WHERE id = r.id;
    IF a.status = 'settled' THEN
      UPDATE public.special_advances SET status = 'disbursed', settled_at = NULL WHERE id = a.id;
    END IF;
  ELSIF v_kind = 'topup_reversal' THEN
    UPDATE public.special_advance_topups SET reversed_by_correction = v_id WHERE id = t.id;
    -- a new version of the advance; it settles if the top-up was all that was left
    IF (public._special_advance_position(a.id) ->> 'outstanding')::bigint = 0 THEN
      UPDATE public.special_advances SET status = 'settled', settled_at = clock_timestamp() WHERE id = a.id;
    ELSE
      UPDATE public.special_advances SET updated_at = clock_timestamp() WHERE id = a.id;
    END IF;
  ELSE
    UPDATE public.special_advances SET status = 'reversed' WHERE id = a.id;
  END IF;
  PERFORM set_config('special_advance.correction', '', true);

  RETURN public._special_advance_correction_json(v_id) || jsonb_build_object('replayed', false);
END $function$;
