-- 2026-11-03: A7 Partner Commitments Receivable - derecognise on promissory note deletion. Production apply needs
-- explicit CFO approval.
-- Problem: bulk_delete_promissory_notes and partner_ops_bulk_delete_proxy_agents DELETE promissory notes without
-- reversing the partner receivable recognised when the note was activated (DR A7 / CR L2). On 2026-11-03, 86 deleted
-- notes still carried UGX 51,183,000 in A7 (A7 4,080,365,106 = activated notes net of collections 4,029,182,106 +
-- 51,183,000).
-- ACCOUNTING ONLY. No wallet leg, no money movement, no bonus recovery, no change to any existing note or obligation.
--   1. promissory_note_derecognitions: one row per deleted note that carried A7 or a review flag (evidence + flags:
--      collections, bonus_paid, outstanding_obligation, linked_commitment, ledger_differs). CFO/CEO/COO/super_admin
--      read; written only by the functions below. Staff-MFA policy.
--   2. _partner_receivable_derecognise_deleted(): DR L2 partner_receivable_capital / CR A7 partner_receivable_created
--      for the note's NET A7 in the ledger (the legs of derecognise_partner_receivable(); key partner_recv_rev:<note>),
--      linked to the note id (source_id) and its recognition group (reference_id). Net, not amount - collected: A7 holds
--      what was recognised (amount - collected at activation); removing exactly that can never over-reverse; a
--      difference is flagged ledger_differs for review.
--   3. BEFORE DELETE trigger on promissory_notes: every delete path, present and future, derecognises in the SAME
--      transaction (a failure aborts the delete) and writes the review row and an audit_logs row. A note already
--      derecognised (e.g. by derecognise_partner_receivable) has net 0: nothing is posted twice.
--   4. Historical correction: one new balanced group per deleted note still carrying A7 (append-only; nothing edited).
-- Categories, mappings and allowlist are reused unchanged; the resolver has no override for them; the CFO "Money
-- received" reports do not count partner_receivable_capital.
-- Rollback: supabase/rollbacks/20261103210000_a7_promissory_note_delete_derecognition.rollback.sql (trigger and functions; the table and ledger entries stay).
-- Tests: src/test/a7PromissoryNoteDeletion.test.ts. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.derecognise_partner_receivable(uuid, text)'))
       IS DISTINCT FROM '09ba9ff64c8eecb43a14c607aa7d5724'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.recognise_partner_receivable(uuid)'))
       IS DISTINCT FROM 'd02bb2e588ae54a425df29e548fcf666'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.trg_recognise_partner_receivable()'))
       IS DISTINCT FROM 'af931f318f851cf8fa2a9a51a9a8d81c'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.bulk_delete_promissory_notes(uuid[], text)'))
       IS DISTINCT FROM '664c9f39c47ef78fc3b6d9d474765f4a'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.partner_ops_bulk_delete_proxy_agents(uuid[], text)'))
       IS DISTINCT FROM '8f5cb003e4278182f6f1a4ec075905d9'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.create_ledger_transaction(jsonb, text, boolean)'))
       IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.sofp_ledger_legs(timestamp with time zone)'))
       IS DISTINCT FROM '843ccf477014f8c7a8e0b5c6f14a1ba0' THEN
    RAISE EXCEPTION 'A7 deletion accounting: preflight refused - a function differs from the production definition of 2026-11-03';
  END IF;
  IF (SELECT count(*) FROM public.ledger_account_map m
      WHERE m.wallet_bucket IS NULL AND (m.ledger_scope, m.category, m.account_code, m.debit_when) IN (
        ('bridge', 'partner_receivable_created', 'A7', 'cash_in'),
        ('platform', 'partner_receivable_capital', 'L2', 'cash_in'))) <> 2
     OR EXISTS (SELECT 1 FROM public.ledger_account_map m WHERE m.wallet_bucket IS NOT NULL
                AND m.category IN ('partner_receivable_created', 'partner_receivable_capital'))
     OR NOT (public.ledger_category_allowlist() @> ARRAY['partner_receivable_created', 'partner_receivable_capital']) THEN
    RAISE EXCEPTION 'A7 deletion accounting: ledger_account_map / allowlist not as expected (A7 / L2)';
  END IF;
  IF to_regclass('public.promissory_note_derecognitions') IS NOT NULL
     OR to_regprocedure('public._partner_receivable_derecognise_deleted(uuid, text, text, text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.promissory_notes'::regclass AND NOT t.tgisinternal
                AND (t.tgtype & 8) <> 0) THEN
    RAISE EXCEPTION 'A7 deletion accounting: already installed, or promissory_notes already has a DELETE trigger';
  END IF;
  IF to_regprocedure('public.has_role(uuid, app_role)') IS NULL OR to_regprocedure('public.staff_mfa_ok()') IS NULL THEN
    RAISE EXCEPTION 'A7 deletion accounting: has_role(uuid, app_role) / staff_mfa_ok() missing';
  END IF;
END $pre$;

-- ---------------------------------------------------------------- 1. review / evidence table
CREATE TABLE public.promissory_note_derecognitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL UNIQUE,                    -- the deleted promissory note (one row per note: duplicate-safe)
  origin text NOT NULL CHECK (origin IN ('delete_trigger', 'historical_correction')),
  partner_name text, agent_id uuid, partner_user_id uuid, note_status text,
  note_amount numeric, total_collected numeric, approval_bonus_paid boolean,
  bonus_net numeric NOT NULL DEFAULT 0,            -- agent commission still on the books for the note (not recovered)
  a7_recognised numeric NOT NULL DEFAULT 0,        -- gross A7 ever recognised for the note
  a7_derecognised numeric NOT NULL DEFAULT 0,      -- A7 removed by this deletion
  ledger_group_id uuid, idempotency_key text, recognition_group_id uuid,
  deleted_by uuid, deleted_at timestamptz, delete_action text, delete_reason text,
  flags text[] NOT NULL DEFAULT '{}',              -- collections, bonus_paid, outstanding_obligation, linked_commitment, ledger_differs
  review_status text NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'reviewed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.promissory_note_derecognitions IS
  'One row per deleted promissory note that carried a partner receivable (A7) or a review flag: what was derecognised, '
  'by which ledger group, who deleted it and why. Written only by the delete trigger and the 2026-11-03 correction.';
ALTER TABLE public.promissory_note_derecognitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cfo_reads_note_derecognitions ON public.promissory_note_derecognitions FOR SELECT TO authenticated
  USING ((select public.has_role((select auth.uid()), 'cfo'::app_role)) OR (select public.has_role((select auth.uid()), 'ceo'::app_role))
      OR (select public.has_role((select auth.uid()), 'coo'::app_role)) OR (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
create policy mfa_required_for_staff on public.promissory_note_derecognitions as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
REVOKE ALL ON public.promissory_note_derecognitions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.promissory_note_derecognitions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promissory_note_derecognitions TO service_role;

-- ---------------------------------------------------------------- 2. derecognition helper (closed)
CREATE OR REPLACE FUNCTION public._partner_receivable_derecognise_deleted(p_note_id uuid, p_partner_name text,
  p_status text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Removes whatever partner receivable (A7) the ledger still carries for promissory note p_note_id, which is being or
-- has been deleted: DR L2 partner_receivable_capital / CR A7 partner_receivable_created, the same two legs and
-- categories as derecognise_partner_receivable(). Amount = the note's net A7 in the ledger (recognised minus already
-- derecognised), so it can never remove more than was recognised and never double: a note already derecognised has
-- net 0 and posts nothing. Idempotency key partner_recv_rev:<note id> (the key derecognise_partner_receivable uses);
-- if that key was used before and the note was recognised again, partner_recv_rev:<note id>:deleted. Platform and
-- bridge legs only: no wallet, no money moves.
DECLARE
  v_net numeric := 0; v_recognised numeric := 0; v_first uuid; v_key text; v_group uuid; v_legs jsonb;
  v_who text := COALESCE(NULLIF(btrim(p_partner_name), ''), 'partner');
  v_why text := COALESCE(NULLIF(btrim(p_reason), ''), 'no reason recorded');
BEGIN
  IF p_note_id IS NULL THEN
    RAISE EXCEPTION 'partner receivable derecognition: note id is required';
  END IF;
  SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0),
         COALESCE(sum(g.amount) FILTER (WHERE g.direction = 'cash_in'), 0),
         (array_agg(g.transaction_group_id ORDER BY g.created_at, g.id) FILTER (WHERE g.direction = 'cash_in'))[1]
    INTO v_net, v_recognised, v_first
  FROM public.general_ledger g
  WHERE g.category = 'partner_receivable_created' AND g.source_table = 'promissory_notes' AND g.source_id = p_note_id;

  IF v_net <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'amount', 0, 'net_before', v_net, 'recognised', v_recognised,
                              'recognition_group_id', v_first);
  END IF;

  v_key := 'partner_recv_rev:' || p_note_id::text;
  IF EXISTS (SELECT 1 FROM public.general_ledger x WHERE x.idempotency_key = v_key) THEN
    v_key := v_key || ':deleted';
    IF EXISTS (SELECT 1 FROM public.general_ledger x WHERE x.idempotency_key = v_key) THEN
      RAISE EXCEPTION 'partner receivable derecognition for deleted note % was already posted, yet % is still recognised',
        p_note_id, v_net;
    END IF;
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object('amount', v_net, 'direction', 'cash_out',
      'category', 'partner_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
      'description', 'A7 correction (reversal): removes the partner receivable recognised for ' || v_who
        || ' on promissory note ' || p_note_id::text || ', which was deleted (status ' || COALESCE(p_status, 'unknown')
        || '). Reason: ' || v_why,
      'source_table', 'promissory_notes', 'source_id', p_note_id, 'reference_id', v_first::text),
    jsonb_build_object('amount', v_net, 'direction', 'cash_in',
      'category', 'partner_receivable_capital', 'ledger_scope', 'platform', 'classification', 'production',
      'description', 'A7 correction (reversal): removes the partner capital obligation recognised for ' || v_who
        || ' on deleted promissory note ' || p_note_id::text || '. Reason: ' || v_why,
      'source_table', 'promissory_notes', 'source_id', p_note_id, 'reference_id', v_first::text));
  v_group := public.create_ledger_transaction(v_legs, v_key, false);

  RETURN jsonb_build_object('posted', true, 'amount', v_net, 'net_before', v_net, 'recognised', v_recognised,
                            'group_id', v_group, 'idempotency_key', v_key, 'recognition_group_id', v_first);
END $function$;
REVOKE ALL ON FUNCTION public._partner_receivable_derecognise_deleted(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 3. delete trigger
CREATE OR REPLACE FUNCTION public.trg_derecognise_partner_receivable_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- BEFORE DELETE on promissory_notes, every delete path (bulk delete, proxy-agent delete, direct SQL, future paths):
-- removes the note's net A7 in the same transaction (a failure aborts the delete), records the deletion in
-- promissory_note_derecognitions (with review flags) and in audit_logs. Flags, never blocks.
DECLARE
  v_aud record; v_res jsonb; v_bonus numeric := 0; v_flags text[] := '{}'; v_reason text; v_net numeric;
BEGIN
  SELECT a.user_id, a.action, COALESCE(NULLIF(btrim(a.reason), ''), a.metadata->>'reason') AS reason
    INTO v_aud
  FROM public.audit_logs a
  WHERE a.record_id = OLD.id::text AND a.table_name = 'promissory_notes' AND a.created_at >= now()
  ORDER BY a.created_at DESC LIMIT 1;
  v_reason := COALESCE(NULLIF(btrim(v_aud.reason), ''), NULLIF(btrim(current_setting('app.promissory_delete_reason', true)), ''),
                       'deleted without a recorded reason');

  v_res := public._partner_receivable_derecognise_deleted(OLD.id, OLD.partner_name, OLD.status, v_reason);
  v_net := (v_res->>'net_before')::numeric;

  SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0) INTO v_bonus
  FROM public.general_ledger g
  WHERE g.source_table = 'promissory_notes' AND g.source_id = OLD.id AND g.category = 'agent_commission' AND g.ledger_scope = 'wallet';

  IF COALESCE(OLD.total_collected, 0) > 0 THEN v_flags := array_append(v_flags, 'collections'); END IF;
  IF COALESCE(OLD.approval_bonus_paid, false) OR v_bonus > 0 THEN v_flags := array_append(v_flags, 'bonus_paid'); END IF;
  IF OLD.status = 'activated' AND COALESCE(OLD.amount, 0) - COALESCE(OLD.total_collected, 0) > 0 THEN
    v_flags := array_append(v_flags, 'outstanding_obligation');
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_self_commitments s WHERE s.promissory_note_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.funder_pending_portfolios f WHERE f.promissory_note_id = OLD.id) THEN
    v_flags := array_append(v_flags, 'linked_commitment');
  END IF;
  IF OLD.status = 'activated' AND v_net <> GREATEST(COALESCE(OLD.amount, 0) - COALESCE(OLD.total_collected, 0), 0) THEN
    v_flags := array_append(v_flags, 'ledger_differs');
  END IF;

  IF (v_res->>'recognised')::numeric > 0 OR cardinality(v_flags) > 0 THEN
    INSERT INTO public.promissory_note_derecognitions (note_id, origin, partner_name, agent_id, partner_user_id, note_status,
      note_amount, total_collected, approval_bonus_paid, bonus_net, a7_recognised, a7_derecognised, ledger_group_id,
      idempotency_key, recognition_group_id, deleted_by, deleted_at, delete_action, delete_reason, flags)
    VALUES (OLD.id, 'delete_trigger', OLD.partner_name, OLD.agent_id, OLD.partner_user_id, OLD.status, OLD.amount,
      OLD.total_collected, OLD.approval_bonus_paid, v_bonus, (v_res->>'recognised')::numeric, (v_res->>'amount')::numeric,
      (v_res->>'group_id')::uuid, v_res->>'idempotency_key', (v_res->>'recognition_group_id')::uuid,
      COALESCE(v_aud.user_id, auth.uid()), now(), v_aud.action, v_reason, v_flags);
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
    VALUES (COALESCE(v_aud.user_id, auth.uid()), 'a7_derecognised_on_delete', 'promissory_note_deleted', 'promissory_notes',
      OLD.id::text, v_reason,
      jsonb_build_object('amount', (v_res->>'amount')::numeric, 'ledger_group_id', v_res->>'group_id',
        'idempotency_key', v_res->>'idempotency_key', 'flags', to_jsonb(v_flags), 'note_amount', OLD.amount,
        'total_collected', OLD.total_collected, 'status', OLD.status, 'bonus_net', v_bonus));
  END IF;
  RETURN OLD;
END $function$;
REVOKE ALL ON FUNCTION public.trg_derecognise_partner_receivable_on_delete() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER derecognise_partner_receivable_on_delete BEFORE DELETE ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.trg_derecognise_partner_receivable_on_delete();

-- ---------------------------------------------------------------- 4. historical correction (append-only)
-- Every promissory note that was deleted while the ledger still carried its partner receivable (86 notes, UGX
-- 51,183,000 on 2026-11-03, deleted 2026-09-28 .. 2026-10-27) gets one new balanced group DR L2 / CR A7 for its net
-- A7, linked to the note id, plus a review row with the deletion evidence from audit_logs. Idempotent.
DO $hist$
DECLARE
  r record; v_aud record; v_meta jsonb; v_res jsonb; v_bonus numeric; v_flags text[]; v_reason text; v_n int := 0; v_total numeric := 0;
BEGIN
  FOR r IN
    SELECT g.source_id AS sid, min(g.created_at) AS first_at
    FROM public.general_ledger g
    WHERE g.category = 'partner_receivable_created' AND g.source_table = 'promissory_notes'
      AND NOT EXISTS (SELECT 1 FROM public.promissory_notes p WHERE p.id = g.source_id)
    GROUP BY g.source_id
    HAVING sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) > 0
    ORDER BY min(g.created_at), g.source_id
  LOOP
    v_aud := NULL;
    SELECT a.user_id, a.action, a.action_type, a.created_at, a.metadata,
           COALESCE(NULLIF(btrim(a.reason), ''), a.metadata->>'reason') AS reason
      INTO v_aud
    FROM public.audit_logs a
    WHERE a.record_id = r.sid::text AND a.table_name = 'promissory_notes'
      AND (a.action_type = 'delete' OR a.action ILIKE '%delete%')
    ORDER BY a.created_at DESC LIMIT 1;
    v_meta := COALESCE(v_aud.metadata, '{}'::jsonb);
    v_reason := 'note deleted ' || COALESCE(to_char(v_aud.created_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD'), '(date not recorded)')
      || ' via ' || COALESCE(v_aud.action, 'unknown path') || ' ("' || COALESCE(v_aud.reason, 'no reason recorded')
      || '") without reversing its receivable; CFO-approved correction 2026-11-03';
    v_res := public._partner_receivable_derecognise_deleted(r.sid, v_meta->>'partner_name', COALESCE(v_meta->>'status', 'unknown'), v_reason);

    SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0) INTO v_bonus
    FROM public.general_ledger g
    WHERE g.source_table = 'promissory_notes' AND g.source_id = r.sid AND g.category = 'agent_commission' AND g.ledger_scope = 'wallet';
    v_flags := '{}';
    IF COALESCE((v_meta->>'total_collected')::numeric, 0) > 0 THEN v_flags := array_append(v_flags, 'collections'); END IF;
    IF COALESCE((v_meta->>'approval_bonus_paid')::boolean, false) OR v_bonus > 0 THEN v_flags := array_append(v_flags, 'bonus_paid'); END IF;
    IF v_meta->>'status' = 'activated'
       AND COALESCE((v_meta->>'amount')::numeric, 0) - COALESCE((v_meta->>'total_collected')::numeric, 0) > 0 THEN
      v_flags := array_append(v_flags, 'outstanding_obligation');
    END IF;
    IF v_meta ? 'amount' AND (v_res->>'net_before')::numeric
         <> GREATEST(COALESCE((v_meta->>'amount')::numeric, 0) - COALESCE((v_meta->>'total_collected')::numeric, 0), 0) THEN
      v_flags := array_append(v_flags, 'ledger_differs');
    END IF;
    IF v_aud.created_at IS NULL THEN v_flags := array_append(v_flags, 'no_deletion_record'); END IF;

    INSERT INTO public.promissory_note_derecognitions (note_id, origin, partner_name, agent_id, note_status, note_amount,
      total_collected, approval_bonus_paid, bonus_net, a7_recognised, a7_derecognised, ledger_group_id, idempotency_key,
      recognition_group_id, deleted_by, deleted_at, delete_action, delete_reason, flags)
    VALUES (r.sid, 'historical_correction', v_meta->>'partner_name', NULLIF(v_meta->>'agent_id', '')::uuid, v_meta->>'status',
      (v_meta->>'amount')::numeric, (v_meta->>'total_collected')::numeric, (v_meta->>'approval_bonus_paid')::boolean, v_bonus,
      (v_res->>'recognised')::numeric, (v_res->>'amount')::numeric, (v_res->>'group_id')::uuid, v_res->>'idempotency_key',
      (v_res->>'recognition_group_id')::uuid, v_aud.user_id, v_aud.created_at, v_aud.action, v_aud.reason, v_flags)
    ON CONFLICT (note_id) DO NOTHING;
    v_n := v_n + 1; v_total := v_total + COALESCE((v_res->>'amount')::numeric, 0);
  END LOOP;
  RAISE NOTICE 'A7 historical correction: % deleted notes, UGX % derecognised', v_n, v_total;
END $hist$;

-- ---------------------------------------------------------------- 5. post-checks
DO $post$
DECLARE v_left numeric; v_rows int; v_bad int;
BEGIN
  -- no deleted note carries a partner receivable any more
  SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0) INTO v_left
  FROM public.general_ledger g
  WHERE g.category = 'partner_receivable_created' AND g.source_table = 'promissory_notes'
    AND NOT EXISTS (SELECT 1 FROM public.promissory_notes p WHERE p.id = g.source_id);
  -- every correction group is two legs, balanced raw and on mapped accounts, no wallet leg
  SELECT count(*) INTO v_bad FROM (
    SELECT g.transaction_group_id
    FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE g.transaction_group_id IN (SELECT ledger_group_id FROM public.promissory_note_derecognitions WHERE ledger_group_id IS NOT NULL)
    GROUP BY 1
    HAVING count(*) <> 2
        OR sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) <> 0
        OR sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) <> 0
        OR bool_or(g.ledger_scope = 'wallet')) z;
  SELECT count(*) INTO v_rows FROM public.promissory_note_derecognitions WHERE origin = 'historical_correction';
  IF v_left <> 0 OR v_bad <> 0 THEN
    RAISE EXCEPTION 'A7 deletion accounting: post-check failed (A7 left on deleted notes %, bad groups %)', v_left, v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.promissory_notes'::regclass
                 AND tgname = 'derecognise_partner_receivable_on_delete' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'A7 deletion accounting: delete trigger missing';
  END IF;
  IF has_function_privilege('authenticated', 'public._partner_receivable_derecognise_deleted(uuid, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._partner_receivable_derecognise_deleted(uuid, text, text, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.promissory_note_derecognitions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.promissory_note_derecognitions', 'UPDATE')
     OR has_table_privilege('anon', 'public.promissory_note_derecognitions', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.promissory_note_derecognitions', 'SELECT') THEN
    RAISE EXCEPTION 'A7 deletion accounting: grants not as intended';
  END IF;
  RAISE NOTICE 'A7 deletion accounting: % historical review rows', v_rows;
END $post$;
