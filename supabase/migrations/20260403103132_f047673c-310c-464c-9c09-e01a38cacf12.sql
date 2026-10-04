ALTER TABLE public.wallet_deductions
  ADD CONSTRAINT wallet_deductions_target_user_id_fkey
    FOREIGN KEY (target_user_id) REFERENCES public.profiles(id);

ALTER TABLE public.wallet_deductions
  ADD CONSTRAINT wallet_deductions_deducted_by_fkey
    FOREIGN KEY (deducted_by) REFERENCES public.profiles(id);