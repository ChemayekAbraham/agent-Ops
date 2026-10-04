
-- lc1_chairpersons: only tenants creating during rent request should insert
-- Scope to authenticated users (already implied) - add explicit user check isn't possible since no user_id column
-- Keep but make it more explicit with auth check
DROP POLICY IF EXISTS "Tenants can insert lc1" ON public.lc1_chairpersons;
CREATE POLICY "Authenticated users can insert lc1" ON public.lc1_chairpersons
FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);

-- conversations: any authenticated user can create
DROP POLICY IF EXISTS "Users can create conversations" ON public.conversations;
CREATE POLICY "Authenticated users can create conversations" ON public.conversations
FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
