-- FUNDIN-HOTFIX-1. Approved: Bwayo (HR Lead), 2 Oct 2026, on executive authority.
-- Top-ups deposited before the gate cutover were commissioned by the old engine at approval.
-- The 16:00 UTC merge job completed four of them and the gate paid them a second time (UGX 291,000).
-- 1) The gate never pays a pre-cutover top-up. 2) Reverse those duplicates. 3) Close the queued ones.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled') THEN
    RAISE EXCEPTION 'FINGERPRINT FAIL: not the RentFlow database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commission_gate_settings WHERE id) THEN
    RAISE EXCEPTION 'PRECONDITION FAIL: gate not live';
  END IF;
END $pre$;

DO $patch$
DECLARE
  d text;
  v_anchor constant text := $a$IF fi.status <> 'unattributed' THEN RETURN jsonb_build_object('status','skipped','reason','status_' || fi.status); END IF;$a$;
  v_guard constant text := $g$

  -- Top-ups deposited before the gate cutover were commissioned by the old engine at approval
  -- (or are settled by the recompute). The gate never pays them, even if they complete later.
  IF fi.fund_in_key LIKE 'pwo:%' AND EXISTS (
       SELECT 1 FROM public.pending_wallet_operations w
        WHERE w.id::text = split_part(fi.fund_in_key, ':', 2)
          AND w.created_at < (SELECT s.cutover_at FROM public.commission_gate_settings s WHERE s.id)) THEN
    UPDATE public.commission_fund_ins SET status = 'not_commissionable' WHERE id = fi.id;
    RETURN jsonb_build_object('status','skipped','reason','pre_gate_topup');
  END IF;$g$;
BEGIN
  d := pg_get_functiondef('public.commission_pay_fund_in(uuid)'::regprocedure);
  IF position('pre_gate_topup' in d) > 0 THEN RAISE EXCEPTION 'already patched'; END IF;
  IF position(v_anchor in d) = 0 THEN RAISE EXCEPTION 'anchor not found in commission_pay_fund_in'; END IF;
  d := replace(d, v_anchor, v_anchor || v_guard);
  EXECUTE d;
END $patch$;

DO $rev$
DECLARE r record; v_n int := 0; v_total numeric := 0; v_idem text; v_group uuid;
BEGIN
  FOR r IN
    SELECT f.id, f.fund_in_key, f.earner_id, f.commission, f.partner_id, f.source_table, f.source_id, f.legacy_table, f.legacy_id
      FROM public.commission_fund_ins f
      JOIN public.pending_wallet_operations w ON w.id::text = split_part(f.fund_in_key, ':', 2)
     WHERE f.fund_in_key LIKE 'pwo:%' AND f.status = 'paid'
       AND w.created_at < (SELECT s.cutover_at FROM public.commission_gate_settings s WHERE s.id)
     ORDER BY f.occurred_at
  LOOP
    v_idem := 'fund_in_commission_reversal:' || r.fund_in_key;
    IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = v_idem) THEN CONTINUE; END IF;
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.earner_id, 'amount', r.commission, 'direction','cash_out',
          'category','correction_reversal', 'source_table', r.source_table, 'source_id', r.source_id::text,
          'reference_id', v_idem, 'linked_party', r.partner_id::text, 'ledger_scope','wallet', 'recipient_type','user',
          'description','Reversal: duplicate commission on a pre-gate top-up (already paid at approval)'),
        jsonb_build_object('user_id', r.earner_id, 'amount', r.commission, 'direction','cash_in',
          'category','marketing_expense', 'source_table', r.source_table, 'source_id', r.source_id::text,
          'reference_id', v_idem, 'linked_party', r.partner_id::text, 'ledger_scope','platform',
          'description','Marketing expense reversed: duplicate commission on a pre-gate top-up')),
      v_idem, false);
    UPDATE public.commission_fund_ins SET status = 'not_commissionable' WHERE id = r.id;
    IF r.legacy_table = 'proxy_commission_queue' THEN
      UPDATE public.proxy_commission_queue
         SET status = 'rejected', decided_at = now(),
             decision_note = 'reversed 2 Oct 2026: duplicate of legacy commission on a pre-gate top-up'
       WHERE id = r.legacy_id;
    ELSIF r.legacy_table = 'promissory_commission_events' THEN
      UPDATE public.promissory_commission_events
         SET status = 'skipped', skip_reason = 'reversed 2 Oct 2026: duplicate of legacy commission on a pre-gate top-up'
       WHERE id = r.legacy_id;
    END IF;
    INSERT INTO public.system_events (event_type, user_id, entity_type, entity_id, metadata)
    VALUES ('wallet_transfer', r.earner_id, 'commission_fund_ins', r.id,
      jsonb_build_object('action','reversal','fund_in_key', r.fund_in_key, 'amount', r.commission,
                         'idempotency_key', v_idem, 'ledger_group_id', v_group));
    v_n := v_n + 1;
    v_total := v_total + r.commission;
  END LOOP;

  IF v_n < 4 THEN
    RAISE EXCEPTION 'expected at least 4 reversals (UGX 291,000), got % / % — nothing written', v_n, v_total;
  END IF;

  UPDATE public.commission_fund_ins f SET status = 'not_commissionable'
    FROM public.pending_wallet_operations w
   WHERE f.fund_in_key LIKE 'pwo:%' AND f.status = 'unattributed'
     AND w.id::text = split_part(f.fund_in_key, ':', 2)
     AND w.created_at < (SELECT s.cutover_at FROM public.commission_gate_settings s WHERE s.id);
END $rev$;

SELECT f.fund_in_key, f.status, f.commission,
       (SELECT count(*) FROM public.general_ledger g WHERE g.idempotency_key = 'fund_in_commission_reversal:' || f.fund_in_key) AS reversal_rows
  FROM public.commission_fund_ins f
  JOIN public.pending_wallet_operations w ON w.id::text = split_part(f.fund_in_key, ':', 2)
 WHERE f.fund_in_key LIKE 'pwo:%'
   AND w.created_at < (SELECT s.cutover_at FROM public.commission_gate_settings s WHERE s.id)
 ORDER BY f.commission DESC NULLS LAST;