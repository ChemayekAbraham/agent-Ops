-- Phase 2: Atomic Tenant Registration
-- Replaces brittle sequential frontend inserts with a single transactional RPC.

CREATE OR REPLACE FUNCTION public.register_tenant_details(
    p_tenant_id uuid,
    p_agent_id uuid,
    p_landlord_name text,
    p_landlord_phone text,
    p_property_address text,
    p_monthly_rent integer,
    p_mobile_money_number text,
    p_latitude double precision,
    p_longitude double precision,
    p_lc1_name text,
    p_lc1_phone text,
    p_lc1_village text
) RETURNS jsonb AS $$
DECLARE
    v_landlord_id uuid;
    v_lc1_id uuid := NULL;
    v_rent_request_id uuid;
BEGIN
    -- 1. Insert Landlord
    INSERT INTO public.landlords (
        tenant_id, name, phone, property_address, monthly_rent, mobile_money_number, 
        latitude, longitude, location_captured_at, location_captured_by, registered_by
    ) VALUES (
        p_tenant_id, p_landlord_name, p_landlord_phone, p_property_address, p_monthly_rent, p_mobile_money_number,
        p_latitude, p_longitude, CASE WHEN p_latitude IS NOT NULL THEN NOW() ELSE NULL END, 
        p_agent_id, p_agent_id
    ) RETURNING id INTO v_landlord_id;

    -- 2. Insert or get LC1
    IF p_lc1_name IS NOT NULL AND TRIM(p_lc1_name) != '' THEN
        SELECT id INTO v_lc1_id FROM public.lc1_chairpersons WHERE village = p_lc1_village LIMIT 1;
        IF v_lc1_id IS NULL THEN
            INSERT INTO public.lc1_chairpersons (name, phone, village)
            VALUES (p_lc1_name, p_lc1_phone, p_lc1_village)
            RETURNING id INTO v_lc1_id;
        END IF;
    END IF;

    -- 3. Insert Rent Request
    INSERT INTO public.rent_requests (
        tenant_id, agent_id, landlord_id, lc1_id, rent_amount, duration_days,
        access_fee, request_fee, total_repayment, daily_repayment, status, house_category,
        request_latitude, request_longitude
    ) VALUES (
        p_tenant_id, p_agent_id, v_landlord_id, v_lc1_id, p_monthly_rent, 30,
        0, 0, 0, 0, 'pending', 'single-room',
        p_latitude, p_longitude
    ) RETURNING id INTO v_rent_request_id;

    -- 4. Update Profile
    UPDATE public.profiles
    SET rent_discount_active = true, monthly_rent = p_monthly_rent
    WHERE id = p_tenant_id;

    RETURN jsonb_build_object('success', true, 'rent_request_id', v_rent_request_id);
EXCEPTION WHEN unique_violation THEN
    -- If landlord exists, throw clean error
    RAISE EXCEPTION 'Tenant is already linked to a landlord.';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
