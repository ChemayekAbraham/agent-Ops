
CREATE OR REPLACE FUNCTION public.enforce_daytime_house_listing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hour int;
  v_is_agent boolean;
  v_is_bypass boolean;
  v_photo_count int;
BEGIN
  v_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'))::int;

  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_agent := has_role(v_uid, 'agent'::app_role)
             OR has_role(v_uid, 'sub_agent'::app_role)
             OR has_role(v_uid, 'senior_agent'::app_role);

  v_is_bypass := has_role(v_uid, 'manager'::app_role)
              OR has_role(v_uid, 'ceo'::app_role)
              OR has_role(v_uid, 'cto'::app_role)
              OR has_role(v_uid, 'coo'::app_role)
              OR has_role(v_uid, 'cfo'::app_role)
              OR has_role(v_uid, 'cmo'::app_role)
              OR has_role(v_uid, 'hr'::app_role)
              OR has_role(v_uid, 'crm'::app_role)
              OR has_role(v_uid, 'tenant_ops'::app_role)
              OR has_role(v_uid, 'landlord_ops'::app_role)
              OR has_role(v_uid, 'agent_ops'::app_role)
              OR has_role(v_uid, 'partner_ops'::app_role)
              OR has_role(v_uid, 'financial_ops'::app_role);

  IF v_is_agent AND NOT v_is_bypass AND (v_hour < 6 OR v_hour >= 18) THEN
    v_photo_count := COALESCE(array_length(NEW.image_urls, 1), 0);

    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
      VALUES (
        v_uid,
        'house_listing_night_block',
        'house_listings',
        COALESCE(NEW.id::text, gen_random_uuid()::text),
        jsonb_build_object(
          'reason', 'night_listing_attempt',
          'eat_hour', v_hour,
          'attempted_at', now(),
          'landlord_id', NEW.landlord_id,
          'agent_id', NEW.agent_id,
          'title', NEW.title,
          'short_code', NEW.short_code,
          'house_category', NEW.house_category,
          'number_of_rooms', NEW.number_of_rooms,
          'monthly_rent', NEW.monthly_rent,
          'daily_rate', NEW.daily_rate,
          'region', NEW.region,
          'district', NEW.district,
          'sub_county', NEW.sub_county,
          'village', NEW.village,
          'address', NEW.address,
          'latitude', NEW.latitude,
          'longitude', NEW.longitude,
          'photo_count', v_photo_count,
          'photo_urls', to_jsonb(NEW.image_urls),
          'video_url', NEW.video_url,
          'has_video', (NEW.video_url IS NOT NULL AND length(NEW.video_url) > 0)
        )
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RAISE EXCEPTION 'House listing is only allowed between 6:00 AM and 6:00 PM (EAT). Please try again during the day.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
