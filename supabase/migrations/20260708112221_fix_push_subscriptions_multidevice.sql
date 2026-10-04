-- Web Push: allow multiple device subscriptions per user and fix upsert.
--
-- Problem 1: a leftover UNIQUE index on (user_id) alone forced one row per
-- user, so subscribing on a second device (or re-subscribing with a new
-- endpoint) failed with a duplicate-key error -> "Could not enable
-- notifications". The correct key is (user_id, endpoint), which already exists
-- as push_subscriptions_user_id_endpoint_key.
DROP INDEX IF EXISTS public.push_subscriptions_user_id_unique;

-- Problem 2: the client upserts with onConflict "user_id,endpoint". When the
-- row already exists that becomes an UPDATE, but there was no UPDATE RLS
-- policy, so the update path was rejected. Add it (idempotent).
DROP POLICY IF EXISTS "Users can update own subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can update own subscriptions"
  ON public.push_subscriptions
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
