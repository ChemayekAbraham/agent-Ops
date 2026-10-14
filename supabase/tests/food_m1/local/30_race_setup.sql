-- Two-session race fixtures (cap race and last-serving stock race).
-- Applied as the owner to a disposable database that already carries the Food
-- migrations. Committed, because the racing sessions must see it.
\set ON_ERROR_STOP 1
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-0000000000a1', 'race-a@example.invalid'),
  ('f0000000-0000-4000-8000-0000000000b1', 'race-b@example.invalid');
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('f0000000-0000-4000-8000-0000000000a1', 'RACE A', 'race-a@example.invalid'),
  ('f0000000-0000-4000-8000-0000000000b1', 'RACE B', 'race-b@example.invalid');
-- staff: the canteen admits enabled employees only (FM-15)
INSERT INTO public.user_roles (user_id, role) VALUES
  ('f0000000-0000-4000-8000-0000000000a1', 'employee'),
  ('f0000000-0000-4000-8000-0000000000b1', 'employee');
INSERT INTO public.food_meals (id, name, price_ugx, status, created_by) VALUES
  ('f0000000-0000-4000-8000-00000000ee01', 'Race meal 1', 1000, 'published', '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'),
  ('f0000000-0000-4000-8000-00000000ee02', 'Race meal 2', 1000, 'published', '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b');
-- capped period (2 per person) and an uncapped one
INSERT INTO public.food_service_periods (id, name, ordering_opens_at, ordering_closes_at, max_qty_per_employee) VALUES
  ('f0000000-0000-4000-8000-00000000ef01', 'Race capped', '00:00', '23:59:59', 2),
  ('f0000000-0000-4000-8000-00000000ef02', 'Race stock',  '00:00', '23:59:59', NULL);
INSERT INTO public.food_menu_items (id, service_date, period_id, meal_id, price_ugx, servings_total, published_at, created_by) VALUES
  -- cap race: two DIFFERENT meals, so the carts share no row lock
  ('f0000000-0000-4000-8000-00000000ed01', (now() AT TIME ZONE 'Africa/Kampala')::date, 'f0000000-0000-4000-8000-00000000ef01', 'f0000000-0000-4000-8000-00000000ee01', 1000, NULL, now(), '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'),
  ('f0000000-0000-4000-8000-00000000ed02', (now() AT TIME ZONE 'Africa/Kampala')::date, 'f0000000-0000-4000-8000-00000000ef01', 'f0000000-0000-4000-8000-00000000ee02', 1000, NULL, now(), '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'),
  -- stock race: ONE serving left
  ('f0000000-0000-4000-8000-00000000ed03', (now() AT TIME ZONE 'Africa/Kampala')::date, 'f0000000-0000-4000-8000-00000000ef02', 'f0000000-0000-4000-8000-00000000ee01', 1000, 1, now(), '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b');
