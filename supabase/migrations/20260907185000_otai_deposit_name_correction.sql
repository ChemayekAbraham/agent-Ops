-- Correct a deposit-name misroute: incoming MTN payments from "ABRAHAM SAMWUEL OTAI"
-- (till 090777) were auto-credited to an unrelated agent (Sir Ian Martin,
-- 3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0) via a stale manual_route entry in
-- user_deposit_names, instead of Otai's own profile (9d5b1a58-7997-4d78-abfc-71d2dfbc4a18).
-- MTN "received" SMS never carries the payer's phone number, so this table is the
-- only lever available to the auto-credit matcher for this payer.

update user_deposit_names
set contested = true
where id = 'b4c46beb-55e6-4498-bb96-17a5e5909a37'
  and user_id = '3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0'
  and normalized_name = 'ABRAHAM SAMWUEL OTAI';

insert into user_deposit_names (user_id, normalized_name, source, contested)
values ('9d5b1a58-7997-4d78-abfc-71d2dfbc4a18', 'ABRAHAM SAMWUEL OTAI', 'manual_route', false)
on conflict (user_id, normalized_name) do nothing;
