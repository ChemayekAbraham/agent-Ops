-- Add transaction date/time column to payment_confirmations table
ALTER TABLE public.payment_confirmations 
ADD COLUMN transaction_date TIMESTAMP WITH TIME ZONE;