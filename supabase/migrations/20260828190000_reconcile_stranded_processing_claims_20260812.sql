-- Manual reconciliation, run once: 44 withdrawal_requests stuck in
-- status='processing' with ZERO general_ledger legs, all created in a single
-- ~8.5 hour window on 2026-08-12 (05:55-14:23 UTC) across 4 merchant desks
-- (NABBALE CLAIRE, Mudumba samuel, Hilary Evanz, Tugabirwe Apophia). Nothing
-- like this before or since -- a one-time incident, not an ongoing pattern.
--
-- Two mechanisms found responsible: release_stale_cashout_claims() only
-- rescues claims stuck BEFORE processing starts (processing_started_at IS
-- NULL); nothing releases a claim that stalled AFTER entering 'processing'.
-- reconcile_evidenced_withdrawal_settlements() re-touches these every 10 min
-- (bumping updated_at, which is why they look "alive") but can never finalize
-- them because its finalize path requires transaction_id IS NOT NULL, which
-- these never got.
--
-- Operator (2026-08-28) confirmed these 44 were actually paid out in the
-- field on 2026-08-12 -- the settlement-recording step is what failed, not
-- the payout itself. Per operator instruction: mark completed, do not
-- release back to the payout queue (would risk a duplicate payout to the
-- same customer), do not delete (would destroy the only record of a real
-- transaction and any customer/audit trail).
--
-- What this does NOT do: it does not post the customer wallet-discharge
-- leg. Checked first: only 3 of the 44 customers (UGX 121,445 total)
-- currently hold enough balance for a same-day discharge without going
-- negative -- the other 41 have already drawn their balance down some other
-- way in the 16 days since, so a forced discharge today would either push
-- them negative (rejected by the wallet solvency constraint) or require
-- backdating to 2026-08-12, which would ripple through 16 days of that
-- customer's subsequent activity. Left as a known, visible gap
-- (settlement_state stays 'unsettled' -- see mark_withdrawal_settlement_dirty
-- trigger) rather than forced/hidden.
--
-- What DOES happen automatically: trg_merchant_payout_float_guard fires on
-- this status change and calls ensure_merchant_payout_float_debit() for each
-- row, which debits the agent's CURRENT available float (or classifies it as
-- their own cash via classify_merchant_payout_funding if none is available)
-- -- an existing, already-tested self-healing mechanism, not something new
-- introduced here.

WITH targets AS (
  SELECT wr.id
  FROM withdrawal_requests wr
  WHERE wr.status = 'processing'
    AND coalesce(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by) IN (SELECT agent_id FROM cashout_agents)
    AND NOT EXISTS (SELECT 1 FROM general_ledger g WHERE g.source_id = wr.id)
    AND wr.created_at < now() - interval '45 minutes'
    AND wr.created_at > now() - interval '20 days'
),
upd AS (
  UPDATE withdrawal_requests wr
  SET status = 'completed',
      -- fin_ops_reference has a uniqueness constraint; suffix with the row's
      -- own id so all 44 stay traceable as one batch without colliding.
      fin_ops_reference = 'MANUAL-RECON-20260828-' || wr.id::text,
      processed_at = now(),
      updated_at = now()
  FROM targets t
  WHERE wr.id = t.id
  RETURNING wr.id, wr.user_id, wr.amount
)
INSERT INTO system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
SELECT
  'withdrawal.manual_reconciliation_completed',
  upd.user_id,
  'withdrawal_requests',
  upd.id,
  jsonb_build_object(
    'amount', upd.amount,
    'reconciled_at', now(),
    'note', 'Confirmed paid out in the field on 2026-08-12 per operator confirmation; the settlement-recording step never posted (zero general_ledger legs existed for this withdrawal at the time of this reconciliation, part of a same-day gap affecting 4 merchant desks: NABBALE CLAIRE, Mudumba samuel, Hilary Evanz, Tugabirwe Apophia). Marked completed 2026-08-28 on operator confirmation. No customer wallet-discharge leg was posted retroactively -- that gap is intentionally left visible rather than force-corrected, since 3 of the 44 affected customers currently hold enough balance that a same-day correction would have created a live double-withdraw window; the other 41 could not be corrected today without risking a negative balance. See investigation thread dated 2026-08-28 for full detail.'
  )
FROM upd
RETURNING id;
