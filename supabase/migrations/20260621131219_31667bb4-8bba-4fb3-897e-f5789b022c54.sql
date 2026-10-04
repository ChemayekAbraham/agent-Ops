-- Borrower residence verification links on the profile.
-- A borrower must have a linked landlord (verified, with GPS, and a registering
-- agent) plus an LC1 chairperson before they can request a lending-agent loan.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS borrower_landlord_id uuid REFERENCES public.landlords(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS borrower_lc1_id uuid REFERENCES public.lc1_chairpersons(id) ON DELETE SET NULL;

-- Allow any authenticated borrower to register their OWN LC1 chairperson
-- (inserted unverified; ops verify later). Previously only agents/managers
-- could insert LC1 rows, which blocked self-service borrowers.
DROP POLICY IF EXISTS "Users can insert their own lc1" ON public.lc1_chairpersons;
CREATE POLICY "Users can insert their own lc1"
ON public.lc1_chairpersons
FOR INSERT
TO authenticated
WITH CHECK (registered_by = auth.uid());

-- Borrowers need to read landlord + lc1 rows they have linked so the gate can
-- show name / GPS / registering agent. landlords + lc1_chairpersons already
-- expose broad authenticated SELECT, so no extra read policy is required here.