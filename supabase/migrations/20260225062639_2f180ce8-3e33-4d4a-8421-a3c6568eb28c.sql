-- =============================================
-- Fix 1: Tighten lc1_chairpersons RLS policies
-- Only agents and managers should insert/view LC1 records
-- =============================================

-- Drop overly permissive policies
DROP POLICY IF EXISTS "Authenticated users can insert lc1" ON public.lc1_chairpersons;
DROP POLICY IF EXISTS "Authenticated users can view lc1" ON public.lc1_chairpersons;

-- Agents and managers can insert LC1 chairpersons
CREATE POLICY "Agents and managers can insert lc1"
ON public.lc1_chairpersons FOR INSERT TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'agent') OR has_role(auth.uid(), 'manager')
);

-- Agents and managers can view LC1 chairpersons
CREATE POLICY "Agents and managers can view lc1"
ON public.lc1_chairpersons FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'agent') OR has_role(auth.uid(), 'manager')
);

-- =============================================
-- Fix 2: Tighten receipt_numbers SELECT policy
-- Require authentication for viewing receipt numbers
-- =============================================

-- Drop the overly permissive public SELECT
DROP POLICY IF EXISTS "Users can view receipt numbers" ON public.receipt_numbers;

-- Authenticated users can view receipt numbers (needed for receipt claiming flow)
CREATE POLICY "Authenticated users can view receipt numbers"
ON public.receipt_numbers FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL);