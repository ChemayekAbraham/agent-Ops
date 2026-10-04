
-- 1. Cutoff config
CREATE TABLE IF NOT EXISTS public.system_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Executives read system_config" ON public.system_config;
CREATE POLICY "Executives read system_config" ON public.system_config
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'coo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'cto') OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'super_admin'));

INSERT INTO public.system_config(key, value)
VALUES ('proxy_custody_cutoff_at', to_jsonb(now()::text))
ON CONFLICT (key) DO NOTHING;

-- 2. withdrawal_requests audit columns
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS initiated_by uuid,
  ADD COLUMN IF NOT EXISTS beneficiary_id uuid;
CREATE INDEX IF NOT EXISTS idx_wr_initiated_by ON public.withdrawal_requests(initiated_by);
CREATE INDEX IF NOT EXISTS idx_wr_beneficiary  ON public.withdrawal_requests(beneficiary_id);

-- 3. is_supporter helper (uses user_roles)
CREATE OR REPLACE FUNCTION public.is_supporter(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_user_id AND ur.role = 'supporter'
  );
$$;

-- 4. Cutoff trigger blocking agent-custody ledger writes post-cutoff
CREATE OR REPLACE FUNCTION public.block_proxy_custody_writes()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_cutoff timestamptz;
  v_lp_uuid uuid;
  v_bypass text;
BEGIN
  BEGIN v_bypass := current_setting('wallet.legacy_proxy_reversal', true); EXCEPTION WHEN OTHERS THEN v_bypass := NULL; END;
  IF v_bypass = 'true' THEN RETURN NEW; END IF;

  IF NEW.ledger_scope <> 'wallet' THEN RETURN NEW; END IF;
  IF NEW.linked_party IS NULL OR NEW.user_id IS NULL THEN RETURN NEW; END IF;

  SELECT (value #>> '{}')::timestamptz INTO v_cutoff
    FROM public.system_config WHERE key = 'proxy_custody_cutoff_at';
  IF v_cutoff IS NULL OR NEW.created_at < v_cutoff THEN RETURN NEW; END IF;

  BEGIN v_lp_uuid := NEW.linked_party::uuid; EXCEPTION WHEN OTHERS THEN RETURN NEW; END;

  IF v_lp_uuid = NEW.user_id THEN RETURN NEW; END IF;

  IF public.is_supporter(v_lp_uuid) THEN
    RAISE EXCEPTION 'PROXY_CUSTODY_BLOCKED: ledger writes that park partner % funds in agent % wallet are forbidden after %. Credit the partner directly.',
      v_lp_uuid, NEW.user_id, v_cutoff
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_proxy_custody_writes ON public.general_ledger;
CREATE TRIGGER trg_block_proxy_custody_writes
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.block_proxy_custody_writes();

-- 5. Force FinOps visibility for proxy withdrawals
CREATE OR REPLACE FUNCTION public.force_proxy_finops_visibility()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.initiated_by IS NOT NULL AND NEW.initiated_by <> NEW.user_id THEN
    NEW.auto_dispatched := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_force_proxy_finops_visibility ON public.withdrawal_requests;
CREATE TRIGGER trg_force_proxy_finops_visibility
  BEFORE INSERT OR UPDATE ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.force_proxy_finops_visibility();
