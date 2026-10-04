
DELETE FROM public.repayments
WHERE id IN (
  '770bdbea-8330-475a-a0ba-7eed57315103',
  '8df3681a-e979-4f09-9b47-fc4a6ca3f4e8',
  'a2e9cfe8-7209-47f1-ae78-f8d3dce4b9b6',
  'fcdbfd89-bd94-41bf-8536-2541935cf1b9'
);

UPDATE public.rent_requests
SET amount_repaid = 0,
    status = 'repaying',
    updated_at = now()
WHERE id = '16adb6a2-8907-42a1-aad9-6d30adf63883';

UPDATE public.landlords
SET rent_balance_due = COALESCE(rent_balance_due, 0) + 44000,
    updated_at = now()
WHERE id = '9609f7fa-2918-4fd9-a646-e91eb5c283cb';

INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
VALUES (
  NULL,
  'phantom_repayment_reversed',
  'repayments',
  '16adb6a2-8907-42a1-aad9-6d30adf63883',
  jsonb_build_object(
    'reason', 'Phantom 44,000 settlement on Ssekyanzi Kenneth rent request — no ledger leg, no agent_collections, no audit trail. Cash never moved. Reversed.',
    'tenant_id', 'f73e4360-50e7-4338-b6a2-2dcc44624a55',
    'rent_request_id', '16adb6a2-8907-42a1-aad9-6d30adf63883',
    'landlord_id', '9609f7fa-2918-4fd9-a646-e91eb5c283cb',
    'reversed_repayment_ids', jsonb_build_array(
      '770bdbea-8330-475a-a0ba-7eed57315103',
      '8df3681a-e979-4f09-9b47-fc4a6ca3f4e8',
      'a2e9cfe8-7209-47f1-ae78-f8d3dce4b9b6',
      'fcdbfd89-bd94-41bf-8536-2541935cf1b9'
    ),
    'amount_restored', 44000,
    'reversed_at', now()
  )
);
