-- Fix all FK constraints that block auth.users deletion by adding ON DELETE SET NULL

ALTER TABLE public.wallet_transactions DROP CONSTRAINT wallet_transactions_sender_id_fkey;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_sender_id_fkey 
  FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.wallet_transactions DROP CONSTRAINT wallet_transactions_recipient_id_fkey;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_recipient_id_fkey 
  FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.rent_requests DROP CONSTRAINT rent_requests_supporter_id_fkey;
ALTER TABLE public.rent_requests ADD CONSTRAINT rent_requests_supporter_id_fkey 
  FOREIGN KEY (supporter_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.rent_requests DROP CONSTRAINT rent_requests_approved_by_fkey;
ALTER TABLE public.rent_requests ADD CONSTRAINT rent_requests_approved_by_fkey 
  FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.money_requests DROP CONSTRAINT money_requests_requester_id_fkey;
ALTER TABLE public.money_requests ADD CONSTRAINT money_requests_requester_id_fkey 
  FOREIGN KEY (requester_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.money_requests DROP CONSTRAINT money_requests_recipient_id_fkey;
ALTER TABLE public.money_requests ADD CONSTRAINT money_requests_recipient_id_fkey 
  FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.deposit_requests DROP CONSTRAINT deposit_requests_processed_by_fkey;
ALTER TABLE public.deposit_requests ADD CONSTRAINT deposit_requests_processed_by_fkey 
  FOREIGN KEY (processed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.landlords DROP CONSTRAINT landlords_tenant_id_fkey;
ALTER TABLE public.landlords ADD CONSTRAINT landlords_tenant_id_fkey 
  FOREIGN KEY (tenant_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.landlords DROP CONSTRAINT landlords_location_captured_by_fkey;
ALTER TABLE public.landlords ADD CONSTRAINT landlords_location_captured_by_fkey 
  FOREIGN KEY (location_captured_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.agent_commission_payouts DROP CONSTRAINT agent_commission_payouts_processed_by_fkey;
ALTER TABLE public.agent_commission_payouts ADD CONSTRAINT agent_commission_payouts_processed_by_fkey 
  FOREIGN KEY (processed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.staff_profiles DROP CONSTRAINT staff_profiles_created_by_fkey;
ALTER TABLE public.staff_profiles ADD CONSTRAINT staff_profiles_created_by_fkey 
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.user_locations DROP CONSTRAINT user_locations_verified_by_fkey;
ALTER TABLE public.user_locations ADD CONSTRAINT user_locations_verified_by_fkey 
  FOREIGN KEY (verified_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.voided_ledger_entries DROP CONSTRAINT voided_ledger_entries_voided_by_fkey;
ALTER TABLE public.voided_ledger_entries ADD CONSTRAINT voided_ledger_entries_voided_by_fkey 
  FOREIGN KEY (voided_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.operations_departments DROP CONSTRAINT operations_departments_assigned_by_fkey;
ALTER TABLE public.operations_departments ADD CONSTRAINT operations_departments_assigned_by_fkey 
  FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;