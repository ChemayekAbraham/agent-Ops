-- ── 1. Log table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deposit_profile_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  phone text,
  action text NOT NULL,
  conflict_user_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.deposit_profile_reconciliations TO service_role;
GRANT SELECT ON public.deposit_profile_reconciliations TO authenticated;

ALTER TABLE public.deposit_profile_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can view deposit profile reconciliations"
ON public.deposit_profile_reconciliations
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'manager'::public.app_role));

CREATE INDEX IF NOT EXISTS idx_deposit_profile_recon_user
  ON public.deposit_profile_reconciliations(user_id);

-- ── 2. Core ensure function ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_depositor_profile(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth record;
  v_email text;
  v_name text;
  v_phone text;
  v_last9 text;
  v_wallet_id uuid;
  v_conflict_id uuid;
  v_conflict_active boolean;
BEGIN
  -- Already has its own profile → just ensure it is verified/searchable.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    UPDATE public.profiles
       SET verified = true, updated_at = now()
     WHERE id = p_user_id AND verified = false;
    RETURN 'already_profiled';
  END IF;

  SELECT u.email,
         COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name') AS full_name,
         COALESCE(u.phone, u.raw_user_meta_data->>'phone')                          AS phone
    INTO v_auth
    FROM auth.users u
   WHERE u.id = p_user_id;

  IF NOT FOUND THEN
    RETURN 'no_auth_user';
  END IF;

  v_email := v_auth.email;
  v_name  := COALESCE(NULLIF(btrim(v_auth.full_name), ''), 'Welile User');

  -- Derive phone: explicit auth phone, else parse a welile.user email prefix.
  v_phone := v_auth.phone;
  IF v_phone IS NULL OR v_phone = '' THEN
    IF v_email ~ '^[0-9]+@welile\.user$' THEN
      v_phone := split_part(v_email, '@', 1);
    END IF;
  END IF;

  v_last9 := public.normalize_phone_last9(v_phone);
  IF v_last9 IS NULL OR length(v_last9) < 9 THEN
    INSERT INTO public.deposit_profile_reconciliations(user_id, phone, action, notes)
    VALUES (p_user_id, v_phone, 'no_phone',
            'Credited depositor has no derivable phone; cannot make searchable by number');
    RETURN 'no_phone';
  END IF;
  v_phone := '0' || v_last9;

  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = p_user_id LIMIT 1;

  -- Is the phone already held by a different profile?
  SELECT id INTO v_conflict_id
    FROM public.profiles
   WHERE public.normalize_phone_last9(phone) = v_last9
   LIMIT 1;

  IF v_conflict_id IS NOT NULL THEN
    -- Does the squatting account have real activity?
    SELECT (
         EXISTS (SELECT 1 FROM public.general_ledger gl
                  WHERE gl.user_id = v_conflict_id
                    AND gl.category = 'wallet_deposit'
                    AND gl.classification <> 'admin_correction')
      OR EXISTS (SELECT 1 FROM public.rent_requests rr
                  WHERE rr.tenant_id = v_conflict_id OR rr.agent_id = v_conflict_id)
      OR EXISTS (SELECT 1 FROM public.deposit_requests dr WHERE dr.user_id = v_conflict_id)
      OR COALESCE((SELECT withdrawable_balance FROM public.wallets WHERE user_id = v_conflict_id), 0) > 0
    ) INTO v_conflict_active;

    IF v_conflict_active THEN
      INSERT INTO public.deposit_profile_reconciliations(user_id, phone, action, conflict_user_id, notes)
      VALUES (p_user_id, v_phone, 'manual_review', v_conflict_id,
              'Phone is held by an active duplicate account; needs manual merge');
      RETURN 'conflict_manual_review';
    END IF;

    -- Empty shell duplicate: migrate its roles to the credited account, then retire it.
    INSERT INTO public.user_roles(user_id, role)
      SELECT p_user_id, role FROM public.user_roles WHERE user_id = v_conflict_id
      ON CONFLICT (user_id, role) DO NOTHING;
    DELETE FROM public.user_roles WHERE user_id = v_conflict_id;
    DELETE FROM public.profiles   WHERE id      = v_conflict_id;

    INSERT INTO public.deposit_profile_reconciliations(user_id, phone, action, conflict_user_id, notes)
    VALUES (p_user_id, v_phone, 'retired_shell_and_created', v_conflict_id,
            'Retired empty duplicate that was holding the phone, then created verified profile');
  END IF;

  INSERT INTO public.profiles(id, full_name, phone, email, verified, wallet_id, created_at, updated_at)
  VALUES (p_user_id, v_name, v_phone, v_email, true, v_wallet_id, now(), now())
  ON CONFLICT (id) DO UPDATE SET verified = true, updated_at = now();

  IF v_conflict_id IS NULL THEN
    INSERT INTO public.deposit_profile_reconciliations(user_id, phone, action, notes)
    VALUES (p_user_id, v_phone, 'created', 'Created verified profile for credited depositor');
  END IF;

  RETURN 'created';
END;
$$;

-- ── 3. Ledger trigger (never breaks deposit posting) ─────────
CREATE OR REPLACE FUNCTION public.trg_ensure_depositor_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.category = 'wallet_deposit'
     AND NEW.direction = 'cash_in'
     AND NEW.user_id IS NOT NULL
     AND COALESCE(NEW.classification, '') <> 'admin_correction' THEN
    BEGIN
      PERFORM public.ensure_depositor_profile(NEW.user_id);
    EXCEPTION WHEN OTHERS THEN
      -- Self-healing must never block a real deposit.
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_depositor_profile_on_credit ON public.general_ledger;
CREATE TRIGGER trg_ensure_depositor_profile_on_credit
AFTER INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.trg_ensure_depositor_profile();

-- ── 4. Bulk reconcile (backfill + nightly) ───────────────────
CREATE OR REPLACE FUNCTION public.reconcile_credited_deposit_profiles()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT gl.user_id
      FROM public.general_ledger gl
     WHERE gl.category = 'wallet_deposit'
       AND gl.direction = 'cash_in'
       AND gl.user_id IS NOT NULL
       AND gl.classification <> 'admin_correction'
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = gl.user_id)
  LOOP
    BEGIN
      PERFORM public.ensure_depositor_profile(r.user_id);
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.deposit_profile_reconciliations(user_id, action, notes)
      VALUES (r.user_id, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.trg_ensure_depositor_profile() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_depositor_profile(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_credited_deposit_profiles() TO service_role;

-- ── 5. Nightly cron ──────────────────────────────────────────
SELECT cron.schedule(
  'reconcile-credited-deposit-profiles',
  '15 1 * * *',
  $$SELECT public.reconcile_credited_deposit_profiles();$$
);