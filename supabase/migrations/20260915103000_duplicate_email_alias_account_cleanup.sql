-- Manual review 2026-09-15: three clusters of duplicate/alias accounts sharing
-- one Gmail address (either literally, or as a common prefix + incrementing
-- digit suffix) across otherwise-distinct profile names:
--   twahalu1..23@gmail.com          (13 accounts, "Lubega Twaha"/"Twaha Lubega"/etc.)
--   kisembojulius40@gmail.com       (6 accounts, distinct names)
--   dxinternational3@gmail.com      (5 accounts, distinct names)
--   dorothynakasi01/25/120@gmail.com (3 accounts, same name)
-- Confirmed by Josh Wanda to be removed regardless of prior earnings. Ledger
-- history is NOT touched (money already withdrawn is not reversed) — only the
-- profile is redacted/frozen, same reversible pattern as
-- 20260914150000_signup_velocity_guard_and_extended_fraud_ring_sweep.sql.

CREATE TEMP TABLE tmp_dup_ids AS
SELECT id AS user_id
FROM public.profiles
WHERE deleted_at IS NULL
  AND id = ANY(ARRAY[
    -- twahalu1..23@gmail.com
    '407b6a17-75b8-4cfd-a3db-ce034989c0c4','9dee68b0-ced2-4ea4-8031-3b5ebcba5f68',
    '55bfa48b-a21a-429d-ae57-68158cd04143','d6afe497-1363-415e-ac0c-c5de53359293',
    '5a645220-7abd-439b-b960-3002f021991d','071749f2-0150-4572-8da6-6de8b000c094',
    '2d036028-02b5-4f29-8433-fdd011e353e1','45dda3b2-1f04-459a-915c-825e5daec6bf',
    'b8c1dda6-9ad2-46d6-821c-9aa8940178cd','b8c0bff7-c707-4617-af58-97e04344ea9e',
    '081f99df-b96b-464a-9b99-3ff41d737169','03456a46-c7d0-4875-ab26-e210dfc72ceb',
    '47e8fd53-694e-402e-9192-e9567604bad7',
    -- kisembojulius40@gmail.com
    'ae474e60-b0f6-4b1a-9c8a-7039bbc0b594','44aa235e-f137-4f36-aa61-c26f2d6c7bd9',
    'a27650b6-347f-4728-b70b-4bd92fd14ced','dd7e88ae-53cb-44c9-bf20-de7337dfa2ee',
    '4cc7c760-43a1-4890-9799-ad3804a38318','bd608de8-44b1-4109-b7ee-0de35a7a9a45',
    -- dxinternational3@gmail.com
    'c3e886f1-1d64-4a96-a6f9-2e63aa4f9c89','ee40822a-ebb2-461f-bebe-d73b690ac95f',
    'f7cf9062-e07e-4c2e-ad53-936bf161f764','4f0ba443-164d-40b3-8237-b8b5b146666a',
    '76c88499-829e-4678-a9de-001cba8bbabb',
    -- dorothynakasi01/25/120@gmail.com
    '90e33f86-fb12-462d-96ea-e0ac9eaf8e18','cff0ce36-1276-41c5-b2b1-51a50846c3a5',
    '3d9e3431-32aa-49d6-809f-7a603265d18a'
  ]::uuid[]);

CREATE TEMP TABLE tmp_dup_snapshot AS
SELECT p.id AS user_id, p.full_name, p.email, p.phone, p.national_id
FROM public.profiles p
JOIN tmp_dup_ids t ON t.user_id = p.id;

CREATE TEMP TABLE tmp_dup_roles AS
SELECT ur.user_id, jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', ur.enabled)) AS roles
FROM public.user_roles ur
JOIN tmp_dup_ids t ON t.user_id = ur.user_id
GROUP BY ur.user_id;

INSERT INTO public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
SELECT s.user_id, s.full_name, s.email, s.phone, s.national_id,
       COALESCE(r.roles, '[]'::jsonb), 'soft_deleted',
       'Duplicate/alias account sharing an email (literal or incrementing-digit suffix) with other distinct profile names. Manual review 2026-09-15; removed per Josh Wanda regardless of prior earnings (ledger history preserved, not reversed).',
       'cb798acb-68bc-4b4e-a414-a3d374e030b6'
FROM tmp_dup_snapshot s
LEFT JOIN tmp_dup_roles r ON r.user_id = s.user_id;

DELETE FROM public.user_roles WHERE user_id IN (SELECT user_id FROM tmp_dup_ids);
DELETE FROM public.push_subscriptions WHERE user_id IN (SELECT user_id FROM tmp_dup_ids);

UPDATE public.profiles p SET
  full_name = CASE WHEN p.full_name LIKE '[DELETED]%' THEN p.full_name ELSE '[DELETED] ' || COALESCE(p.full_name,'Account') END,
  previous_full_name = COALESCE(p.previous_full_name, p.full_name),
  email = 'deleted+' || p.id::text || '@deleted.invalid',
  phone = NULL,
  national_id = NULL,
  mobile_money_number = NULL,
  is_frozen = true,
  frozen_at = COALESCE(p.frozen_at, now()),
  frozen_reason = 'Account deleted: duplicate/alias account sharing an email with other distinct profiles, 2026-09-15 manual review',
  deleted_at = now(),
  deleted_by = 'cb798acb-68bc-4b4e-a414-a3d374e030b6',
  deletion_reason = 'Duplicate/alias account sharing an email with other distinct profiles. Manual review 2026-09-15.'
FROM tmp_dup_snapshot s
WHERE p.id = s.user_id;

INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
SELECT 'cb798acb-68bc-4b4e-a414-a3d374e030b6', 'soft_delete_account', 'soft_delete_account', 'profiles', user_id::text,
  jsonb_build_object(
    'reason','Duplicate/alias account sharing an email with other distinct profiles. Manual review 2026-09-15.',
    'performed_by','cb798acb-68bc-4b4e-a414-a3d374e030b6',
    'bulk_remediation', true
  )
FROM tmp_dup_snapshot;

DROP TABLE tmp_dup_ids;
DROP TABLE tmp_dup_snapshot;
DROP TABLE tmp_dup_roles;
