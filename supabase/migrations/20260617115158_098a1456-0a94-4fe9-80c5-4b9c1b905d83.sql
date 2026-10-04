-- Backfill proxy_payout_settlements for already-delivered proxy partner
-- withdrawals that never wrote a settlement row.
--
-- Root cause: settlements are the SOLE source of truth for "this ROI approval
-- is closed", but the approve-withdrawal settlement step only wrote rows when
-- it could resolve a partner from proxy_partner_id / linked_party. Custody-V2
-- partner-owned rows (user_id = partner) and auto-routed partner withdrawals
-- resolved to null, so paid approvals stayed "open" forever -> paid partners
-- kept reappearing in the agent's Proxy Partners list and their card totals
-- ballooned every ROI cycle as new approvals stacked on top of unretired ones.
--
-- This backfill FIFO-closes each delivered proxy withdrawal against the
-- partner's CFO-approved unsettled ROI approvals (newest-first, matching the
-- UI/edge-fn order). Idempotent: skips withdrawals that already have a
-- settlement, skips approvals already settled, and ON CONFLICT guards the
-- UNIQUE approval_id.
DO $$
DECLARE
  w RECORD;
  op RECORD;
  remaining numeric;
  partner uuid;
  inserted_count int := 0;
BEGIN
  FOR w IN
    SELECT wr.id, wr.amount, wr.user_id, wr.proxy_partner_id, wr.linked_party,
           wr.agent_id, wr.initiated_by, wr.created_at, wr.updated_at
    FROM public.withdrawal_requests wr
    WHERE wr.status IN ('completed','approved','fin_ops_approved')
      AND wr.amount > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.proxy_payout_settlements s WHERE s.withdrawal_id = wr.id
      )
    ORDER BY wr.updated_at ASC NULLS LAST, wr.created_at ASC
  LOOP
    -- Resolve the proxy partner this delivered withdrawal paid.
    partner := COALESCE(
      w.proxy_partner_id,
      CASE WHEN w.linked_party IS NOT NULL AND w.linked_party <> w.user_id
           THEN w.linked_party END,
      -- Custody-V2 partner-owned row: user_id IS the partner. Only treat as a
      -- proxy withdrawal when an agent (not the partner) initiated it AND the
      -- user is an active proxy beneficiary -- this excludes a partner's own
      -- personal withdrawals.
      CASE WHEN w.initiated_by IS NOT NULL AND w.initiated_by <> w.user_id
            AND EXISTS (
              SELECT 1 FROM public.proxy_agent_assignments pa
              WHERE pa.beneficiary_id = w.user_id
                AND pa.is_active AND pa.approval_status = 'approved'
            )
           THEN w.user_id END
    );

    IF partner IS NULL THEN
      CONTINUE;
    END IF;

    remaining := w.amount;

    FOR op IN
      SELECT pwo.id, pwo.amount, pwo.target_wallet_user_id
      FROM public.pending_wallet_operations pwo
      JOIN public.investor_portfolios ip ON ip.id = pwo.source_id
      WHERE ip.investor_id = partner
        AND pwo.category = 'roi_payout'
        AND pwo.status = 'approved'
        AND pwo.metadata->>'coo_approved_by' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.proxy_payout_settlements s WHERE s.approval_id = pwo.id
        )
      ORDER BY pwo.created_at DESC
    LOOP
      EXIT WHEN remaining <= 0;
      INSERT INTO public.proxy_payout_settlements
        (approval_id, withdrawal_id, partner_id, agent_id, amount_settled, notes)
      VALUES (
        op.id, w.id, partner,
        COALESCE(op.target_wallet_user_id, w.agent_id, w.initiated_by, w.user_id),
        LEAST(op.amount, remaining),
        'Backfill: retroactive FIFO settlement for delivered proxy withdrawal'
      )
      ON CONFLICT (approval_id) DO NOTHING;
      remaining := remaining - op.amount;
      inserted_count := inserted_count + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Proxy settlement backfill complete: % settlement row(s) inserted', inserted_count;
END $$;