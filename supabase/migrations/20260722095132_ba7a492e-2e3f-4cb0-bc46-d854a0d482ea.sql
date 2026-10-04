
SELECT public.create_ledger_transaction(
  entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', 'ebf0897b-dfdf-4403-ad5c-1c988c72e67c',
      'scope', 'wallet',
      'category', 'system_balance_correction',
      'direction', 'cash_out',
      'amount', 192000,
      'recipient_type', 'user',
      'classification', 'admin_correction',
      'solvency_bypass_reason', 'duplicate_reversal',
      'description', 'Reversal of over-refund on parent-agent listing rejection (KANUNA KEITH). Correct refund is 5 x 6,000 = 30,000; earlier fix returned 222,000. Clawing back 192,000.'
    ),
    jsonb_build_object(
      'scope', 'platform',
      'category', 'system_balance_correction',
      'direction', 'cash_in',
      'amount', 192000,
      'classification', 'admin_correction',
      'description', 'Reversal of over-refund on parent-agent listing rejection (KANUNA KEITH).'
    )
  ),
  idempotency_key := 'watsala-parent-rejection-overrefund-clawback-192k',
  skip_balance_check := true
);
