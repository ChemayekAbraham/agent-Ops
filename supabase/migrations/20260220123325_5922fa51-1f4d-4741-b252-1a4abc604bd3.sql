
-- Allow managers to delete rent requests
CREATE POLICY "Managers can delete rent requests"
ON public.rent_requests
FOR DELETE
USING (has_role(auth.uid(), 'manager'::app_role));

-- Allow managers to delete profiles (already exists but let's ensure via has_role)
-- Already handled in existing RLS

-- Allow managers to delete deposit requests
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'deposit_requests' AND policyname = 'Managers can delete deposit requests'
  ) THEN
    EXECUTE 'CREATE POLICY "Managers can delete deposit requests" ON public.deposit_requests FOR DELETE USING (has_role(auth.uid(), ''manager''::app_role))';
  END IF;
END $$;
