ALTER TABLE public.venue_visits DROP CONSTRAINT IF EXISTS venue_visits_category_check;
ALTER TABLE public.venue_visits ADD CONSTRAINT venue_visits_category_check
  CHECK (category = ANY (ARRAY[
    'worship','mall','restaurant','hotel','shop','market',
    'school','workplace','residence','home','other'
  ]));