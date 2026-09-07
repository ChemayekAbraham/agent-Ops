-- Follow-up to 20260907185000_otai_deposit_name_correction.sql: that migration
-- pointed the corrected "ABRAHAM SAMWUEL OTAI" mapping at profile
-- 9d5b1a58-7997-4d78-abfc-71d2dfbc4a18, chosen because profiles.tenant_status
-- said 'active'. That profile turns out to have zero rent_requests — it's a
-- dead duplicate. The real tenant is aad13004-b80d-4611-b982-bac335c9dc9e
-- ("Otai Abraham"), who has a completed rent plan and a second rent plan
-- currently in `repaying` status (512,000 of 800,000 repaid). Route future
-- MTN payments from this payer name to that profile instead.

update user_deposit_names
set contested = true
where id = '4e787b94-0ef5-48ab-bf2b-af281a41b617'
  and user_id = '9d5b1a58-7997-4d78-abfc-71d2dfbc4a18'
  and normalized_name = 'ABRAHAM SAMWUEL OTAI';

insert into user_deposit_names (user_id, normalized_name, source, contested)
values ('aad13004-b80d-4611-b982-bac335c9dc9e', 'ABRAHAM SAMWUEL OTAI', 'manual_route', false)
on conflict (user_id, normalized_name) do nothing;
