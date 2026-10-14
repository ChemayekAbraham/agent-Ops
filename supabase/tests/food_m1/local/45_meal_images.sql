-- Meal photos (20261013120001). Runs in the same session as 10_behaviour.sql.
-- Uploads and reads are exercised as the real authenticated role against the
-- storage stand-in with RLS on, exactly as Supabase's storage API runs them.
-- A SELECT that a policy admits is what Storage requires before it issues a
-- signed URL; that link between "row visible" and "URL issued" is Supabase's
-- behaviour and is NOT proven by this stand-in.

BEGIN;
SELECT food_test.ok((SELECT NOT public AND file_size_limit = 2097152
                       AND (allowed_mime_types IS NULL OR allowed_mime_types <@ ARRAY['image/jpeg','image/png','image/webp'])
                       FROM storage.buckets WHERE id = 'food-meal-images'),
                    'PH-01 bucket: PRIVATE, 2 MB, no MIME type outside JPEG/PNG/WebP');

-- the active coordinator uploads under a server-shaped name
SELECT food_test.act_as(food_test.id('coord'));
INSERT INTO storage.objects (bucket_id, name, owner)
VALUES ('food-meal-images', 'meals/11111111-1111-4111-8111-111111111111.jpg', auth.uid());
SELECT food_test.ok(true, 'PH-02 the active coordinator can upload a meal photo');
SELECT food_test.raises($$INSERT INTO storage.objects (bucket_id, name) VALUES ('food-meal-images', 'meals/../../avatars/x.jpg')$$,
                        '42501', 'PH-03 a name outside the server shape is refused');
SELECT food_test.raises($$INSERT INTO storage.objects (bucket_id, name) VALUES ('food-meal-images', 'meals/22222222-2222-4222-8222-222222222222.gif')$$,
                        '42501', 'PH-04 a non-image extension is refused');

-- immutability: no overwrite, no delete through the API
UPDATE storage.objects SET name = 'meals/33333333-3333-4333-8333-333333333333.jpg'
 WHERE bucket_id = 'food-meal-images';
DELETE FROM storage.objects WHERE bucket_id = 'food-meal-images';
RESET ROLE;
SELECT food_test.ok((SELECT count(*) FROM storage.objects
                      WHERE bucket_id = 'food-meal-images'
                        AND name = 'meals/11111111-1111-4111-8111-111111111111.jpg') = 1,
                    'PH-05 an uploaded photo cannot be overwritten or deleted through the API');

-- others may not upload
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.raises($$INSERT INTO storage.objects (bucket_id, name) VALUES ('food-meal-images', 'meals/44444444-4444-4444-8444-444444444444.png')$$,
                        '42501', 'PH-06 an employee cannot upload a meal photo');
-- the unrelated bucket keeps its own rule, untouched by Food
INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('avatars', 'a.png', auth.uid());
SELECT food_test.ok(true, 'PH-07 another bucket keeps working under its own policy');
SET LOCAL ROLE anon;
SELECT food_test.raises($$INSERT INTO storage.objects (bucket_id, name) VALUES ('food-meal-images', 'meals/55555555-5555-4555-8555-555555555555.png')$$,
                        '42501', 'PH-08 anonymous cannot upload');
-- EXECUTE is checked before anything else, so any meal id proves it
SELECT food_test.raises($$SELECT public.food_set_meal_image(gen_random_uuid(), NULL)$$,
                        '42501', 'PH-09 anonymous cannot call food_set_meal_image');
ROLLBACK;

-- a backup coordinator cannot upload
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_transfer_coordinator(food_test.id('emp_ok'), 'transfer_with_backup', 'handover for photo test');
SELECT food_test.raises($$INSERT INTO storage.objects (bucket_id, name) VALUES ('food-meal-images', 'meals/66666666-6666-4666-8666-666666666666.jpg')$$,
                        '42501', 'PH-10 a backup (read-only) coordinator cannot upload');
ROLLBACK;

-- setting and clearing a meal's photo
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
INSERT INTO storage.objects (bucket_id, name, owner)
VALUES ('food-meal-images', 'meals/77777777-7777-4777-8777-777777777777.webp', auth.uid());
SELECT food_test.raises(format($$SELECT public.food_set_meal_image(%L, 'https://evil.example/x.jpg')$$, pg_temp.v('meal')),
                        '22023', 'PH-11 an outside URL is refused');
SELECT food_test.raises(format($$SELECT public.food_set_meal_image(%L, 'meals/88888888-8888-4888-8888-888888888888.jpg')$$, pg_temp.v('meal')),
                        'P0002', 'PH-12 a photo that was never uploaded is refused');
SELECT public.food_set_meal_image(pg_temp.v('meal'), 'meals/77777777-7777-4777-8777-777777777777.webp', 'new photo');
SELECT food_test.ok((SELECT image_path FROM public.food_meals WHERE id = pg_temp.v('meal'))
                     = 'meals/77777777-7777-4777-8777-777777777777.webp', 'PH-13 the coordinator sets the photo');
SELECT food_test.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(public.food_menu_for_day()->'periods') p,
                                   jsonb_array_elements(p->'meals') m
                             WHERE m->>'image_path' = 'meals/77777777-7777-4777-8777-777777777777.webp'),
                    'PH-14 the menu carries the photo');
SELECT public.food_set_meal_image(pg_temp.v('meal'), NULL, 'remove');
SELECT food_test.ok((SELECT image_path FROM public.food_meals WHERE id = pg_temp.v('meal')) IS NULL, 'PH-15 the coordinator removes the photo');
RESET ROLE;
SELECT food_test.ok((SELECT count(*) FROM public.food_audit WHERE entity = 'meal' AND entity_id = pg_temp.v('meal')
                       AND action IN ('photo_set', 'photo_removed')) = 2, 'PH-16 both changes are in the audit trail');
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.raises(format($$SELECT public.food_set_meal_image(%L, NULL)$$, pg_temp.v('meal')),
                        '42501', 'PH-17 an employee cannot change a meal photo');
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_set_meal_status(pg_temp.v('meal2'), 'archived', 'test');
SELECT food_test.raises(format($$SELECT public.food_set_meal_image(%L, NULL)$$, pg_temp.v('meal2')),
                        '22023', 'PH-18 an archived meal cannot be changed');
ROLLBACK;

-- ─────────── who can READ a photo (what Storage requires before signing) ───────────
-- A = photo of the published meal 'meal'; C = photo of a draft meal;
-- B = uploaded but attached to nothing.
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
INSERT INTO storage.objects (bucket_id, name, owner) VALUES
  ('food-meal-images', 'meals/a0000000-0000-4000-8000-00000000000a.jpg', auth.uid()),
  ('food-meal-images', 'meals/b0000000-0000-4000-8000-00000000000b.png', auth.uid()),
  ('food-meal-images', 'meals/c0000000-0000-4000-8000-00000000000c.webp', auth.uid());
SELECT public.food_set_meal_image(pg_temp.v('meal'), 'meals/a0000000-0000-4000-8000-00000000000a.jpg', 'published meal photo');
INSERT INTO t_ctx VALUES ('draft', public.food_upsert_meal(NULL, 'Draft dish', NULL, NULL, 1000, NULL, 'photo read test'));
SELECT public.food_set_meal_image(pg_temp.v('draft'), 'meals/c0000000-0000-4000-8000-00000000000c.webp', 'draft meal photo');
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images') = 3,
                    'PH-19 the active coordinator can read every meal photo (published, draft, unattached)');

SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images'
                       AND name = 'meals/a0000000-0000-4000-8000-00000000000a.jpg') = 1,
                    'PH-20 a canteen employee can read the photo of a published meal');
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images'
                       AND name = 'meals/c0000000-0000-4000-8000-00000000000c.webp') = 0,
                    'PH-21 a draft meal''s photo is hidden from employees, even by exact name');
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images'
                       AND name = 'meals/b0000000-0000-4000-8000-00000000000b.png') = 0,
                    'PH-22 an unattached upload is hidden from employees');
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images') = 1,
                    'PH-23 an employee can list nothing beyond published meal photos');

SELECT food_test.act_as(food_test.id('tenant'));
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images') = 0,
                    'PH-24 a signed-in non-staff account (tenant) reads no meal photo');
SELECT food_test.act_as(food_test.id('emp_off'));
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images') = 0,
                    'PH-25 a disabled employee reads no meal photo');
SET LOCAL ROLE anon;
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images') = 0,
                    'PH-26 anonymous reads no meal photo');
SELECT food_test.raises($$SELECT public.food_meal_photo_readable('meals/a0000000-0000-4000-8000-00000000000a.jpg')$$,
                        '42501', 'PH-27 anonymous cannot call the read check');

-- unpublishing withdraws the photo from employees
SELECT food_test.act_as(food_test.id('coord'));
SELECT public.food_set_meal_status(pg_temp.v('meal'), 'draft', 'photo read test');
SELECT food_test.act_as(food_test.id('emp_a'));
SELECT food_test.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'food-meal-images') = 0,
                    'PH-28 once the meal is unpublished, employees can no longer read its photo');
ROLLBACK;

-- ─────────── food_upsert_meal cannot bypass food_set_meal_image ───────────
BEGIN;
SELECT food_test.act_as(food_test.id('coord'));
SELECT food_test.raises($$SELECT public.food_upsert_meal(NULL, 'X', NULL, NULL, 1, 'https://evil.example/pixel.png')$$,
                        '22023', 'PH-29 new meal: an external URL is refused');
SELECT food_test.raises($$SELECT public.food_upsert_meal(NULL, 'X', NULL, NULL, 1, 'data:image/png;base64,AAAA')$$,
                        '22023', 'PH-30 new meal: a data URL is refused');
SELECT food_test.raises($$SELECT public.food_upsert_meal(NULL, 'X', NULL, NULL, 1, '/etc/passwd')$$,
                        '22023', 'PH-31 new meal: an absolute path is refused');
SELECT food_test.raises($$SELECT public.food_upsert_meal(NULL, 'X', NULL, NULL, 1, '../avatars/a.png')$$,
                        '22023', 'PH-32 new meal: a path into another bucket is refused');
SELECT food_test.raises($$SELECT public.food_upsert_meal(NULL, 'X', NULL, NULL, 1, 'meals/99999999-9999-4999-8999-999999999999.jpg')$$,
                        '22023', 'PH-33 new meal: even a well-formed name must go through food_set_meal_image');
INSERT INTO storage.objects (bucket_id, name, owner)
VALUES ('food-meal-images', 'meals/d0000000-0000-4000-8000-00000000000d.jpg', auth.uid());
SELECT public.food_set_meal_image(pg_temp.v('meal'), 'meals/d0000000-0000-4000-8000-00000000000d.jpg', 'photo');
SELECT food_test.raises(format($$SELECT public.food_upsert_meal(%L, 'Matooke', NULL, NULL, 5000, 'https://evil.example/swap.jpg')$$, pg_temp.v('meal')),
                        '22023', 'PH-34 edit: a photo cannot be swapped through food_upsert_meal');
SELECT public.food_upsert_meal(pg_temp.v('meal'), 'Matooke renamed', 'with beans', NULL, 5200, NULL, 'edit');
SELECT food_test.ok((SELECT name = 'Matooke renamed' AND image_path = 'meals/d0000000-0000-4000-8000-00000000000d.jpg'
                       FROM public.food_meals WHERE id = pg_temp.v('meal')),
                    'PH-35 an ordinary edit still works and keeps the validated photo');
RESET ROLE;
-- defence in depth: the column itself refuses anything but a server-shaped name
SELECT food_test.raises(format($$UPDATE public.food_meals SET image_path = 'https://evil.example/x.jpg' WHERE id = %L$$, pg_temp.v('meal')),
                        '23514', 'PH-36 the image_path column refuses an external URL even for a privileged write');
SELECT food_test.ok((SELECT p.proconfig::text LIKE '%pg_temp%' FROM pg_proc p
                      WHERE p.oid = 'public.food_upsert_meal(uuid,text,text,uuid,numeric,text,text)'::regprocedure),
                    'PH-37 food_upsert_meal keeps search_path with pg_temp last');
SELECT food_test.ok(NOT has_function_privilege('anon', 'public.food_upsert_meal(uuid,text,text,uuid,numeric,text,text)', 'EXECUTE')
                AND has_function_privilege('authenticated', 'public.food_upsert_meal(uuid,text,text,uuid,numeric,text,text)', 'EXECUTE'),
                    'PH-38 food_upsert_meal grants unchanged (authenticated only)');
ROLLBACK;
