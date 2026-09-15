-- Self-healing merchant float crediting.
--
-- Root cause confirmed live (2026-09-15): when a merchant desk's
-- registration (is_active / float_phone) lags behind an outbound company
-- float send by even a short window, the ONE-SHOT match in
-- gmail-poll-transactions's tryAutoDebitPayout fails and is never retried —
-- the money sits on the agent's phone with nothing recorded against their
-- desk, permanently, unless a human notices and manually reconciles it.
-- Two real desks hit this in the last two weeks (Nankambo Sharimah,
-- Bayo Mercy's "Entebbe" desk) totalling ~UGX 27M in sends that never
-- credited.
--
-- Explicit decision (Josh, 2026-09-15): do NOT retroactively credit the
-- existing backlog on those two desks — both carry unevidenced balance
-- corrections written by insiders (see merchant_float_reconciliations,
-- e.g. Bayo Mercy authoring "Balance correction" rows with no evidence on
-- Sharimah's desk) and need manual finance review, not an automated
-- credit. This migration is deliberately built so it can NEVER reach back
-- into that backlog for any desk in this state:
--   1. It only looks at a short (24h) trailing window from whenever it
--      fires — it starts working "the next time that desk receives float",
--      never retroactively. Nothing older is ever touched.
--   2. It refuses outright (does nothing) for any desk that has ANY
--      unevidenced merchant_float_reconciliations row against it — the
--      generic signal for "this desk's numbers are already disputed,
--      needs a human, not automation." That covers both flagged desks
--      today without hardcoding their ids, and will keep covering any
--      other desk that ends up in the same state later.
--
-- Mechanism: a trigger on cashout_agents fires the instant a desk becomes
-- active or its float_phone is set/changed, and immediately re-attempts
-- the match for that one phone number over the last 24h of outbound
-- MTN/Airtel sends — closing the exact registration-lag race that caused
-- this, with no new screen, no manual sweep, no alert nobody reads. It
-- calls the same idempotent record_merchant_float_delivery() every other
-- credit path already uses, so it can never double-credit.

CREATE OR REPLACE FUNCTION public.catch_up_merchant_float_delivery(p_agent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_desk public.cashout_agents%ROWTYPE;
  v_phone9 text;
  v_has_dispute boolean;
  v_row record;
  v_credited int := 0;
  v_skipped int := 0;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_desk FROM public.cashout_agents
  WHERE agent_id = p_agent_id AND is_active = true
  ORDER BY created_at, id LIMIT 1;
  IF v_desk.id IS NULL OR COALESCE(v_desk.float_phone, '') = '' THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'no_active_desk_or_no_float_phone');
  END IF;

  v_phone9 := right(regexp_replace(v_desk.float_phone, '\D', '', 'g'), 9);
  IF length(v_phone9) < 9 THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'float_phone_too_short');
  END IF;

  -- Dispute guard: never auto-credit a desk with an unevidenced correction
  -- against it. This is a generic, self-updating condition — it is what
  -- currently excludes both flagged desks, and will exclude any future
  -- desk in the same state without needing a hardcoded list.
  SELECT EXISTS (
    SELECT 1 FROM public.merchant_float_reconciliations r
    WHERE r.agent_id = p_agent_id AND COALESCE(r.evidence_note, '') = ''
  ) INTO v_has_dispute;
  IF v_has_dispute THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'desk_has_unevidenced_reconciliation_dispute');
  END IF;

  -- Short, trailing-only window: this is a catch-up for a registration
  -- race that just happened, never a historical backfill. Anything older
  -- than this is left exactly where it is for a human to decide.
  FOR v_row IN
    SELECT g.id, g.transaction_id, g.amount, g.channel, g.internal_date
    FROM public.gmail_transactions g
    WHERE g.direction = 'out'
      AND g.channel IN ('mtn_momo', 'airtel_money')
      AND g.parsed = true
      AND g.amount IS NOT NULL AND g.amount > 0
      AND g.transaction_id IS NOT NULL
      AND g.linked_deposit_request_id IS NULL
      AND g.internal_date >= now() - interval '24 hours'
      AND right(regexp_replace(COALESCE(g.counterparty, ''), '\D', '', 'g'), 9) = v_phone9
      AND NOT EXISTS (
        SELECT 1 FROM public.merchant_float_deliveries d
        WHERE d.tid_normalized = upper(regexp_replace(g.transaction_id, '[^A-Za-z0-9]', '', 'g'))
      )
    ORDER BY g.internal_date
    LIMIT 20
  LOOP
    BEGIN
      v_result := public.record_merchant_float_delivery(
        v_row.transaction_id, p_agent_id, v_row.amount,
        CASE WHEN v_row.channel = 'mtn_momo' THEN 'mtn' ELSE 'airtel' END,
        v_row.id, v_row.internal_date
      );
      IF (v_result->>'reason') = 'credited' THEN v_credited := v_credited + 1; ELSE v_skipped := v_skipped + 1; END IF;
      v_results := v_results || jsonb_build_object('gmail_id', v_row.id, 'tid', v_row.transaction_id, 'result', v_result);
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
      v_results := v_results || jsonb_build_object('gmail_id', v_row.id, 'tid', v_row.transaction_id, 'error', SQLERRM);
    END;
  END LOOP;

  IF v_credited > 0 OR v_skipped > 0 THEN
    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (
        NULL, 'merchant_float_selfheal_catchup', 'cashout_agents', v_desk.id,
        format('Desk activation/registration change triggered a 24h catch-up scan: %s credited, %s skipped.', v_credited, v_skipped),
        jsonb_build_object('agent_id', p_agent_id, 'float_phone', v_desk.float_phone, 'results', v_results)
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object('ran', true, 'credited', v_credited, 'skipped', v_skipped);
END;
$function$;

REVOKE ALL ON FUNCTION public.catch_up_merchant_float_delivery(uuid) FROM PUBLIC, anon, authenticated;

-- ── Trigger: fire only on the transition that matters ──────────────────
CREATE OR REPLACE FUNCTION public.trg_cashout_agent_float_catchup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_active = true AND COALESCE(NEW.float_phone, '') <> '' AND (
       TG_OP = 'INSERT'
       OR OLD.is_active IS DISTINCT FROM NEW.is_active
       OR OLD.float_phone IS DISTINCT FROM NEW.float_phone
     ) THEN
    PERFORM public.catch_up_merchant_float_delivery(NEW.agent_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS cashout_agent_float_catchup ON public.cashout_agents;
CREATE TRIGGER cashout_agent_float_catchup
  AFTER INSERT OR UPDATE OF is_active, float_phone ON public.cashout_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_cashout_agent_float_catchup();
