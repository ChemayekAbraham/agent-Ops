-- Food M1 — production PRE-CHECK. READ-ONLY. NOT YET RUN AGAINST PRODUCTION.
--
-- For a person with authorised read access to run BEFORE any Food migration
-- is applied. It changes nothing:
--   * the whole script runs in a READ ONLY transaction, so any write would
--     fail (ERROR 25006), and it ends in ROLLBACK;
--   * it reads catalog metadata and returns AGGREGATE COUNTS and booleans
--     only — no names, emails, phones, ids of staff, or any personal record.
-- Each row is one check: check | value | expectation.

BEGIN TRANSACTION READ ONLY;

SELECT 'P-1a profiles.deleted_at type' AS check,
       coalesce((SELECT data_type FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='profiles' AND column_name='deleted_at'), 'MISSING') AS value,
       'timestamp with time zone' AS expectation
UNION ALL
SELECT 'P-1b user_roles.enabled type',
       coalesce((SELECT data_type FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled'), 'MISSING'),
       'boolean'
UNION ALL
SELECT 'P-1c user_roles.role type',
       coalesce((SELECT udt_name FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='role'), 'MISSING'),
       'app_role'
UNION ALL
SELECT 'P-2a app_role has value employee',
       (EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                 WHERE t.typname='app_role' AND e.enumlabel='employee'))::text,
       'true'
UNION ALL
-- aggregate only: how many live accounts the canteen would admit (FM-15)
SELECT 'P-2b live profiles with an enabled employee role (count)',
       (SELECT count(DISTINCT ur.user_id) FROM public.user_roles ur
          JOIN public.profiles p ON p.id = ur.user_id
         WHERE ur.role::text = 'employee' AND coalesce(ur.enabled, true) AND p.deleted_at IS NULL)::text,
       'matches the number of staff who should use the canteen'
UNION ALL
SELECT 'P-2c employee roles that are disabled (count)',
       (SELECT count(*) FROM public.user_roles ur
         WHERE ur.role::text = 'employee' AND ur.enabled IS FALSE)::text,
       'informational'
UNION ALL
SELECT 'P-3a existing food_* tables/views',
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname LIKE 'food\_%')::text,
       '0'
UNION ALL
SELECT 'P-3b existing food_* / is_*food* functions',
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND (p.proname LIKE 'food\_%' OR p.proname LIKE 'is\_%food%'))::text,
       '0'
UNION ALL
SELECT 'P-3c existing food_* policies or triggers',
       ((SELECT count(*) FROM pg_policies WHERE policyname LIKE 'food\_%')
        + (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'food\_%'))::text,
       '0'
UNION ALL
SELECT 'P-3d auth.uid() exists',
       (to_regprocedure('auth.uid()') IS NOT NULL)::text,
       'true'
UNION ALL
-- the seed profile: existence and liveness only (no personal fields read)
SELECT 'P-4a seed coordinator profile exists and is live',
       (EXISTS (SELECT 1 FROM public.profiles
                 WHERE id = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b' AND deleted_at IS NULL))::text,
       'true if M1 should seat it; false means use food_bootstrap_coordinator()'
UNION ALL
SELECT 'P-4b seed profile holds an enabled employee role',
       (EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'
                   AND role::text = 'employee' AND coalesce(enabled, true)))::text,
       'true expected (handover eligibility rules apply to successors)'
UNION ALL
-- meal photos (20261013120001): the bucket and policy names must be free, and
-- the storage tables must have the columns the migration uses
SELECT 'P-6a storage.buckets / storage.objects exist',
       (to_regclass('storage.buckets') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL)::text,
       'true'
UNION ALL
SELECT 'P-6b bucket food-meal-images not yet present',
       (NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'food-meal-images'))::text,
       'true (if false, the migration fails closed unless settings already match)'
UNION ALL
SELECT 'P-6c buckets has file_size_limit and allowed_mime_types',
       ((SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'storage' AND table_name = 'buckets'
            AND column_name IN ('file_size_limit', 'allowed_mime_types')) = 2)::text,
       'true'
UNION ALL
SELECT 'P-6d no storage policy named food_meal_images_*',
       (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'storage' AND policyname LIKE 'food\_meal\_images\_%')::text,
       '0'
UNION ALL
-- Supabase ORs storage policies together: one policy that does not name a bucket
-- would also open the PRIVATE food-meal-images bucket. Names only, no data.
SELECT 'P-6e storage.objects policies that do not restrict bucket_id',
       (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'storage' AND tablename = 'objects'
           AND coalesce(qual, '') NOT LIKE '%bucket_id%'
           AND coalesce(with_check, '') NOT LIKE '%bucket_id%')::text,
       '0 (otherwise list them by name and review before release)'
UNION ALL
-- 20261013125000 reads Platform Sales Officers from this view (fails cleanly
-- without it); counts only, no staff identities
SELECT 'P-7a public.v_pso_officers exists',
       (to_regclass('public.v_pso_officers') IS NOT NULL)::text,
       'true'
UNION ALL
SELECT 'P-5 transaction is read-only',
       current_setting('transaction_read_only'),
       'on';

ROLLBACK;
