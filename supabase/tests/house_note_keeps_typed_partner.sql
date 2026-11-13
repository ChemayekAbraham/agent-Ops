-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com

-- House-attached promissory notes keep the partner details that were typed in (migration 20261123090000).
-- Run on a copy of the production-schema clone with supabase/tests/self_support_direct/harness.sql loaded
-- (template ssd_base), after the migration:
--   psql -d <copy> -f supabase/migrations/20261123090000_house_note_keeps_typed_partner.sql
--   psql -d <copy> -At -f supabase/tests/house_note_keeps_typed_partner.sql
-- Every line printed should end in PASS. Before the migration N01, N02 and N03 fail (the bug).
SET client_min_messages = warning;

CREATE OR REPLACE FUNCTION tt.hn_house() RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := gen_random_uuid(); ag uuid := tt.person('HN Listing Agent' || nextval('tt.seq'), ARRAY['agent']); l uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.landlords (id, name, phone, verified, verified_mobile_money_number, property_address)
  VALUES (l, 'HN Landlord', tt.phone(), true, NULL, 'Kampala');
  INSERT INTO public.house_listings (id, agent_id, landlord_id, title, monthly_rent, region, address, verified, status, is_hidden)
  VALUES (v, ag, l, 'Room', 200000, 'Central', 'Kampala', true, 'available', false);
  RETURN v;
END $$;

-- An approved proxy agent with the given roles (an 'agent_off' entry adds the agent role switched off).
CREATE OR REPLACE FUNCTION tt.hn_proxy(p_name text, p_roles text[]) RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := tt.person(p_name, array_remove(p_roles, 'agent_off'));
BEGIN
  IF 'agent_off' = ANY (p_roles) THEN
    INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v, 'agent', false);
  END IF;
  INSERT INTO public.proxy_agent_identity (agent_user_id, nin, full_name, status)
  VALUES (v, 'CM' || lpad(nextval('tt.seq')::text, 12, '0'), p_name, 'approved');
  RETURN v;
END $$;

-- Writes a house note as p_caller for the typed partner; returns the saved note.
CREATE OR REPLACE FUNCTION tt.hn_write(p_caller uuid, p_name text, p_wa text, p_email text, p_self boolean DEFAULT NULL)
RETURNS public.promissory_notes LANGUAGE plpgsql AS $$
DECLARE h uuid := tt.hn_house(); v_payload jsonb; n public.promissory_notes;
BEGIN
  v_payload := jsonb_build_object('partner_name', p_name, 'whatsapp_number', p_wa, 'email', p_email,
                                  'amount', 200000, 'contribution_type', 'once_off');
  IF p_self IS NOT NULL THEN v_payload := v_payload || jsonb_build_object('self_booking', p_self); END IF;
  PERFORM tt.as_user(p_caller);
  PERFORM public.agent_create_promissory_note_for_houses(v_payload, ARRAY[h]);
  PERFORM tt.as_user(NULL);
  SELECT * INTO n FROM public.promissory_notes WHERE agent_id = p_caller ORDER BY created_at DESC LIMIT 1;
  RETURN n;
END $$;

CALL tt.run('N01', 'Approved proxy agent with only the supporter role: the typed partner is kept', $t$
DECLARE px uuid := tt.hn_proxy('Collins Proxy', ARRAY['supporter']); n public.promissory_notes;
BEGIN
  n := tt.hn_write(px, 'Rose Typed Partner', '0700111222', 'rose.partner@test.local');
  ASSERT n.partner_name = 'Rose Typed Partner', 'name ' || n.partner_name;
  ASSERT n.whatsapp_number = '0700111222', 'whatsapp ' || n.whatsapp_number;
  ASSERT n.email = 'rose.partner@test.local', 'email ' || coalesce(n.email, '-');
  ASSERT n.partner_user_id IS DISTINCT FROM px, 'linked to the proxy agent';
END $t$);

CALL tt.run('N02', 'Approved proxy agent whose agent role is switched off: the typed partner is kept', $t$
DECLARE px uuid := tt.hn_proxy('Menya Proxy', ARRAY['supporter', 'agent_off']); n public.promissory_notes;
BEGIN
  n := tt.hn_write(px, 'Okello Typed Partner', '0700333444', NULL);
  ASSERT n.partner_name = 'Okello Typed Partner', 'name ' || n.partner_name;
  ASSERT n.whatsapp_number = '0700333444', 'whatsapp ' || n.whatsapp_number;
  ASSERT n.partner_user_id IS DISTINCT FROM px, 'linked to the proxy agent';
END $t$);

CALL tt.run('N03', 'Approved proxy agent with no roles at all may write a house note for a partner', $t$
DECLARE px uuid := tt.hn_proxy('Bare Proxy', ARRAY[]::text[]); n public.promissory_notes;
BEGIN
  n := tt.hn_write(px, 'Akello Typed Partner', '0700555666', NULL);
  ASSERT n.partner_name = 'Akello Typed Partner', 'name ' || coalesce(n.partner_name, '(no note)');
END $t$);

CALL tt.run('N04', 'A typed number that belongs to a registered partner links the note to that partner, not the proxy', $t$
DECLARE px uuid := tt.hn_proxy('Linker Proxy', ARRAY['supporter']);
        pa uuid := tt.person('Registered Partner', ARRAY['supporter'], '0700777888'); n public.promissory_notes;
BEGIN
  n := tt.hn_write(px, 'Registered Partner', '0700777888', NULL);
  ASSERT n.partner_user_id = pa, 'linked to ' || coalesce(n.partner_user_id::text, 'nobody');
END $t$);

CALL tt.run('N05', 'Funder screen booking for themselves (self_booking) uses their own details and links the note to them', $t$
DECLARE px uuid := tt.hn_proxy('Funding Proxy', ARRAY['supporter']); n public.promissory_notes; pr public.profiles;
BEGIN
  SELECT * INTO pr FROM public.profiles WHERE id = px;
  n := tt.hn_write(px, 'Someone Else Typed', '0700999000', NULL, true);
  ASSERT n.partner_name = pr.full_name, 'name ' || n.partner_name;
  ASSERT n.partner_user_id = px, 'not linked to the funder';
END $t$);

CALL tt.run('N06', 'A plain supporter (not an agent, not a proxy agent) still books only for themselves', $t$
DECLARE su uuid := tt.person('Plain Funder', ARRAY['supporter']); n public.promissory_notes; pr public.profiles;
BEGIN
  SELECT * INTO pr FROM public.profiles WHERE id = su;
  n := tt.hn_write(su, 'Someone Else Typed', '0700121212', NULL);
  ASSERT n.partner_name = pr.full_name, 'name ' || n.partner_name;
  ASSERT n.partner_user_id = su, 'not linked to the funder';
END $t$);

CALL tt.run('N07', 'An agent with an active agent role keeps the typed partner (unchanged)', $t$
DECLARE ag uuid := tt.person('Active Agent', ARRAY['agent', 'supporter']); n public.promissory_notes;
BEGIN
  n := tt.hn_write(ag, 'Agent Typed Partner', '0700343434', NULL);
  ASSERT n.partner_name = 'Agent Typed Partner', 'name ' || n.partner_name;
  ASSERT n.partner_user_id IS DISTINCT FROM ag, 'linked to the agent';
END $t$);

CALL tt.run('N08', 'self_booking from someone without the supporter role does not swap in their details', $t$
DECLARE ag uuid := tt.person('Agent No Supporter', ARRAY['agent']); n public.promissory_notes;
BEGIN
  n := tt.hn_write(ag, 'Typed Despite Flag', '0700565656', NULL, true);
  ASSERT n.partner_name = 'Typed Despite Flag', 'name ' || n.partner_name;
END $t$);

CALL tt.run('N09', 'Someone who is not an agent, a proxy agent or a supporter is still refused', $t$
DECLARE nobody uuid := tt.person('No Roles', ARRAY[]::text[]); h uuid := tt.hn_house(); v_err text;
BEGIN
  PERFORM tt.as_user(nobody);
  BEGIN
    PERFORM public.agent_create_promissory_note_for_houses(
      jsonb_build_object('partner_name', 'X Partner', 'whatsapp_number', '0700787878', 'amount', 1000), ARRAY[h]);
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE;
  END;
  PERFORM tt.as_user(NULL);
  ASSERT v_err = '42501', 'expected 42501, got ' || coalesce(v_err, 'no error');
END $t$);

SELECT id || ' ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' ' || title || COALESCE(' :: ' || detail, '')
  FROM tt.result WHERE id LIKE 'N0%' ORDER BY id;
