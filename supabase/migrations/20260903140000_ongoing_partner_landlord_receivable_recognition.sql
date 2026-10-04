-- Ongoing recognition for Partner (A7) and Landlord (A6) receivables.
--
-- ── Why ─────────────────────────────────────────────────────────────────────
--
-- 20260903100100 recognised the historical balances once. Nothing posted for
-- receivables created afterwards, so A7 immediately began drifting from its
-- sub-ledger: 12 promissory notes raised on 2026-09-03 after that backfill,
-- totalling exactly UGX 4,000,000, had no ledger entry.
--
-- A6 was verified exactly equal to its sub-ledger (31,395,000) with zero
-- unrecognised subscriptions, so the landlord side needs no catch-up - only the
-- same ongoing mechanism, because a newly created subscription would otherwise
-- drift the same way.
--
-- ── Recognition event ───────────────────────────────────────────────────────
--
-- Partner:  a promissory_notes row is CREATED with status in (pending,
--           activated) and amount > total_collected. Per the approved treatment
--           pending notes are receivables, so recognition is at creation, not
--           at approval - 7 of the 12 catch-up notes have approved_at NULL.
--
-- Landlord: a welile_homes_subscriptions row is CREATED with
--           outstanding_balance > 0.
--
-- Recognition is deliberately NOT fired on every UPDATE. A row changing is not
-- by itself a recognition event, and re-posting on amendment would double count.
--
-- ── Double entry ────────────────────────────────────────────────────────────
--
--   Partner   DR A7 Partner Product Receivables   bridge.partner_receivable_created
--             CR L2 Partner Portfolios            platform.partner_receivable_capital
--
--   Landlord  DR A6 Landlord Product Receivables  bridge.landlord_receivable_created
--             CR L4 Landlord Rent Payable         platform.landlord_receivable_obligation
--
-- Both are the same entries the backfill used. Collections already credit the
-- receivable via partner_receivable_collected / landlord_receivable_collected,
-- and a reversal is the mirror of the recognition using the same categories
-- with the opposite direction.
--
-- ── Controls ────────────────────────────────────────────────────────────────
--
-- Writes go through create_ledger_transaction, so trg_enforce_ledger_rpc_only,
-- the strict-mode category allowlist and trg_enforce_ledger_group_balance all
-- still apply. skip_balance_check is false: each entry is one cash_in and one
-- cash_out leg of equal size and must prove it balances.
--
-- Idempotency is by stable source reference, not by amount: a row is skipped if
-- a *_receivable_created leg already exists for its id. The idempotency_key
-- passed to create_ledger_transaction is derived from the same id, so a retried
-- operational event cannot post twice.
--
-- Nothing here touches revenue, cash, equity, suspense, the scoped
-- merchant_float_reconciliations correction, or any unrelated account.

-- ── Partner recognition ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recognise_partner_receivable(p_note_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n record;
  v_amt numeric;
  v_legs jsonb;
BEGIN
  SELECT id, agent_id, partner_name, status, amount, total_collected, created_at
    INTO n
    FROM promissory_notes WHERE id = p_note_id;

  IF n.id IS NULL THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'note not found');
  END IF;
  IF n.status NOT IN ('pending','activated') THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'status not recognisable');
  END IF;

  v_amt := GREATEST(COALESCE(n.amount,0) - COALESCE(n.total_collected,0), 0);
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'nothing outstanding');
  END IF;

  -- Idempotent on the note id, so a retried event cannot post twice.
  IF EXISTS (SELECT 1 FROM general_ledger
              WHERE category = 'partner_receivable_created' AND source_id = n.id) THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'already recognised');
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object(
      'amount', v_amt, 'direction', 'cash_in',
      'category', 'partner_receivable_created', 'ledger_scope', 'bridge',
      'classification', 'production',
      'description', 'Partner receivable recognised for ' || COALESCE(n.partner_name,'partner'),
      'source_table', 'promissory_notes', 'source_id', n.id),
    jsonb_build_object(
      'amount', v_amt, 'direction', 'cash_out',
      'category', 'partner_receivable_capital', 'ledger_scope', 'platform',
      'classification', 'production',
      'description', 'Partner capital obligation for ' || COALESCE(n.partner_name,'partner'),
      'source_table', 'promissory_notes', 'source_id', n.id)
  );

  PERFORM public.create_ledger_transaction(
    v_legs, 'partner_recv:' || n.id::text, false);

  RETURN jsonb_build_object('posted', true, 'amount', v_amt, 'note_id', n.id);
END;
$function$;

-- ── Landlord recognition ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recognise_landlord_receivable(p_subscription_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s record;
  v_amt numeric;
  v_legs jsonb;
BEGIN
  SELECT id, landlord_id, landlord_name, subscription_status, outstanding_balance
    INTO s
    FROM welile_homes_subscriptions WHERE id = p_subscription_id;

  IF s.id IS NULL THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'subscription not found');
  END IF;
  IF s.subscription_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'not active');
  END IF;

  v_amt := GREATEST(COALESCE(s.outstanding_balance,0), 0);
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'nothing outstanding');
  END IF;

  IF EXISTS (SELECT 1 FROM general_ledger
              WHERE category = 'landlord_receivable_created' AND source_id = s.id) THEN
    RETURN jsonb_build_object('posted', false, 'reason', 'already recognised');
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object(
      'amount', v_amt, 'direction', 'cash_in',
      'category', 'landlord_receivable_created', 'ledger_scope', 'bridge',
      'classification', 'production',
      'description', 'Landlord receivable recognised for ' || COALESCE(s.landlord_name,'landlord'),
      'source_table', 'welile_homes_subscriptions', 'source_id', s.id),
    jsonb_build_object(
      'amount', v_amt, 'direction', 'cash_out',
      'category', 'landlord_receivable_obligation', 'ledger_scope', 'platform',
      'classification', 'production',
      'description', 'Landlord payout obligation for ' || COALESCE(s.landlord_name,'landlord'),
      'source_table', 'welile_homes_subscriptions', 'source_id', s.id)
  );

  PERFORM public.create_ledger_transaction(
    v_legs, 'landlord_recv:' || s.id::text, false);

  RETURN jsonb_build_object('posted', true, 'amount', v_amt, 'subscription_id', s.id);
END;
$function$;

REVOKE ALL ON FUNCTION public.recognise_partner_receivable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recognise_landlord_receivable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recognise_partner_receivable(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recognise_landlord_receivable(uuid) TO service_role;

-- ── Triggers: recognise at creation ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_recognise_partner_receivable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.recognise_partner_receivable(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_recognise_landlord_receivable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.recognise_landlord_receivable(NEW.id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS recognise_partner_receivable_on_insert ON public.promissory_notes;
CREATE TRIGGER recognise_partner_receivable_on_insert
  AFTER INSERT ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.trg_recognise_partner_receivable();

DROP TRIGGER IF EXISTS recognise_landlord_receivable_on_insert ON public.welile_homes_subscriptions;
CREATE TRIGGER recognise_landlord_receivable_on_insert
  AFTER INSERT ON public.welile_homes_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.trg_recognise_landlord_receivable();

-- ── One-time idempotent catch-up ────────────────────────────────────────────
--
-- Only records created after the original backfill and still unrecognised. The
-- NOT EXISTS guard inside each function makes a re-run a no-op.
DO $do$
DECLARE r record; v_n int := 0; v_total numeric := 0; v_res jsonb;
BEGIN
  FOR r IN
    SELECT id FROM promissory_notes
     WHERE status IN ('pending','activated')
       AND GREATEST(COALESCE(amount,0)-COALESCE(total_collected,0),0) > 0
       AND NOT EXISTS (SELECT 1 FROM general_ledger gl
                        WHERE gl.category='partner_receivable_created' AND gl.source_id = id)
     ORDER BY created_at
  LOOP
    v_res := public.recognise_partner_receivable(r.id);
    IF (v_res->>'posted')::boolean THEN
      v_n := v_n + 1; v_total := v_total + (v_res->>'amount')::numeric;
    END IF;
  END LOOP;
  RAISE NOTICE 'partner catch-up: % notes, UGX %', v_n, v_total;

  v_n := 0; v_total := 0;
  FOR r IN
    SELECT id FROM welile_homes_subscriptions
     WHERE subscription_status='active' AND COALESCE(outstanding_balance,0) > 0
       AND NOT EXISTS (SELECT 1 FROM general_ledger gl
                        WHERE gl.category='landlord_receivable_created' AND gl.source_id = id)
     ORDER BY created_at
  LOOP
    v_res := public.recognise_landlord_receivable(r.id);
    IF (v_res->>'posted')::boolean THEN
      v_n := v_n + 1; v_total := v_total + (v_res->>'amount')::numeric;
    END IF;
  END LOOP;
  RAISE NOTICE 'landlord catch-up: % subscriptions, UGX %', v_n, v_total;
END
$do$;

-- ── Verification ────────────────────────────────────────────────────────────
--
--   SELECT 'A7' acct,
--          ROUND(SUM(CASE WHEN category='partner_receivable_created' THEN amount ELSE -amount END)) ledger,
--          ROUND((SELECT COALESCE(SUM(GREATEST(COALESCE(amount,0)-COALESCE(total_collected,0),0)),0)
--                   FROM promissory_notes WHERE status IN ('pending','activated'))) sub_ledger
--     FROM general_ledger
--    WHERE category IN ('partner_receivable_created','partner_receivable_collected');
--   -- expect ledger = sub_ledger
--
--   SELECT category, source_id, COUNT(*)
--     FROM general_ledger
--    WHERE category IN ('partner_receivable_created','landlord_receivable_created')
--    GROUP BY 1,2 HAVING COUNT(*) > 1;
--   -- expect zero rows (no duplicate recognition)
