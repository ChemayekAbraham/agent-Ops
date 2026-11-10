-- Promissory notes: count Supporter capital once (CFO request 10 Nov 2026). DRAFT — not applied.
--
-- ── Problem ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- An activated note is recognised as  DR A7 Partner Product Receivables / CR L2 Partner Portfolios
-- (recognise_partner_receivable). When the Supporter then funds a portfolio, the portfolio credits L2 again, but
-- nothing ever reduces the note: no code posts partner_receivable_collected and notes.total_collected is not
-- updated (system defect being fixed by the developers). The same capital is therefore counted twice in L2 and A7
-- stays up. Only deleting a note removed its A7 (162 notes so far). On 10 Nov 2026 at least 188 notes / 487.1M
-- were affected (the 67 the CFO confirmed as funded: 352.5M; 121 others linked by the system to real fund-ins:
-- 134.6M).
--
-- ── Permanent rule ──────────────────────────────────────────────────────────────────────────────────────────────
-- A note's outstanding amount = amount − settled, where settled is the LARGEST (not the sum — each measures the
-- same money) of:
--   • notes.total_collected                                   (collections, once the developers' fix records them)
--   • commission_fund_ins.amount attributed to the note        (real capital fund-ins the system links to the note)
--   • funder_pending_portfolios.amount approved for the note   (portfolio created from the note)
--   • partner_note_settlements (CFO-confirmed, not revoked)    (manual confirmation where no system link exists)
-- capped at the note amount.
--   1. recognise_partner_receivable recognises only the outstanding amount, so a settled note is never recognised
--      again (it previously topped A7 back up to amount − total_collected on every activation).
--   2. settle_partner_receivable releases whatever A7 the ledger carries above the outstanding amount:
--        DR L2 partner_receivable_capital / CR A7 partner_receivable_created   (the legs derecognition already uses)
--      Release only, never re-recognition. Idempotent per settled amount (key partner_recv_settle:<note>:<target>),
--      serialised per note by an advisory lock.
--   3. Triggers call it whenever a fund-in, pending portfolio, confirmation or the note itself changes. Accounting
--      must never block money: a failure is caught, written to audit_logs (a7_settlement_failed) and left for the
--      sweep settle_partner_receivables().
--   4. fin_balance_sheet compares A7 with the outstanding amount on the same rule.
--
-- Bridge and platform legs only. No wallet leg, no wallet, payment, portfolio, note or Returns change.
-- This migration posts nothing by itself: existing notes are settled only by the approved correction batch
-- (docs/finance/corrections/2026-11-10_partner_note_settlement.sql) or by the sweep.
-- Rollback: supabase/rollbacks/20261111100000_partner_note_settlement.rollback.sql

-- ── 1. CFO-confirmed settlements (register) ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.partner_note_settlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id       uuid NOT NULL,
  portfolio_id  uuid,
  amount        numeric NOT NULL CHECK (amount > 0),
  basis         text NOT NULL CHECK (basis IN ('cfo_confirmed')),
  evidence      text NOT NULL CHECK (length(btrim(evidence)) >= 10),
  confirmed_by  uuid NOT NULL,
  confirmed_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text,
  UNIQUE (note_id, portfolio_id)
);
CREATE INDEX IF NOT EXISTS partner_note_settlements_note_idx ON public.partner_note_settlements (note_id);
ALTER TABLE public.partner_note_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_note_settlements_finance_read ON public.partner_note_settlements;
CREATE POLICY partner_note_settlements_finance_read ON public.partner_note_settlements
  FOR SELECT TO authenticated USING ((SELECT public._fin_can_view()));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.partner_note_settlements;
CREATE POLICY mfa_required_for_staff ON public.partner_note_settlements AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON public.partner_note_settlements FROM anon, authenticated;
GRANT SELECT ON public.partner_note_settlements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_note_settlements TO service_role;

-- ── 2. Settled / outstanding per note (single source of truth) ──────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_partner_note_settlement WITH (security_invoker = true) AS
SELECT n.id AS note_id, n.status, COALESCE(n.amount, 0) AS amount, COALESCE(n.total_collected, 0) AS total_collected,
       COALESCE(fi.amt, 0) AS fund_ins, COALESCE(fp.amt, 0) AS pending_portfolios, COALESCE(cs.amt, 0) AS cfo_confirmed,
       LEAST(COALESCE(n.amount, 0), GREATEST(COALESCE(n.total_collected, 0), COALESCE(fi.amt, 0), COALESCE(fp.amt, 0), COALESCE(cs.amt, 0))) AS settled,
       GREATEST(COALESCE(n.amount, 0) - LEAST(COALESCE(n.amount, 0),
         GREATEST(COALESCE(n.total_collected, 0), COALESCE(fi.amt, 0), COALESCE(fp.amt, 0), COALESCE(cs.amt, 0))), 0) AS outstanding
FROM public.promissory_notes n
LEFT JOIN LATERAL (SELECT sum(f.amount) AS amt FROM public.commission_fund_ins f
                    WHERE f.note_id = n.id AND COALESCE(f.status, '') <> 'reversed') fi ON true
LEFT JOIN LATERAL (SELECT sum(p.amount) AS amt FROM public.funder_pending_portfolios p
                    WHERE p.promissory_note_id = n.id AND p.portfolio_id IS NOT NULL AND p.status = 'approved') fp ON true
LEFT JOIN LATERAL (SELECT sum(s.amount) AS amt FROM public.partner_note_settlements s
                    WHERE s.note_id = n.id AND s.revoked_at IS NULL) cs ON true;
REVOKE ALL ON public.v_partner_note_settlement FROM anon, authenticated;
GRANT SELECT ON public.v_partner_note_settlement TO service_role;

CREATE OR REPLACE FUNCTION public.partner_note_outstanding(p_note_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT outstanding FROM public.v_partner_note_settlement WHERE note_id = p_note_id
$$;
REVOKE ALL ON FUNCTION public.partner_note_outstanding(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_note_outstanding(uuid) TO service_role;

-- ── 3. Recognition: outstanding amount only (production body otherwise unchanged) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.recognise_partner_receivable(p_note_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n record;
  v_amt numeric;
  v_recognised numeric;
  v_gap numeric;
  v_legs jsonb;
  v_ref text;
BEGIN
  SELECT id, agent_id, partner_name, status, amount, total_collected INTO n
    FROM promissory_notes WHERE id = p_note_id;
  IF n.id IS NULL THEN RETURN jsonb_build_object('posted', false, 'reason','note not found'); END IF;
  IF n.status <> 'activated' THEN
    RETURN jsonb_build_object('posted', false, 'reason','not activated'); END IF;

  PERFORM pg_advisory_xact_lock(hashtext('partner_recv:' || n.id::text));
  -- Outstanding = amount less everything that settled the note (collections, attributed fund-ins, approved
  -- portfolios, CFO confirmations), so capital already funded is never recognised a second time.
  v_amt := COALESCE(public.partner_note_outstanding(n.id), 0);
  IF v_amt <= 0 THEN RETURN jsonb_build_object('posted', false, 'reason','nothing outstanding'); END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
    INTO v_recognised
    FROM general_ledger
   WHERE category = 'partner_receivable_created'
     AND ledger_scope = 'bridge'
     AND source_id = n.id;

  v_gap := v_amt - GREATEST(v_recognised, 0);
  IF v_gap <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason','already recognised',
                              'recognised', v_recognised, 'outstanding', v_amt);
  END IF;

  v_ref := 'partner_recv:' || n.id::text ||
           CASE WHEN EXISTS (
                  SELECT 1 FROM general_ledger
                   WHERE category = 'partner_receivable_created' AND source_id = n.id)
                THEN ':re' || to_char(now(), 'YYYYMMDDHH24MISS')
                ELSE '' END;

  v_legs := jsonb_build_array(
    jsonb_build_object('amount', v_gap, 'direction','cash_in',
      'category','partner_receivable_created','ledger_scope','bridge','classification','production',
      'description','Partner receivable recognised for ' || COALESCE(n.partner_name,'partner'),
      'source_table','promissory_notes','source_id', n.id),
    jsonb_build_object('amount', v_gap, 'direction','cash_out',
      'category','partner_receivable_capital','ledger_scope','platform','classification','production',
      'description','Partner capital obligation for ' || COALESCE(n.partner_name,'partner'),
      'source_table','promissory_notes','source_id', n.id));
  PERFORM public.create_ledger_transaction(v_legs, v_ref, false);
  RETURN jsonb_build_object('posted', true, 'amount', v_gap, 'note_id', n.id,
                            'previously_recognised', v_recognised);
END; $function$;

-- ── 4. Release A7 above the outstanding amount ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_partner_receivable(p_note_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n record; s record; v_net numeric := 0; v_first uuid; v_rel numeric; v_key text; v_group uuid; v_legs jsonb;
  v_who text; v_why text;
BEGIN
  IF p_note_id IS NULL THEN RETURN jsonb_build_object('posted', false, 'reason', 'no note'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('partner_recv:' || p_note_id::text));
  SELECT id, partner_name, status INTO n FROM promissory_notes WHERE id = p_note_id;
  IF n.id IS NULL THEN RETURN jsonb_build_object('posted', false, 'reason', 'note not found'); END IF;
  SELECT * INTO s FROM public.v_partner_note_settlement WHERE note_id = p_note_id;

  SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0),
         (array_agg(g.transaction_group_id ORDER BY g.created_at, g.id) FILTER (WHERE g.direction = 'cash_in'))[1]
    INTO v_net, v_first
  FROM general_ledger g
  WHERE g.category = 'partner_receivable_created' AND g.ledger_scope = 'bridge' AND g.source_id = p_note_id;

  v_rel := v_net - s.outstanding;
  IF v_rel <= 0.5 THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'nothing to release', 'net', v_net,
                              'outstanding', s.outstanding, 'settled', s.settled);
  END IF;

  v_key := 'partner_recv_settle:' || p_note_id::text || ':' || round(s.outstanding)::text;
  IF EXISTS (SELECT 1 FROM general_ledger x WHERE x.idempotency_key = v_key) THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'already released for this settled amount', 'key', v_key,
                              'net', v_net, 'outstanding', s.outstanding);
  END IF;

  v_who := COALESCE(NULLIF(btrim(n.partner_name), ''), 'partner');
  v_why := COALESCE(NULLIF(btrim(p_reason), ''),
             CASE WHEN s.cfo_confirmed >= GREATEST(s.total_collected, s.fund_ins, s.pending_portfolios) THEN 'CFO-confirmed funding'
                  WHEN s.fund_ins >= GREATEST(s.total_collected, s.pending_portfolios) THEN 'capital fund-ins attributed to the note'
                  WHEN s.pending_portfolios >= s.total_collected THEN 'portfolio approved from the note'
                  ELSE 'collections recorded on the note' END);
  v_legs := jsonb_build_array(
    jsonb_build_object('amount', v_rel, 'direction', 'cash_out',
      'category', 'partner_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
      'description', 'A7 settlement (accounting only, no money moved): promissory note ' || p_note_id::text || ' of '
        || v_who || ' settled by ' || v_why || ' (settled ' || round(s.settled) || ' of ' || round(s.amount)
        || '); removes the receivable so the Supporter''s capital is counted once, in the portfolio.',
      'source_table', 'promissory_notes', 'source_id', p_note_id, 'reference_id', v_first::text),
    jsonb_build_object('amount', v_rel, 'direction', 'cash_in',
      'category', 'partner_receivable_capital', 'ledger_scope', 'platform', 'classification', 'production',
      'description', 'A7 settlement (accounting only, no money moved): removes the duplicate Supporter capital recognised '
        || 'on promissory note ' || p_note_id::text || ' of ' || v_who || '; the capital is held in the portfolio.',
      'source_table', 'promissory_notes', 'source_id', p_note_id, 'reference_id', v_first::text));
  v_group := public.create_ledger_transaction(v_legs, v_key, false);

  RETURN jsonb_build_object('posted', true, 'amount', v_rel, 'note_id', p_note_id, 'group_id', v_group,
                            'idempotency_key', v_key, 'net_before', v_net, 'outstanding', s.outstanding, 'basis', v_why);
END $function$;
REVOKE ALL ON FUNCTION public.settle_partner_receivable(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_partner_receivable(uuid, text) TO service_role;

-- Sweep: settles every note whose A7 is above its outstanding amount (or the listed notes).
CREATE OR REPLACE FUNCTION public.settle_partner_receivables(p_note_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record; v_res jsonb; v_n int := 0; v_amt numeric := 0; v_checked int := 0;
BEGIN
  FOR r IN
    SELECT v.note_id FROM public.v_partner_note_settlement v
    JOIN (SELECT g.source_id, sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) AS net
            FROM general_ledger g WHERE g.category = 'partner_receivable_created' AND g.ledger_scope = 'bridge'
           GROUP BY 1) a ON a.source_id = v.note_id
    WHERE a.net - v.outstanding > 0.5 AND (p_note_ids IS NULL OR v.note_id = ANY (p_note_ids))
    ORDER BY v.note_id
  LOOP
    v_checked := v_checked + 1;
    v_res := public.settle_partner_receivable(r.note_id);
    IF (v_res->>'posted')::boolean THEN v_n := v_n + 1; v_amt := v_amt + (v_res->>'amount')::numeric; END IF;
  END LOOP;
  RETURN jsonb_build_object('notes_checked', v_checked, 'notes_released', v_n, 'amount_released', v_amt);
END $function$;
REVOKE ALL ON FUNCTION public.settle_partner_receivables(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_partner_receivables(uuid[]) TO service_role;

-- ── 5. Triggers: settle on every event that settles a note; never block the money path ─────────────────────────
CREATE OR REPLACE FUNCTION public.trg_settle_partner_receivable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
-- TG_ARGV[0] = the column of NEW that holds the promissory note id.
DECLARE v_note uuid;
BEGIN
  v_note := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF v_note IS NULL THEN RETURN NULL; END IF;
  BEGIN
    PERFORM public.settle_partner_receivable(v_note);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'a7_settlement_failed', 'partner_receivable_settle', 'promissory_notes', v_note::text, SQLERRM,
            jsonb_build_object('trigger_table', TG_TABLE_NAME, 'sqlstate', SQLSTATE));
  END;
  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS settle_partner_receivable_on_fund_in ON public.commission_fund_ins;
CREATE TRIGGER settle_partner_receivable_on_fund_in
  AFTER INSERT OR UPDATE OF note_id, amount, status ON public.commission_fund_ins
  FOR EACH ROW WHEN (NEW.note_id IS NOT NULL) EXECUTE FUNCTION public.trg_settle_partner_receivable('note_id');

DROP TRIGGER IF EXISTS settle_partner_receivable_on_pending_portfolio ON public.funder_pending_portfolios;
CREATE TRIGGER settle_partner_receivable_on_pending_portfolio
  AFTER INSERT OR UPDATE OF promissory_note_id, portfolio_id, amount, status ON public.funder_pending_portfolios
  FOR EACH ROW WHEN (NEW.promissory_note_id IS NOT NULL) EXECUTE FUNCTION public.trg_settle_partner_receivable('promissory_note_id');

DROP TRIGGER IF EXISTS settle_partner_receivable_on_confirmation ON public.partner_note_settlements;
CREATE TRIGGER settle_partner_receivable_on_confirmation
  AFTER INSERT OR UPDATE ON public.partner_note_settlements
  FOR EACH ROW EXECUTE FUNCTION public.trg_settle_partner_receivable('note_id');

-- After recognise_partner_receivable_on_activation (trigger names fire in alphabetical order).
DROP TRIGGER IF EXISTS zz_settle_partner_receivable_on_note_update ON public.promissory_notes;
CREATE TRIGGER zz_settle_partner_receivable_on_note_update
  AFTER UPDATE OF total_collected, amount, status ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.trg_settle_partner_receivable('id');

REVOKE ALL ON FUNCTION public.trg_settle_partner_receivable() FROM PUBLIC, anon, authenticated;

-- ── 6. Balance Sheet: A7 compared with the outstanding amount on the same rule ──────────────────────────────────
-- fin_balance_sheet as in 20261111090000, with only the promissory-note tie, memo line and disclosure changed.
CREATE OR REPLACE FUNCTION public.fin_balance_sheet(p_as_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $function$
DECLARE
  v_sofp jsonb;
  v_val  jsonb;
  v_ties jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view the balance sheet';
  END IF;

  v_sofp := public.get_statement_of_financial_position(COALESCE(p_as_at, now()));

  -- account values by code, from the statement just produced
  SELECT jsonb_object_agg(substring(e->>'source' from 'account ([A-Z0-9]+)$'), (e->>'value')::numeric)
    INTO v_val
  FROM (
    SELECT jsonb_array_elements(COALESCE(v_sofp->'assets'->'current','[]'::jsonb) || COALESCE(v_sofp->'assets'->'non_current','[]'::jsonb)
                              || COALESCE(v_sofp->'liabilities'->'current','[]'::jsonb) || COALESCE(v_sofp->'liabilities'->'non_current','[]'::jsonb)) e
  ) z
  WHERE substring(e->>'source' from 'account ([A-Z0-9]+)$') IS NOT NULL;

  WITH w AS (
    SELECT COALESCE(SUM(withdrawable_balance),0) wd, COALESCE(SUM(locked_balance),0) lk,
           COALESCE(SUM(float_balance),0) fl, COALESCE(SUM(advance_balance),0) adv FROM public.wallets
  ), t AS (
    SELECT
      (SELECT COALESCE(SUM(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0)),0) FROM public.rent_requests
        WHERE status IN ('funded','disbursed','repaying') AND created_at <= COALESCE(p_as_at, now())) AS rent_book,
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0) + COALESCE(arrears_balance,0)),0) FROM public.agent_advances
        WHERE status IN ('active','overdue') AND created_at <= COALESCE(p_as_at, now())) AS advances,
      (SELECT COALESCE(SUM(investment_amount),0) FROM public.investor_portfolios
        WHERE status = 'active' AND created_at <= COALESCE(p_as_at, now())) AS portfolios,
      (SELECT COALESCE(SUM(v.outstanding),0) FROM public.v_partner_note_settlement v JOIN public.promissory_notes n ON n.id = v.note_id
        WHERE n.status = 'activated' AND n.created_at <= COALESCE(p_as_at, now())) AS notes
  )
  SELECT jsonb_build_array(
    jsonb_build_object('key','rent_plans','label','Rent Plan receivables (A3) vs Rent Plan book',
      'ledger', ROUND(COALESCE((v_val->>'A3')::numeric,0)), 'operational', ROUND(t.rent_book),
      'difference', ROUND(COALESCE((v_val->>'A3')::numeric,0) - t.rent_book)),
    jsonb_build_object('key','agent_advances','label','Agent advances (A10+A11+A20) vs agent_advances outstanding + arrears',
      'ledger', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0)),
      'operational', ROUND(t.advances),
      'difference', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0) - t.advances)),
    jsonb_build_object('key','supporter_capital','label','Supporter capital (L2 less unpaid promissory notes A7) vs active portfolios',
      'ledger', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.portfolios),
      'difference', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0) - t.portfolios)),
    jsonb_build_object('key','promissory_notes','label','Promissory notes (A7) vs activated notes not yet settled',
      'ledger', ROUND(COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.notes),
      'difference', ROUND(COALESCE((v_val->>'A7')::numeric,0) - t.notes)),
    jsonb_build_object('key','wallet_custody','label','Wallet custody (L1) vs wallets withdrawable + locked',
      'ledger', ROUND(COALESCE((v_val->>'L1')::numeric,0)), 'operational', ROUND(w.wd + w.lk),
      'difference', ROUND(COALESCE((v_val->>'L1')::numeric,0) - (w.wd + w.lk))),
    jsonb_build_object('key','agent_float','label','Agent float (A2) vs wallets float',
      'ledger', ROUND(COALESCE((v_val->>'A2')::numeric,0)), 'operational', ROUND(w.fl),
      'difference', ROUND(COALESCE((v_val->>'A2')::numeric,0) - w.fl))
  ) INTO v_ties
  FROM w, t;

  -- Comparison lines corrected (CFO, 10 Nov 2026): merchandise counts issued orders only (receivable recognised
  -- when an order is issued, policy of 4 Nov 2026); promissory notes split into activated and not yet activated.
  WITH memo AS (
    SELECT e FROM jsonb_array_elements(COALESCE(v_sofp->'reconciliation'->'memo_sub_ledgers', '[]'::jsonb)) e
    WHERE e->>'label' NOT IN ('Merchandise sales outstanding', 'Promissory notes uncollected')
  ), extra AS (
    SELECT jsonb_build_array(
      jsonb_build_object('label', 'Merchandise sales outstanding — issued orders only',
        'value', (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0) FROM public.merchandise_sales
                  WHERE order_status IN ('issued','completed') AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — orders marked issued or completed (receivable recognised on issue)'),
      jsonb_build_object('label', 'Merchandise orders not yet issued (not a receivable)',
        'value', (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0) FROM public.merchandise_sales
                  WHERE COALESCE(order_status,'') NOT IN ('issued','completed','rejected','failed','cancelled')
                    AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — pending, approved or awaiting handover; information only'),
      jsonb_build_object('label', 'Promissory notes activated, not yet settled',
        'value', (SELECT COALESCE(SUM(v.outstanding),0) FROM public.v_partner_note_settlement v JOIN public.promissory_notes n ON n.id = v.note_id
                  WHERE n.status = 'activated' AND n.created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — note amount less collections, fund-ins attributed to the note and CFO-confirmed funding; compare against ledger account A7'),
      jsonb_build_object('label', 'Promissory notes not yet activated (commitments only)',
        'value', (SELECT COALESCE(SUM(COALESCE(amount,0) - COALESCE(total_collected,0)),0) FROM public.promissory_notes
                  WHERE status = 'pending' AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — not recognised in the ledger')
    ) j
  )
  SELECT jsonb_set(v_sofp, '{reconciliation,memo_sub_ledgers}',
                   COALESCE((SELECT jsonb_agg(e) FROM memo), '[]'::jsonb) || (SELECT j FROM extra))
    INTO v_sofp
  WHERE v_sofp ? 'reconciliation';

  RETURN v_sofp || jsonb_build_object(
    'engine', 'fin_balance_sheet',
    'subledger_ties', v_ties,
    'subledger_ties_basis', 'Ledger balances are as at the statement date; operational figures (wallets, Rent Plan balances, advances, portfolios, notes) are as they stand now, so ties for past dates are indicative only.',
    'disclosures', jsonb_build_array(
      'Partner Product Receivables (A7) are activated promissory notes not yet settled by Supporter capital; the same amount is included in Supporter capital (L2). A note settled by a funded portfolio is released, so the capital is counted once.',
      'Landlord Float Pool (A21/A22) is company cash earmarked to fund Rent Plans (Supporter capital and compounded Returns), not money owed to landlords.',
      'Cash and Bank (A1) is negative mainly because verified cash deposits remain in Cash in Transit (A5); the two should be read together.',
      'Landlord Rent Payable (L4) holds no landlord obligations; its balance comes from resolver counterpart legs.')
  );
END;
$function$;
