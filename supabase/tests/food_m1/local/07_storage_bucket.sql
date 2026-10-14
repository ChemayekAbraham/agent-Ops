-- Stands in for the Lovable Cloud storage tool, which creates the meal-photo
-- bucket BEFORE 20261013120001 runs: private, 2MB limit, no MIME list (the
-- tool sets none). Local disposable databases only.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('food-meal-images', 'food-meal-images', false, 2097152);
