
ALTER TABLE public.kyc_profiles DROP CONSTRAINT IF EXISTS kyc_profiles_level_source_check;
ALTER TABLE public.kyc_profiles ADD CONSTRAINT kyc_profiles_level_source_check
  CHECK (level_source = ANY (ARRAY['default','grandfathered','upgraded','manual','downgraded','activity']));

UPDATE public.kyc_level_config SET description = 'Default level for new signups. Phone + PIN + T&Cs.', updated_at = now() WHERE level = 1;
UPDATE public.kyc_level_config SET description = 'Auto-unlocked by in-app activity: 1+ verified house listing, sub-agent, or funded rent request.', updated_at = now() WHERE level = 2;
UPDATE public.kyc_level_config SET description = 'Auto-unlocked at 5+ verified in-app activities (house listings + sub-agents + funded rent requests).', updated_at = now() WHERE level = 3;

CREATE OR REPLACE FUNCTION public.evaluate_kyc_activity(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_houses int:=0; v_subagents int:=0; v_rents int:=0; v_total int:=0; v_level smallint:=1;
BEGIN
  SELECT COUNT(*) INTO v_houses FROM public.house_listings
    WHERE agent_id = p_user_id AND COALESCE(verified,false) = true;
  SELECT COUNT(*) INTO v_subagents FROM public.agent_subagents
    WHERE parent_agent_id = p_user_id AND verified_at IS NOT NULL;
  SELECT COUNT(*) INTO v_rents FROM public.rent_requests
    WHERE agent_id = p_user_id AND status IN ('funded','repaying','completed');
  v_total := v_houses + v_subagents + v_rents;
  IF v_total >= 5 THEN v_level := 3;
  ELSIF v_total >= 1 THEN v_level := 2;
  ELSE v_level := 1; END IF;
  RETURN jsonb_build_object('verified_houses',v_houses,'verified_subagents',v_subagents,
    'funded_rent_requests',v_rents,'total_activity',v_total,'suggested_level',v_level);
END $$;
GRANT EXECUTE ON FUNCTION public.evaluate_kyc_activity(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.evaluate_kyc_upgrade_eligibility(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_activity jsonb; v_suggested smallint; v_current smallint:=1; v_missing text[]:=ARRAY[]::text[];
BEGIN
  v_activity := public.evaluate_kyc_activity(p_user_id);
  v_suggested := (v_activity->>'suggested_level')::smallint;
  SELECT COALESCE(kyc_level,1) INTO v_current FROM public.kyc_profiles WHERE user_id = p_user_id;
  IF v_suggested < 2 THEN v_missing := array_append(v_missing,'needs_1_verified_house_subagent_or_funded_rent_request'); END IF;
  IF v_suggested < 3 THEN v_missing := array_append(v_missing,'needs_5_total_verified_activities_for_level_3'); END IF;
  RETURN v_activity || jsonb_build_object('current_level',v_current,'eligible',v_suggested>v_current,'missing',to_jsonb(v_missing));
END $$;

CREATE OR REPLACE FUNCTION public.auto_upgrade_kyc_from_activity(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_suggested smallint; v_current smallint:=1; v_frozen boolean:=false;
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN RETURN; END IF;
  SELECT (public.evaluate_kyc_activity(p_user_id)->>'suggested_level')::smallint INTO v_suggested;
  SELECT COALESCE(kyc_level,1), COALESCE(frozen,false) INTO v_current, v_frozen
    FROM public.kyc_profiles WHERE user_id = p_user_id;
  IF v_frozen THEN RETURN; END IF;
  IF v_suggested IS NULL OR v_suggested <= COALESCE(v_current,1) THEN RETURN; END IF;
  INSERT INTO public.kyc_profiles (user_id, kyc_level, level_source, upgraded_at, updated_at)
    VALUES (p_user_id, v_suggested, 'activity', now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET kyc_level = EXCLUDED.kyc_level, level_source='activity', upgraded_at=now(), updated_at=now()
    WHERE public.kyc_profiles.frozen = false
      AND public.kyc_profiles.kyc_level < EXCLUDED.kyc_level;
END $$;
GRANT EXECUTE ON FUNCTION public.auto_upgrade_kyc_from_activity(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_kyc_upgrade_from_house_listing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND COALESCE(NEW.verified,false) AND NOT COALESCE(OLD.verified,false) THEN
    PERFORM public.auto_upgrade_kyc_from_activity(NEW.agent_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_kyc_upgrade_from_house_listing ON public.house_listings;
CREATE TRIGGER trg_kyc_upgrade_from_house_listing
AFTER UPDATE OF verified ON public.house_listings
FOR EACH ROW EXECUTE FUNCTION public.trg_kyc_upgrade_from_house_listing();

CREATE OR REPLACE FUNCTION public.trg_kyc_upgrade_from_subagent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.parent_agent_id IS NOT NULL AND NEW.verified_at IS NOT NULL
     AND (TG_OP='INSERT' OR OLD.verified_at IS DISTINCT FROM NEW.verified_at) THEN
    PERFORM public.auto_upgrade_kyc_from_activity(NEW.parent_agent_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_kyc_upgrade_from_subagent ON public.agent_subagents;
CREATE TRIGGER trg_kyc_upgrade_from_subagent
AFTER INSERT OR UPDATE OF verified_at ON public.agent_subagents
FOR EACH ROW EXECUTE FUNCTION public.trg_kyc_upgrade_from_subagent();

CREATE OR REPLACE FUNCTION public.trg_kyc_upgrade_from_rent_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND NEW.status IN ('funded','repaying','completed')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.auto_upgrade_kyc_from_activity(NEW.agent_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_kyc_upgrade_from_rent_request ON public.rent_requests;
CREATE TRIGGER trg_kyc_upgrade_from_rent_request
AFTER UPDATE OF status ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.trg_kyc_upgrade_from_rent_request();

DO $$ DECLARE r record; BEGIN
  FOR r IN
    SELECT DISTINCT s.uid FROM (
      SELECT agent_id AS uid FROM public.house_listings WHERE verified=true AND agent_id IS NOT NULL
      UNION ALL SELECT parent_agent_id FROM public.agent_subagents WHERE verified_at IS NOT NULL AND parent_agent_id IS NOT NULL
      UNION ALL SELECT agent_id FROM public.rent_requests WHERE status IN ('funded','repaying','completed') AND agent_id IS NOT NULL
    ) s JOIN auth.users u ON u.id = s.uid
  LOOP
    PERFORM public.auto_upgrade_kyc_from_activity(r.uid);
  END LOOP;
END $$;
