
-- =====================================================================
-- Tiered KYC + Fraud Prevention (retry with correct column name)
-- =====================================================================

CREATE TABLE public.kyc_level_config (
  level smallint PRIMARY KEY,
  label text NOT NULL,
  daily_withdrawal_cap_ugx bigint NOT NULL,
  daily_withdrawal_count_cap int NOT NULL,
  max_single_transfer_ugx bigint NOT NULL,
  can_register_merchant boolean NOT NULL DEFAULT false,
  can_be_agent boolean NOT NULL DEFAULT false,
  can_high_value_transfer boolean NOT NULL DEFAULT false,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.kyc_level_config TO authenticated, anon;
GRANT ALL ON public.kyc_level_config TO service_role;
ALTER TABLE public.kyc_level_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kyc_level_config readable by anyone"
  ON public.kyc_level_config FOR SELECT USING (true);
CREATE POLICY "kyc_level_config managed by super_admin"
  ON public.kyc_level_config FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'super_admin'))
  WITH CHECK (public.has_role(auth.uid(),'super_admin'));

INSERT INTO public.kyc_level_config
  (level,label,daily_withdrawal_cap_ugx,daily_withdrawal_count_cap,max_single_transfer_ugx,can_register_merchant,can_be_agent,can_high_value_transfer,description)
VALUES
  (1,'Basic',      20000,   1,    20000, false,false,false,'Default level for new signups. Phone + PIN + T&Cs.'),
  (2,'Verified',   500000,  10,  500000, true, true, true, 'NIN + selfie + manual approval (future).'),
  (3,'Enhanced',   999999999, 999, 999999999, true, true, true, 'Enhanced KYC with source of funds.');

CREATE TABLE public.kyc_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  kyc_level smallint NOT NULL DEFAULT 1 REFERENCES public.kyc_level_config(level),
  level_source text NOT NULL DEFAULT 'default'
    CHECK (level_source IN ('default','grandfathered','upgraded','manual','downgraded')),
  frozen boolean NOT NULL DEFAULT false,
  frozen_reason text,
  frozen_at timestamptz,
  frozen_by uuid,
  daily_withdrawal_cap_ugx bigint,
  daily_withdrawal_count_cap int,
  nin_number text,
  nin_verified_at timestamptz,
  selfie_url text,
  selfie_verified_at timestamptz,
  upgraded_at timestamptz,
  last_reviewed_at timestamptz,
  last_reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kyc_profiles_level ON public.kyc_profiles(kyc_level);
CREATE INDEX idx_kyc_profiles_frozen ON public.kyc_profiles(frozen) WHERE frozen = true;
GRANT SELECT, INSERT, UPDATE ON public.kyc_profiles TO authenticated;
GRANT ALL ON public.kyc_profiles TO service_role;
ALTER TABLE public.kyc_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own kyc profile"
  ON public.kyc_profiles FOR SELECT TO authenticated
  USING (user_id = auth.uid()
      OR public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager')
      OR public.has_role(auth.uid(),'cfo')
      OR public.has_role(auth.uid(),'operations'));
CREATE POLICY "Admins manage kyc profiles"
  ON public.kyc_profiles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager'))
  WITH CHECK (public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager'));

CREATE TABLE public.kyc_risk_scores (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  score int NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  tier text NOT NULL DEFAULT 'low' CHECK (tier IN ('low','elevated','high','critical')),
  factors jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kyc_risk_scores_tier ON public.kyc_risk_scores(tier);
GRANT SELECT ON public.kyc_risk_scores TO authenticated;
GRANT ALL ON public.kyc_risk_scores TO service_role;
ALTER TABLE public.kyc_risk_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own risk score"
  ON public.kyc_risk_scores FOR SELECT TO authenticated
  USING (user_id = auth.uid()
      OR public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager')
      OR public.has_role(auth.uid(),'cfo')
      OR public.has_role(auth.uid(),'operations'));

CREATE TABLE public.kyc_risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'otp_excess','pin_fail_burst','rapid_withdraw','device_multi_account',
    'velocity_burst','suspicious_pattern','login_anomaly','signup_device_reuse'
  )),
  severity smallint NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 5),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kyc_risk_events_user_time ON public.kyc_risk_events(user_id, occurred_at DESC);
CREATE INDEX idx_kyc_risk_events_type ON public.kyc_risk_events(event_type, occurred_at DESC);
GRANT SELECT ON public.kyc_risk_events TO authenticated;
GRANT ALL ON public.kyc_risk_events TO service_role;
ALTER TABLE public.kyc_risk_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own risk events"
  ON public.kyc_risk_events FOR SELECT TO authenticated
  USING (user_id = auth.uid()
      OR public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager')
      OR public.has_role(auth.uid(),'cfo')
      OR public.has_role(auth.uid(),'operations'));

CREATE TABLE public.kyc_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  severity smallint NOT NULL DEFAULT 3 CHECK (severity BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  resolution text,
  resolved_by uuid,
  resolved_at timestamptz,
  triggering_event_id uuid REFERENCES public.kyc_risk_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kyc_flags_status ON public.kyc_flags(status) WHERE status IN ('open','reviewing');
CREATE INDEX idx_kyc_flags_user ON public.kyc_flags(user_id, created_at DESC);
GRANT SELECT ON public.kyc_flags TO authenticated;
GRANT ALL ON public.kyc_flags TO service_role;
ALTER TABLE public.kyc_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own flags"
  ON public.kyc_flags FOR SELECT TO authenticated
  USING (user_id = auth.uid()
      OR public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager')
      OR public.has_role(auth.uid(),'cfo')
      OR public.has_role(auth.uid(),'operations'));
CREATE POLICY "Admins manage flags"
  ON public.kyc_flags FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager'))
  WITH CHECK (public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager'));

CREATE TABLE public.kyc_level_change_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('upgrade','downgrade','freeze','unfreeze','set_cap','grandfather')),
  old_level smallint,
  new_level smallint,
  actor_id uuid,
  reason text NOT NULL CHECK (char_length(reason) >= 10),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kyc_audit_user ON public.kyc_level_change_audit(user_id, created_at DESC);
GRANT SELECT ON public.kyc_level_change_audit TO authenticated;
GRANT ALL ON public.kyc_level_change_audit TO service_role;
ALTER TABLE public.kyc_level_change_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own kyc audit"
  ON public.kyc_level_change_audit FOR SELECT TO authenticated
  USING (user_id = auth.uid()
      OR public.has_role(auth.uid(),'super_admin')
      OR public.has_role(auth.uid(),'manager')
      OR public.has_role(auth.uid(),'cfo')
      OR public.has_role(auth.uid(),'operations'));

CREATE TRIGGER trg_kyc_profiles_updated_at BEFORE UPDATE ON public.kyc_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_kyc_risk_scores_updated_at BEFORE UPDATE ON public.kyc_risk_scores
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_kyc_flags_updated_at BEFORE UPDATE ON public.kyc_flags
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_kyc_level_config_updated_at BEFORE UPDATE ON public.kyc_level_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.get_kyc_effective_limits(p_user_id uuid)
RETURNS TABLE(
  kyc_level smallint,
  frozen boolean,
  daily_withdrawal_cap_ugx bigint,
  daily_withdrawal_count_cap int,
  max_single_transfer_ugx bigint,
  can_register_merchant boolean,
  can_be_agent boolean,
  can_high_value_transfer boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE(p.kyc_level, 1)::smallint,
    COALESCE(p.frozen, false),
    COALESCE(p.daily_withdrawal_cap_ugx, c.daily_withdrawal_cap_ugx),
    COALESCE(p.daily_withdrawal_count_cap, c.daily_withdrawal_count_cap),
    c.max_single_transfer_ugx,
    c.can_register_merchant,
    c.can_be_agent,
    c.can_high_value_transfer
  FROM public.kyc_level_config c
  LEFT JOIN public.kyc_profiles p ON p.user_id = p_user_id
  WHERE c.level = COALESCE(p.kyc_level, 1);
$$;
GRANT EXECUTE ON FUNCTION public.get_kyc_effective_limits(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_kyc_withdrawal_cap()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limits record;
  v_today_amount bigint;
  v_today_count int;
BEGIN
  IF NEW.user_id IS NULL OR NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_limits FROM public.get_kyc_effective_limits(NEW.user_id);

  IF v_limits.frozen THEN
    RAISE EXCEPTION 'Account frozen pending review. Contact support.'
      USING ERRCODE = 'check_violation', HINT = 'kyc_frozen';
  END IF;

  SELECT
    COALESCE(SUM(amount),0)::bigint,
    COUNT(*)::int
  INTO v_today_amount, v_today_count
  FROM public.withdrawal_requests
  WHERE user_id = NEW.user_id
    AND created_at >= date_trunc('day', now())
    AND status NOT IN ('rejected','cancelled','failed');

  IF (v_today_amount + NEW.amount) > v_limits.daily_withdrawal_cap_ugx THEN
    RAISE EXCEPTION 'KYC Level % daily withdrawal cap of UGX % exceeded (today: UGX %, requested: UGX %). Verify identity to raise limits.',
      v_limits.kyc_level, v_limits.daily_withdrawal_cap_ugx, v_today_amount, NEW.amount
      USING ERRCODE = 'check_violation', HINT = 'kyc_daily_amount_cap';
  END IF;

  IF (v_today_count + 1) > v_limits.daily_withdrawal_count_cap THEN
    RAISE EXCEPTION 'KYC Level % allows only % withdrawal(s) per day. Verify identity to raise limits.',
      v_limits.kyc_level, v_limits.daily_withdrawal_count_cap
      USING ERRCODE = 'check_violation', HINT = 'kyc_daily_count_cap';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_enforce_kyc_withdrawal_cap
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_kyc_withdrawal_cap();

CREATE OR REPLACE FUNCTION public.recompute_kyc_risk_score(p_user_id uuid)
RETURNS public.kyc_risk_scores LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_event_score int := 0;
  v_device_score int := 0;
  v_rapid_score int := 0;
  v_score int := 0;
  v_tier text;
  v_factors jsonb;
  v_row public.kyc_risk_scores;
  v_device_peers int := 0;
  v_signup_at timestamptz;
  v_rapid_withdraw_count int := 0;
BEGIN
  SELECT COALESCE(SUM(severity * 5),0) INTO v_event_score
  FROM public.kyc_risk_events
  WHERE user_id = p_user_id
    AND occurred_at > now() - interval '30 days';

  SELECT COUNT(DISTINCT s2.user_id) INTO v_device_peers
  FROM public.user_device_sessions s1
  JOIN public.user_device_sessions s2 ON s2.device_hash = s1.device_hash
  WHERE s1.user_id = p_user_id
    AND s2.user_id <> p_user_id
    AND s1.device_hash IS NOT NULL;
  IF v_device_peers >= 4 THEN v_device_score := 40;
  ELSIF v_device_peers >= 2 THEN v_device_score := 20;
  ELSIF v_device_peers >= 1 THEN v_device_score := 8;
  END IF;

  SELECT created_at INTO v_signup_at FROM auth.users WHERE id = p_user_id;
  IF v_signup_at IS NOT NULL AND v_signup_at > now() - interval '24 hours' THEN
    SELECT COUNT(*) INTO v_rapid_withdraw_count
    FROM public.withdrawal_requests
    WHERE user_id = p_user_id;
    IF v_rapid_withdraw_count > 0 THEN v_rapid_score := 15; END IF;
  END IF;

  v_score := LEAST(100, v_event_score + v_device_score + v_rapid_score);
  v_tier := CASE
    WHEN v_score >= 75 THEN 'critical'
    WHEN v_score >= 50 THEN 'high'
    WHEN v_score >= 25 THEN 'elevated'
    ELSE 'low'
  END;

  v_factors := jsonb_build_object(
    'event_score', v_event_score,
    'device_score', v_device_score,
    'rapid_score', v_rapid_score,
    'device_peers', v_device_peers,
    'rapid_withdraw_count', v_rapid_withdraw_count
  );

  INSERT INTO public.kyc_risk_scores(user_id, score, tier, factors, last_computed_at)
  VALUES (p_user_id, v_score, v_tier, v_factors, now())
  ON CONFLICT (user_id) DO UPDATE
    SET score = EXCLUDED.score,
        tier = EXCLUDED.tier,
        factors = EXCLUDED.factors,
        last_computed_at = EXCLUDED.last_computed_at,
        updated_at = now()
  RETURNING * INTO v_row;

  IF v_tier IN ('high','critical') THEN
    UPDATE public.kyc_profiles
       SET frozen = true,
           frozen_reason = COALESCE(frozen_reason, 'Auto-frozen: risk tier ' || v_tier),
           frozen_at = COALESCE(frozen_at, now())
     WHERE user_id = p_user_id AND frozen = false;

    INSERT INTO public.kyc_flags(user_id, reason, severity, status)
    SELECT p_user_id,
           'Automatic flag: risk tier ' || v_tier || ' (score ' || v_score || ')',
           CASE WHEN v_tier = 'critical' THEN 5 ELSE 4 END,
           'open'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.kyc_flags
      WHERE user_id = p_user_id AND status IN ('open','reviewing')
    );
  END IF;

  RETURN v_row;
END $$;
GRANT EXECUTE ON FUNCTION public.recompute_kyc_risk_score(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.evaluate_kyc_upgrade_eligibility(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_trust int := 0;
  v_tier text := 'low';
  v_open_flags int := 0;
  v_age_days int := 0;
  v_tx_count int := 0;
BEGIN
  SELECT COALESCE(score,0) INTO v_trust FROM public.welile_trust_score_cache WHERE user_id = p_user_id;
  SELECT COALESCE(tier,'low') INTO v_tier FROM public.kyc_risk_scores WHERE user_id = p_user_id;
  SELECT COUNT(*) INTO v_open_flags FROM public.kyc_flags
    WHERE user_id = p_user_id AND status IN ('open','reviewing');
  SELECT EXTRACT(DAY FROM now() - created_at)::int INTO v_age_days FROM auth.users WHERE id = p_user_id;
  SELECT COUNT(*) INTO v_tx_count FROM public.withdrawal_requests
    WHERE user_id = p_user_id AND status = 'approved';

  IF v_trust < 40 THEN v_missing := array_append(v_missing, 'trust_score_below_40'); END IF;
  IF v_tier <> 'low' THEN v_missing := array_append(v_missing, 'risk_tier_not_low'); END IF;
  IF v_open_flags > 0 THEN v_missing := array_append(v_missing, 'open_flags'); END IF;
  IF COALESCE(v_age_days,0) < 14 THEN v_missing := array_append(v_missing, 'account_age_below_14_days'); END IF;
  IF v_tx_count < 3 THEN v_missing := array_append(v_missing, 'fewer_than_3_successful_transactions'); END IF;
  IF EXISTS (SELECT 1 FROM public.fraud_identity_blocks
             WHERE identifier_type='user_id' AND identifier_value = p_user_id::text) THEN
    v_missing := array_append(v_missing, 'fraud_identity_block');
  END IF;

  RETURN jsonb_build_object(
    'eligible', array_length(v_missing,1) IS NULL,
    'missing', to_jsonb(v_missing),
    'trust_score', v_trust,
    'risk_tier', v_tier,
    'open_flags', v_open_flags,
    'account_age_days', v_age_days,
    'successful_tx', v_tx_count
  );
END $$;
GRANT EXECUTE ON FUNCTION public.evaluate_kyc_upgrade_eligibility(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_set_kyc_level(
  p_user_id uuid, p_new_level smallint, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old smallint;
BEGIN
  IF NOT (public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'manager')) THEN
    RAISE EXCEPTION 'Only super_admin/manager can change KYC level';
  END IF;
  IF char_length(p_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  SELECT kyc_level INTO v_old FROM public.kyc_profiles WHERE user_id = p_user_id;

  INSERT INTO public.kyc_profiles(user_id, kyc_level, level_source, upgraded_at, last_reviewed_at, last_reviewed_by)
  VALUES (p_user_id, p_new_level, 'manual', now(), now(), auth.uid())
  ON CONFLICT (user_id) DO UPDATE
    SET kyc_level = EXCLUDED.kyc_level,
        level_source = 'manual',
        upgraded_at = now(),
        last_reviewed_at = now(),
        last_reviewed_by = auth.uid();

  INSERT INTO public.kyc_level_change_audit(user_id, action, old_level, new_level, actor_id, reason)
  VALUES (p_user_id,
          CASE WHEN p_new_level > COALESCE(v_old,1) THEN 'upgrade' ELSE 'downgrade' END,
          v_old, p_new_level, auth.uid(), p_reason);
END $$;
GRANT EXECUTE ON FUNCTION public.admin_set_kyc_level(uuid,smallint,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_freeze_kyc_account(
  p_user_id uuid, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'manager')) THEN
    RAISE EXCEPTION 'Only super_admin/manager can freeze accounts';
  END IF;
  IF char_length(p_reason) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;

  INSERT INTO public.kyc_profiles(user_id, frozen, frozen_reason, frozen_at, frozen_by)
  VALUES (p_user_id, true, p_reason, now(), auth.uid())
  ON CONFLICT (user_id) DO UPDATE
    SET frozen = true, frozen_reason = p_reason, frozen_at = now(), frozen_by = auth.uid();

  INSERT INTO public.kyc_level_change_audit(user_id, action, actor_id, reason)
  VALUES (p_user_id, 'freeze', auth.uid(), p_reason);
END $$;
GRANT EXECUTE ON FUNCTION public.admin_freeze_kyc_account(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_unfreeze_kyc_account(
  p_user_id uuid, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'manager')) THEN
    RAISE EXCEPTION 'Only super_admin/manager can unfreeze accounts';
  END IF;
  IF char_length(p_reason) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;

  UPDATE public.kyc_profiles
     SET frozen = false, frozen_reason = NULL, frozen_at = NULL, frozen_by = NULL,
         last_reviewed_at = now(), last_reviewed_by = auth.uid()
   WHERE user_id = p_user_id;

  INSERT INTO public.kyc_level_change_audit(user_id, action, actor_id, reason)
  VALUES (p_user_id, 'unfreeze', auth.uid(), p_reason);
END $$;
GRANT EXECUTE ON FUNCTION public.admin_unfreeze_kyc_account(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_resolve_kyc_flag(
  p_flag_id uuid, p_status text, p_resolution text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'manager')) THEN
    RAISE EXCEPTION 'Only super_admin/manager can resolve flags';
  END IF;
  IF p_status NOT IN ('resolved','dismissed','reviewing') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  IF char_length(COALESCE(p_resolution,'')) < 10 THEN
    RAISE EXCEPTION 'Resolution must be at least 10 characters';
  END IF;

  UPDATE public.kyc_flags
     SET status = p_status,
         resolution = p_resolution,
         resolved_by = auth.uid(),
         resolved_at = CASE WHEN p_status IN ('resolved','dismissed') THEN now() ELSE resolved_at END
   WHERE id = p_flag_id;
END $$;
GRANT EXECUTE ON FUNCTION public.admin_resolve_kyc_flag(uuid,text,text) TO authenticated;

-- Seed + grandfather
INSERT INTO public.kyc_profiles(user_id, kyc_level, level_source)
SELECT u.id, 1, 'default'
FROM auth.users u
LEFT JOIN public.kyc_profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL;

WITH eligible AS (
  SELECT wr.user_id
  FROM public.withdrawal_requests wr
  WHERE wr.status = 'approved'
  GROUP BY wr.user_id
  HAVING COUNT(*) >= 5
),
filtered AS (
  SELECT e.user_id
  FROM eligible e
  WHERE NOT EXISTS (
    SELECT 1 FROM public.fraud_identity_blocks fb
    WHERE fb.identifier_type = 'user_id' AND fb.identifier_value = e.user_id::text
  )
)
UPDATE public.kyc_profiles p
   SET kyc_level = 2,
       level_source = 'grandfathered',
       upgraded_at = now()
  FROM filtered f
 WHERE p.user_id = f.user_id AND p.kyc_level = 1;

INSERT INTO public.kyc_level_change_audit(user_id, action, old_level, new_level, actor_id, reason, metadata)
SELECT user_id, 'grandfather', 1, 2, NULL,
       'Automatic grandfather: >=5 approved withdrawals, no fraud block',
       jsonb_build_object('backfill_at', now())
FROM public.kyc_profiles
WHERE level_source = 'grandfathered';

CREATE OR REPLACE FUNCTION public.seed_kyc_profile_on_signup()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.kyc_profiles(user_id, kyc_level, level_source)
  VALUES (NEW.id, 1, 'default')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_seed_kyc_profile ON auth.users;
CREATE TRIGGER trg_seed_kyc_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.seed_kyc_profile_on_signup();
