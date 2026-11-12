\set VERBOSITY verbose
UPDATE public.pipeline_switches SET is_on = true WHERE key = 'self_support_activate_on_landlord_paid';
SELECT set_config('tt.l', tt.person('Lead', ARRAY['supporter'])::text, false), set_config('tt.i', tt.person('Inv', ARRAY['supporter'])::text, false);
SELECT tt.float(current_setting('tt.l')::uuid, 1000000), tt.float(current_setting('tt.i')::uuid, 1000000);
SELECT set_config('tt.rr', tt.plan(1000000)::text, false);
SELECT tt.as_user(current_setting('tt.l')::uuid);
SELECT set_config('tt.code', co_support_create(current_setting('tt.rr')::uuid)->>'code', false);
SELECT tt.as_user(current_setting('tt.i')::uuid);
SELECT co_support_accept(current_setting('tt.code'))->>'ok';
