-- Anchor strict-ledger to just after the morning reconciliation writedown
-- so the CFO's post-writedown transport credits actually count.
INSERT INTO public.wallet_fresh_start_anchors (
  user_id, anchor_at, pre_anchor_ledger_net, reason, notes
) VALUES (
  '16d52ad2-92e0-4348-af46-17612afa4d49',
  '2026-05-05 09:53:00+00',
  0,
  'post_reconciliation_anchor',
  'Anchored after 2026-05-05 reconciliation writedowns so CFO transport credits surface as withdrawable.'
)
ON CONFLICT (user_id) DO UPDATE
  SET anchor_at = EXCLUDED.anchor_at,
      reason    = EXCLUDED.reason,
      notes     = EXCLUDED.notes;