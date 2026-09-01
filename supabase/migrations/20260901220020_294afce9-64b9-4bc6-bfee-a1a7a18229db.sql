INSERT INTO public.smartphone_catalog (brand, model_name, os_type, default_amount, is_active)
SELECT 'Iphone', m.model, 'ios', m.amount, true
FROM (VALUES
  ('XR', 700000),('XS', 750000),('XS Max', 850000),
  ('11', 950000),('11 Pro', 1150000),('11 Pro Max', 1300000),
  ('SE (2nd generation)', 700000),
  ('12 mini', 1100000),('12', 1250000),('12 Pro', 1500000),('12 Pro Max', 1700000),
  ('13 mini', 1350000),('13', 1550000),('13 Pro', 1900000),('13 Pro Max', 2100000),
  ('SE (3rd generation)', 900000),
  ('14', 1900000),('14 Plus', 2100000),('14 Pro', 2500000),('14 Pro Max', 2800000),
  ('15', 2400000),('15 Plus', 2650000),('15 Pro', 3100000),('15 Pro Max', 3500000),
  ('16e', 2200000),('16', 2900000),('16 Plus', 3200000),('16 Pro', 3700000),('16 Pro Max', 4100000),
  ('Air', 3900000),
  ('17', 3400000),('17 Pro', 4300000),('17 Pro Max', 4700000)
) AS m(model, amount)
WHERE NOT EXISTS (
  SELECT 1 FROM public.smartphone_catalog c
  WHERE lower(c.brand) = 'iphone' AND lower(coalesce(c.model_name,'')) = lower(m.model)
);