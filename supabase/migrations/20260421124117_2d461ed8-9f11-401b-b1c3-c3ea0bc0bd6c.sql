-- Cleanup orphan referrals and add FK to enforce referential integrity going forward.

DO $$
DECLARE
  orphan_count INT;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM public.referrals r
  LEFT JOIN public.profiles p ON p.id = r.referred_id
  WHERE p.id IS NULL;

  DELETE FROM public.referrals r
  WHERE NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = r.referred_id
  );

  INSERT INTO public.audit_logs (action_type, table_name, metadata)
  VALUES (
    'referrals_orphan_cleanup',
    'referrals',
    jsonb_build_object(
      'orphans_purged', orphan_count,
      'reason', 'cleanup_orphan_referrals_blocking_FK_addition',
      'purged_at', now()
    )
  );
END $$;

ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_referred_id_fkey
  FOREIGN KEY (referred_id) REFERENCES public.profiles(id)
  ON DELETE CASCADE;
