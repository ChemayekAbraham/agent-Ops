-- Add unique constraint on receipt_number_id to prevent duplicate submissions
-- A receipt code can only be claimed once
ALTER TABLE public.user_receipts 
ADD CONSTRAINT user_receipts_receipt_number_id_unique UNIQUE (receipt_number_id);