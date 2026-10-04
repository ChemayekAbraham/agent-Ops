
-- 1. Add territory column to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS territory text;

-- 2. Create agent_float_limits table
CREATE TABLE public.agent_float_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  float_limit numeric NOT NULL DEFAULT 0,
  collected_today numeric NOT NULL DEFAULT 0,
  last_reset_date date NOT NULL DEFAULT CURRENT_DATE,
  assigned_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id)
);

ALTER TABLE public.agent_float_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_select_own_float" ON public.agent_float_limits
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

CREATE POLICY "manager_insert_float" ON public.agent_float_limits
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "manager_update_float" ON public.agent_float_limits
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "agent_update_own_float_collected" ON public.agent_float_limits
  FOR UPDATE TO authenticated USING (agent_id = auth.uid()) WITH CHECK (agent_id = auth.uid());

-- 3. Create agent_visits table
CREATE TABLE public.agent_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  accuracy double precision,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_insert_own_visits" ON public.agent_visits
  FOR INSERT TO authenticated WITH CHECK (agent_id = auth.uid());

CREATE POLICY "agent_select_own_visits" ON public.agent_visits
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

CREATE POLICY "manager_select_all_visits" ON public.agent_visits
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));

-- 4. Create payment_tokens table
CREATE TABLE public.payment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_code text NOT NULL,
  amount numeric NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  used_at timestamptz,
  visit_id uuid REFERENCES public.agent_visits(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_insert_own_tokens" ON public.payment_tokens
  FOR INSERT TO authenticated WITH CHECK (agent_id = auth.uid());

CREATE POLICY "agent_select_own_tokens" ON public.payment_tokens
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

CREATE POLICY "agent_update_own_tokens" ON public.payment_tokens
  FOR UPDATE TO authenticated USING (agent_id = auth.uid());

-- 5. Create collection_payment_method enum
DO $$ BEGIN
  CREATE TYPE public.collection_payment_method AS ENUM ('mobile_money', 'cash', 'in_app_wallet');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 6. Create agent_collections table
CREATE TABLE public.agent_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_id uuid NOT NULL REFERENCES public.payment_tokens(id),
  amount numeric NOT NULL,
  payment_method public.collection_payment_method NOT NULL,
  float_before numeric NOT NULL DEFAULT 0,
  float_after numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_insert_own_collections" ON public.agent_collections
  FOR INSERT TO authenticated WITH CHECK (agent_id = auth.uid());

CREATE POLICY "agent_select_own_collections" ON public.agent_collections
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

-- 7. Reset float function
CREATE OR REPLACE FUNCTION public.reset_agent_float_if_stale(p_agent_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE agent_float_limits
  SET collected_today = 0, last_reset_date = CURRENT_DATE, updated_at = now()
  WHERE agent_id = p_agent_id AND last_reset_date < CURRENT_DATE;
END;
$$;

-- 8. Validate and record collection RPC
CREATE OR REPLACE FUNCTION public.validate_and_record_collection(
  p_token_code text, p_payment_method text, p_agent_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_token record; v_float record;
  v_float_before numeric; v_float_after numeric; v_collection_id uuid;
BEGIN
  SELECT * INTO v_token FROM payment_tokens WHERE token_code = p_token_code AND agent_id = p_agent_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Token not found'); END IF;
  IF v_token.used THEN RETURN jsonb_build_object('success', false, 'error', 'Token already used'); END IF;
  IF v_token.expires_at < now() THEN RETURN jsonb_build_object('success', false, 'error', 'Token has expired'); END IF;

  PERFORM reset_agent_float_if_stale(p_agent_id);

  IF p_payment_method = 'cash' THEN
    SELECT * INTO v_float FROM agent_float_limits WHERE agent_id = p_agent_id;
    IF FOUND THEN
      IF v_float.collected_today + v_token.amount > v_float.float_limit THEN
        RETURN jsonb_build_object('success', false, 'error', 'Float capacity exceeded. Remaining: ' || (v_float.float_limit - v_float.collected_today)::text);
      END IF;
      v_float_before := v_float.collected_today;
      v_float_after := v_float.collected_today + v_token.amount;
      UPDATE agent_float_limits SET collected_today = v_float_after, updated_at = now() WHERE agent_id = p_agent_id;
    ELSE
      v_float_before := 0; v_float_after := 0;
    END IF;
  ELSE
    SELECT collected_today INTO v_float_before FROM agent_float_limits WHERE agent_id = p_agent_id;
    v_float_before := COALESCE(v_float_before, 0); v_float_after := v_float_before;
  END IF;

  UPDATE payment_tokens SET used = true, used_at = now() WHERE id = v_token.id;

  INSERT INTO agent_collections (agent_id, tenant_id, token_id, amount, payment_method, float_before, float_after)
  VALUES (p_agent_id, v_token.tenant_id, v_token.id, v_token.amount, p_payment_method::collection_payment_method, v_float_before, v_float_after)
  RETURNING id INTO v_collection_id;

  RETURN jsonb_build_object('success', true, 'collection_id', v_collection_id, 'amount', v_token.amount,
    'tenant_id', v_token.tenant_id, 'float_before', v_float_before, 'float_after', v_float_after, 'payment_method', p_payment_method);
END;
$$;
