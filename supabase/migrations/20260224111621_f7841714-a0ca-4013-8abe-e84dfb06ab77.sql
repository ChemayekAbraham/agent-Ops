-- Make storage buckets private (avatars, products, reviews)
-- Public URL access will no longer work; signed URLs are now used in the application
UPDATE storage.buckets SET public = false WHERE id IN ('avatars', 'products', 'reviews');