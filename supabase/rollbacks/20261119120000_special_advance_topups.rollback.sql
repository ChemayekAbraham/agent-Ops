-- ROLLBACK of 20261119120000_special_advance_topups (only on CFO instruction). Restores production's definitions of 12 Nov 2026 verbatim.
-- Refuses while any top-up exists: a top-up is a real payout on the ledger and stays on record.
DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.special_advance_topups) THEN
    RAISE EXCEPTION 'rollback refused: top-ups exist; they stay on record';
  END IF;
END $pre$;
DROP FUNCTION public.special_advance_add_topup(uuid, timestamp with time zone, jsonb);
DROP FUNCTION public.special_advance_topup_quote(uuid, bigint);
DROP FUNCTION public._special_advance_topup_schedule(public.special_advances, bigint, date);
CREATE OR REPLACE FUNCTION public._special_advance_position(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH adv AS (
    SELECT a.total_repayable, a.status IN ('disbursed', 'settled') AS paid_out
      FROM public.special_advances a WHERE a.id = p_id
  ), inst AS (
    -- one access fee per instalment (a sa-calc-1 instalment stored the fixed part as registration_fee)
    SELECT i.number, i.due_date, i.amount, i.access_fee + i.registration_fee AS access_fee, i.principal,
           COALESCE(s.a, 0) AS paid_access, COALESCE(s.p, 0) AS paid_principal
      FROM public.special_advance_instalments i
      LEFT JOIN (SELECT x.instalment_number, sum(x.access_fee + x.registration_fee) a, sum(x.principal) p
                   FROM public.special_advance_repayment_allocations x
                   JOIN public.special_advance_repayments r ON r.id = x.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE x.advance_id = p_id GROUP BY x.instalment_number) s
        ON s.instalment_number = i.number
     WHERE i.advance_id = p_id
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
        'number', number, 'due_date', due_date, 'amount', amount,
        'paid', paid_access + paid_principal, 'outstanding', outstanding,
        'status', CASE WHEN outstanding = 0 THEN 'paid'
                       WHEN due_date IS NULL THEN 'not_due'
                       WHEN due_date < public._special_advance_kampala_today() THEN 'overdue'
                       WHEN outstanding < amount THEN 'part_paid' ELSE 'due' END) ORDER BY number) FROM rows), '[]'::jsonb))
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
     ORDER BY x.number
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

CREATE OR REPLACE FUNCTION public._special_advance_json(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- CFO decision 2026-11-03: reported as ONE access fee (a sa-calc-1 agreement stored the fixed part separately)
  SELECT (to_jsonb(a) - 'registration_fee') || jsonb_build_object(
    'access_fee', a.access_fee + a.registration_fee,
    'borrower_name', COALESCE(eb.full_name, NULLIF(btrim(pr.full_name), '')),
    'external_borrower', CASE WHEN eb.id IS NULL THEN NULL ELSE to_jsonb(eb) END,
    'schedule', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', i.number, 'due_offset_days', i.due_offset_days, 'due_date', i.due_date, 'amount', i.amount,
        'access_fee', i.access_fee + i.registration_fee, 'principal', i.principal) ORDER BY i.number)
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
$function$;

CREATE OR REPLACE FUNCTION public._special_advance_verify_agreement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- via jsonb: PL/pgSQL would resolve NEW.advance_id even on the branch taken for special_advances rows
  v_id uuid := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'special_advances' THEN 'id' ELSE 'advance_id' END)::uuid;
  a public.special_advances%ROWTYPE;
  s jsonb;
  v_rows jsonb;
BEGIN
  SELECT * INTO a FROM public.special_advances WHERE id = v_id;
  s := public._special_advance_schedule(a.principal, a.rate_percent, a.rate_basis, a.term_days, a.frequency, DATE '2000-01-01');
  IF (a.access_fee, a.registration_fee, a.total_repayable, a.instalments, a.instalment_amount, a.calc_version)
     IS DISTINCT FROM
     ((s->>'access_fee')::bigint, COALESCE((s->>'registration_fee')::bigint, 0), (s->>'total_repayable')::bigint,
      (s->>'instalments')::int, (s->>'instalment_amount')::bigint, s->>'calc_version') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_AMOUNTS_MISMATCH' USING ERRCODE = '23514', DETAIL = a.reference;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_array(i.number, i.due_offset_days, i.amount, i.access_fee, i.registration_fee, i.principal)
                            ORDER BY i.number), '[]'::jsonb)
    INTO v_rows FROM public.special_advance_instalments i WHERE i.advance_id = v_id;
  IF v_rows IS DISTINCT FROM (
       SELECT jsonb_agg(jsonb_build_array((r->>'number')::int, (r->>'due_date')::date - DATE '2000-01-01',
                                          (r->>'amount')::bigint, (r->>'access_fee')::bigint,
                                          COALESCE((r->>'registration_fee')::bigint, 0), (r->>'principal')::bigint)
                        ORDER BY (r->>'number')::int)
         FROM jsonb_array_elements(s->'schedule') r) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_MISMATCH' USING ERRCODE = '23514', DETAIL = a.reference;
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public._special_advance_guard_instalment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  a public.special_advances%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.special_advances WHERE id = NEW.advance_id;
  IF TG_OP = 'INSERT' THEN
    IF a.status <> 'pending_approval' OR NEW.due_date IS NOT NULL THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.advance_id, NEW.number, NEW.due_offset_days, NEW.amount, NEW.access_fee, NEW.registration_fee, NEW.principal)
     IS DISTINCT FROM
     (OLD.id, OLD.advance_id, OLD.number, OLD.due_offset_days, OLD.amount, OLD.access_fee, OLD.registration_fee, OLD.principal) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501';
  END IF;
  IF NEW.due_date IS DISTINCT FROM OLD.due_date
     AND NOT (OLD.due_date IS NULL AND a.status = 'disbursed' AND NEW.due_date = a.payout_date + OLD.due_offset_days) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501', DETAIL = 'due date';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_reconciliation()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger numeric;
  v_sub numeric;
  v_rows jsonb;
  v_a25 numeric;
  v_held numeric;
  v_a25_rows jsonb;
BEGIN
  PERFORM public._special_advance_require_cfo();
  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END), 0) INTO v_ledger
    FROM public.general_ledger gl
    JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A24'
                                     AND (m.wallet_bucket IS NULL OR m.wallet_bucket = gl.wallet_bucket)
   WHERE gl.category LIKE 'special\_advance\_%';
  SELECT COALESCE(sum((public._special_advance_position(a.id) ->> 'outstanding')::numeric), 0) INTO v_sub
    FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled', 'reversed', 'written_off');
  SELECT COALESCE(jsonb_agg(x ORDER BY x ->> 'reference'), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object('reference', a.reference, 'status', a.status,
             'subledger_outstanding', (public._special_advance_position(a.id) ->> 'outstanding')::numeric,
             'ledger_balance', COALESCE((
               SELECT sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END)
                 FROM public.general_ledger gl
                 JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A24'
                WHERE (gl.source_table = 'special_advances' AND gl.source_id = a.id)
                   OR (gl.source_table = 'special_advance_repayments' AND gl.source_id IN (SELECT r.id FROM public.special_advance_repayments r WHERE r.advance_id = a.id))
                   OR (gl.source_table = 'special_advance_corrections' AND gl.source_id IN (SELECT c.id FROM public.special_advance_corrections c WHERE c.advance_id = a.id))
                   OR (gl.source_table = 'special_advance_write_offs' AND gl.source_id IN (SELECT w.id FROM public.special_advance_write_offs w WHERE w.advance_id = a.id))), 0)) AS x
      FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled', 'reversed', 'written_off')) t
   WHERE (x ->> 'subledger_outstanding')::numeric <> (x ->> 'ledger_balance')::numeric;

  -- A25 is a contra-asset: its balance is the credit held (CR - DR)
  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN -gl.amount ELSE gl.amount END), 0) INTO v_a25
    FROM public.general_ledger gl
    JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A25'
                                     AND m.wallet_bucket IS NULL
   WHERE gl.category LIKE 'special\_advance\_%';
  SELECT COALESCE(sum(public._special_advance_allowance_held(a.id)), 0) INTO v_held FROM public.special_advances a;
  SELECT COALESCE(jsonb_agg(x ORDER BY x ->> 'reference'), '[]'::jsonb) INTO v_a25_rows FROM (
    SELECT jsonb_build_object('reference', a.reference, 'status', a.status,
             'allowance_subledger', public._special_advance_allowance_held(a.id),
             'allowance_ledger', COALESCE((
               SELECT sum(CASE WHEN gl.direction = m.debit_when THEN -gl.amount ELSE gl.amount END)
                 FROM public.general_ledger gl
                 JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A25'
                WHERE (gl.source_table = 'special_advance_provision_lines' AND gl.source_id IN (SELECT l.id FROM public.special_advance_provision_lines l WHERE l.advance_id = a.id))
                   OR (gl.source_table = 'special_advance_write_offs' AND gl.source_id IN (SELECT w.id FROM public.special_advance_write_offs w WHERE w.advance_id = a.id))), 0)) AS x
      FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled', 'reversed', 'written_off')) t
   WHERE (x ->> 'allowance_subledger')::numeric <> (x ->> 'allowance_ledger')::numeric;

  RETURN jsonb_build_object('a24_ledger_balance', v_ledger, 'subledger_outstanding', v_sub,
                            'difference', v_ledger - v_sub,
                            'a25_ledger_balance', v_a25, 'allowance_subledger', v_held, 'allowance_difference', v_a25 - v_held,
                            'net_receivable', v_ledger - v_a25,
                            'balanced', v_ledger = v_sub AND jsonb_array_length(v_rows) = 0
                                        AND v_a25 = v_held AND jsonb_array_length(v_a25_rows) = 0,
                            'mismatched_advances', v_rows, 'mismatched_allowances', v_a25_rows);
END $function$;

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
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:correction:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_corrections WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND e.kind = v_kind AND e.repayment_id IS NOT DISTINCT FROM v_rep_id
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
  IF v_kind IS NULL OR v_kind NOT IN ('repayment_reversal', 'payout_reversal') THEN
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
  ELSE
    IF a.borrower_kind <> 'external' THEN  -- D11c: a wallet payout is not reversed here
      RAISE EXCEPTION 'PAYOUT_REVERSAL_NOT_SUPPORTED' USING ERRCODE = '22023',
        DETAIL = 'A payout to a Welile wallet cannot be reversed; only an external payout recorded in error';
    END IF;
    IF a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
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

  INSERT INTO public.special_advance_corrections (id, reference, advance_id, kind, repayment_id, amount, reason, proof_path,
                                                  idempotency_key, ledger_group_id, recorded_by)
  VALUES (v_id, v_ref, a.id, v_kind, CASE WHEN v_kind = 'repayment_reversal' THEN r.id END, v_amount, v_reason, v_proof,
          v_key, v_group, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'correction_posted', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('correction_id', v_id, 'kind', v_kind, 'amount', v_amount, 'repayment_id', r.id,
                             'ledger_group_id', v_group));

  PERFORM set_config('special_advance.correction', v_id::text, true);
  IF v_kind = 'repayment_reversal' THEN
    UPDATE public.special_advance_repayments SET reversed_by_correction = v_id WHERE id = r.id;
    IF a.status = 'settled' THEN
      UPDATE public.special_advances SET status = 'disbursed', settled_at = NULL WHERE id = a.id;
    END IF;
  ELSE
    UPDATE public.special_advances SET status = 'reversed' WHERE id = a.id;
  END IF;
  PERFORM set_config('special_advance.correction', '', true);

  RETURN public._special_advance_correction_json(v_id) || jsonb_build_object('replayed', false);
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
        'access_fee', a.access_fee + a.registration_fee, 'total_repayable', a.total_repayable,
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

ALTER TABLE public.special_advance_events DROP CONSTRAINT special_advance_events_event_type_check;
ALTER TABLE public.special_advance_events ADD CONSTRAINT special_advance_events_event_type_check CHECK (event_type = ANY (ARRAY[
  'created'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text, 'disbursed'::text, 'settled'::text, 'reopened'::text,
  'reversed'::text, 'correction_posted'::text, 'written_off'::text, 'write_off_posted'::text, 'provision_posted'::text,
  'recovery_recorded'::text]));
DROP INDEX public.special_advance_instalments_topup;
ALTER TABLE public.special_advance_instalments DROP COLUMN topup_id;
DROP TABLE public.special_advance_topups;
DROP SEQUENCE public.special_advance_topup_seq;
