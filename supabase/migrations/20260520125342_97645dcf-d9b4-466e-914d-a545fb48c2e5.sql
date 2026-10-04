DO $$
DECLARE
  v_user uuid := '75891dff-d684-49e9-83ea-fab6e4cb4ded';
  v_deposit uuid := 'd5b8640e-b544-4e0a-8e65-2340d3cabc18';
  v_group uuid;
BEGIN
  -- Post balanced admin_correction reversal of the phantom 300k deposit
  v_group := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_user,
        'category', 'system_balance_correction',
        'direction', 'cash_out',
        'amount', 300000,
        'ledger_scope', 'wallet',
        'wallet_bucket', 'withdrawable',
        'recipient_type', 'user',
        'classification', 'admin_correction',
        'description', '[admin_correction 2026-05-20 phantom-deposit reversal] Reverse duplicate auto-created deposit TID 147716494975 (deposit_request d5b8640e). IFTTT/SMS-forwarder ingested agent''s own outbound MoMo payout (withdrawal 12cf6074) as an incoming deposit. Funds were already disbursed via FinOps; the wallet credit was a phantom.',
        'reference_id', '147716494975',
        'source_table', 'deposit_requests',
        'source_id', v_deposit::text
      ),
      jsonb_build_object(
        'category', 'system_balance_correction',
        'direction', 'cash_in',
        'amount', 300000,
        'ledger_scope', 'platform',
        'classification', 'admin_correction',
        'description', '[admin_correction 2026-05-20 phantom-deposit reversal] Counter-leg: platform recovers liability erroneously booked against user wallet (TID 147716494975).',
        'reference_id', '147716494975',
        'source_table', 'deposit_requests',
        'source_id', v_deposit::text
      )
    ),
    idempotency_key := 'phantom-deposit-reversal-147716494975',
    skip_balance_check := true
  );

  -- Mark the auto-created deposit as rejected so it stops counting as a real deposit
  UPDATE public.deposit_requests
  SET status = 'rejected',
      rejected_at = now(),
      rejection_reason = 'Phantom deposit: auto-created from IFTTT SMS-forwarder echo of agent''s own outbound MoMo payout (withdrawal 12cf6074-58cd-46d0-bc69-2b4bdcb52117). Reversed via admin_correction ledger group ' || v_group::text,
      updated_at = now()
  WHERE id = v_deposit
    AND status = 'approved';
END $$;