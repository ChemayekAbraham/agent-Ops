SELECT public.create_ledger_transaction(
  '[
    {"user_id":"16d52ad2-92e0-4348-af46-17612afa4d49","amount":100000,"direction":"cash_in","category":"wallet_transfer","ledger_scope":"wallet","source_table":"manual_reconciliation","reference_id":"FIX-KAT-779007902-002","description":"Reclassify CFO transport credits so strict withdrawable recognises them (no net wallet impact)","currency":"UGX"},
    {"user_id":"16d52ad2-92e0-4348-af46-17612afa4d49","amount":100000,"direction":"cash_out","category":"system_balance_correction","ledger_scope":"wallet","source_table":"manual_reconciliation","reference_id":"FIX-KAT-779007902-002","description":"Offset for reclassification (no net wallet impact)","currency":"UGX"},
    {"user_id":"6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4","amount":100000,"direction":"cash_out","category":"system_balance_correction","ledger_scope":"platform","source_table":"manual_reconciliation","reference_id":"FIX-KAT-779007902-002","description":"Reclassification platform leg","currency":"UGX"},
    {"user_id":"6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4","amount":100000,"direction":"cash_in","category":"system_balance_correction","ledger_scope":"platform","source_table":"manual_reconciliation","reference_id":"FIX-KAT-779007902-002","description":"Reclassification platform offset","currency":"UGX"}
  ]'::jsonb,
  'fix-kat-779007902-002',
  true
);