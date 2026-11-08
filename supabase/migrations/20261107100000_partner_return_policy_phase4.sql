-- Partner Returns per person (Phase 4a: what the edge functions need)
--   * partner_rate_visible_to_caller: the one rule for "may this caller see this person's rate".
--   * _promissory_note_rate_view: "may this viewer see this note's rate", read from Phase 2's
--     _promissory_note_rate_json (one rule for the agent's note RPCs and the activation page).
--   * lookup_promissory_note / activate_promissory_note: the activation page's reads and the owner-run
--     linking that replaces activate-promissory-note's service-role writes (Phase 1's note guard refuses
--     those after the cut-off). After the cut-off a pre-cut-off note with an open window links by token
--     only to a caller who proved the note's phone or email with a code (owner decision D3).
--   * _note_contact_proven / trg_zz_guard_note_window_link: D3 on EVERY linking path. Production's owner-run
--     profile triggers (trg_profiles_link_promissory_notes -> link_promissory_notes_for_user,
--     trg_link_proxy_records_on_profile -> link_proxy_records_on_profile) link unlinked notes by
--     profiles.phone / profiles.email, which a user can set without a code; the hold keeps such a link off
--     a pre-cut-off window unless the person proved the contact or partner staff link it. The unmerged
--     security-branch migration 20261106201000 (dev/promissory-note-link-security) changes the email side
--     of link_promissory_notes_for_user (confirmed login email); this trigger does not depend on that and
--     must stay when it lands. The same trigger refuses an agent change on a linked note that would open the
--     note's window for its person without proof (NOTE_AGENT_CHANGE_OPENS_WINDOW; Partner Ops can move it),
--     and the proof is checked against the note's contacts as frozen at the cut-off (Phase 1's
--     partner_return_note_windows.contact_phones / contact_email), so an edited contact proves nothing.
--   * system_events_no_browser_link_held: a browser session cannot write a 'promissory_note_link_held' event
--     (the Partner Ops queue of held links); only the owner-run hold writes them.
--   * trg_portfolio_rate_requests_stamp_actor: who typed a rate inserted with the service role.
--   * partner_confirmed_login_emails / profile_ids_by_emails: batch reads for edge functions.
--   * get_partner_return_report: the daily partner report's "Returns rate check".
--   * notice queues: unsent rows queued before Phase 2 get the note's (house's) rate.
--   * _partner_return_phase4_checks: Phase 4's structural checks (one place; the assert calls it).
-- Switch off: nothing here changes a rate. Rollback: supabase/rollbacks/20261107100000_partner_return_policy_phase4.rollback.sql
--
-- Order: after 20261105150000 (Phase 1) and 20261105151000 (Phase 2); re-stamp all three after
-- origin/lovable's latest migration at merge, keeping this order. Re-runnable (applied twice in tests).
-- Applied via the CLI before any Phase 4 edge code reaches lovable (design v2 §8.2); Lovable is not asked
-- to apply it.
SET LOCAL lock_timeout = '1s';   -- not 5s: everything queues behind a waiting lock; on a timeout retry the apply

-- ===========================================================================
-- 1. Who may see a named person's own rate. Never NULL (false for anon). Called only by owner-run readers.
--    The staff list is the one partner_quote_rate('partner') uses (static test T1.12 compares them with
--    PARTNER_STAFF_ROLES in _shared/partnerReturnPolicy.ts).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.partner_rate_visible_to_caller(p_partner uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_partner IS NOT NULL AND (
           COALESCE((SELECT auth.uid()) = p_partner, false)
        OR COALESCE(public._partner_return_policy_caller_ok(
             ARRAY['partner_ops', 'coo', 'cfo', 'ceo', 'super_admin', 'manager', 'financial_ops']), false));
$function$;
REVOKE ALL ON FUNCTION public.partner_rate_visible_to_caller(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_rate_visible_to_caller(uuid) TO service_role;
COMMENT ON FUNCTION public.partner_rate_visible_to_caller(uuid) IS
  'True when the caller may see this person''s own Partner Returns rate (and the Returns figures that reveal it): the person, partner staff, or a backend context. Never NULL. Called by owner-run readers only.';

-- ===========================================================================
-- 2. Which note rates a viewer may see: a legacy note's rate (15 for every note written before Phase 1;
--    never a person's rate), an unlinked note stamped at the public rate ('new'), or the viewer's own note.
--    A person-stamped note (existing_partner, employee, ...) linked to someone else, or unlinked later by
--    owner code, stays hidden. The rule itself is Phase 2's _promissory_note_rate_json (the agent's note
--    RPCs answer through it), so the activation page and the note RPCs can never disagree. Callable by
--    nobody but its owner-run callers.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public._promissory_note_rate_view(p_note public.promissory_notes, p_viewer uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('return_rate', x.j -> 'return_rate', 'monthly_return', x.j -> 'monthly_return')
    FROM (SELECT public._promissory_note_rate_json(p_note, p_viewer) AS j) x;
$function$;
REVOKE ALL ON FUNCTION public._promissory_note_rate_view(public.promissory_notes, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 3. What the activation page shows. Anyone holding the link (anon). Contacts as hints only (same masks
--    as the security branch). whatsapp_number/email are returned EMPTY for the old page (it prefills from
--    them and calls .trim(); an empty string reveals nothing) until the old page is retired (design §8.6).
--    activation_token has a plain (non-unique) index: two rows = not found, as the edge's .single() did.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.lookup_promissory_note(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  n        public.promissory_notes;
  v_digits text;
  v_email  text;
  v_at     integer;
BEGIN
  IF p_token IS NULL OR length(p_token) NOT BETWEEN 16 AND 256 THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT * INTO STRICT n FROM public.promissory_notes WHERE activation_token = p_token;
  EXCEPTION WHEN no_data_found OR too_many_rows THEN
    RETURN NULL;
  END;

  v_digits := regexp_replace(COALESCE(n.whatsapp_number, ''), '\D', '', 'g');
  v_email  := btrim(COALESCE(n.email, ''));
  v_at     := CASE WHEN position('@' IN v_email) > 0
                   THEN length(v_email) - position('@' IN reverse(v_email)) + 1 END;   -- last '@'

  RETURN jsonb_build_object(
    'id', n.id,
    'partner_name', n.partner_name,
    'amount', n.amount,
    'contribution_type', n.contribution_type,
    'deduction_day', n.deduction_day,
    'status', n.status,
    'total_collected', n.total_collected,
    'created_at', n.created_at,
    'whatsapp_hint', CASE WHEN length(v_digits) >= 6 THEN repeat('*', length(v_digits) - 3) || right(v_digits, 3) END,
    'email_hint', CASE WHEN v_at > 1 AND v_at < length(v_email) THEN left(v_email, 1) || '***' || substr(v_email, v_at) END,
    'whatsapp_number', '',          -- compatibility for the old page (§8.6); never the real value
    'email', '',                    -- compatibility for the old page (§8.6); never the real value
    'linked_to_me', COALESCE(v_uid IS NOT NULL AND n.partner_user_id = v_uid, false))
    || public._promissory_note_rate_view(n, v_uid);
END $function$;
REVOKE ALL ON FUNCTION public.lookup_promissory_note(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_promissory_note(text) TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.lookup_promissory_note(text) IS
  'What a promissory-note activation link shows (anyone holding the link): masked contact hints, never the contacts; the note''s Returns rate only when it is not a person''s rate or the note is the caller''s. NULL when the token matches no note (or more than one).';

-- ===========================================================================
-- 3b. D3 contact proof: the person themselves completed a code or link sent to the note's contact.
--     Phone (last 9 digits of the note's WhatsApp or phone number):
--       * otp-login: an SMS code to that number was verified and the login resolved to this account
--         (otp_login_audit, outcome 'success');
--       * self-update-phone: the account moved its phone to that number (phone_change_otp_challenges
--         'consumed': written only after the new number's SMS code and the emailed approval code were
--         both verified for this account and this number).
--     Email (the note's email):
--       * email-verify-confirm: the emailed code was entered (email_verification_challenges.verified_at);
--       * a Google or Apple sign-in whose provider email matches (auth.identities) and is not marked
--         email_verified false.
--     The contacts are those frozen at the cut-off (partner_return_note_windows.contact_phones /
--     contact_email) for a note with a window, so staff editing a note's number after the cut-off cannot
--     make someone else's proven number count; a note without a window uses its current contacts.
--     NOT proof: auth.users.email_confirmed_at / phone_confirmed_at (about 20 edge functions set them with
--     email_confirm / phone_confirm: true without any code, among them the public
--     create-funder-onboarding-account and the agent-run register-proxy-funder), profiles.phone /
--     profiles.email (editable without a code), and the SMS checks of phone-signup, confirm-phone-account
--     and sms-otp (otp_verifications records no account, so nothing ties their code to a user id).
--     None of the four tables has a browser write path (RLS; checked 2026-11-07). Owner-run only.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public._note_contact_proven(p_user uuid, p_note_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The contacts to prove: frozen at the cut-off for a note with a window (an edit after the cut-off moves
  -- nothing), the note's current ones otherwise.
  SELECT COALESCE((
    SELECT EXISTS (SELECT 1 FROM public.otp_login_audit a
                    WHERE a.resolved_user_id = p_user AND a.outcome = 'success'
                      AND public.normalize_phone_last9(a.phone) = ANY (c.phones))
        OR EXISTS (SELECT 1 FROM public.phone_change_otp_challenges pc
                    WHERE pc.user_id = p_user AND pc.status = 'consumed'
                      AND public.normalize_phone_last9(pc.new_phone_last9) = ANY (c.phones))
        OR (c.email IS NOT NULL
            AND (EXISTS (SELECT 1 FROM public.email_verification_challenges e
                          WHERE e.user_id = p_user AND e.verified_at IS NOT NULL
                            AND lower(btrim(e.new_email)) = c.email)
                 OR EXISTS (SELECT 1 FROM auth.identities i
                             WHERE i.user_id = p_user AND i.provider IN ('google', 'apple')
                               AND COALESCE(i.identity_data ->> 'email_verified', 'true') <> 'false'
                               AND lower(btrim(i.identity_data ->> 'email')) = c.email)))
      FROM (SELECT CASE WHEN w.note_id IS NOT NULL THEN COALESCE(w.contact_phones, '{}'::text[])
                        ELSE array_remove(ARRAY[public.normalize_phone_last9(n.whatsapp_number),
                                                public.normalize_phone_last9(n.phone_number)], NULL) END AS phones,
                   CASE WHEN w.note_id IS NOT NULL THEN w.contact_email
                        ELSE lower(NULLIF(btrim(n.email), '')) END AS email
              FROM public.promissory_notes n
              LEFT JOIN public.partner_return_note_windows w ON w.note_id = n.id
             WHERE n.id = p_note_id AND p_user IS NOT NULL) c), false);
$function$;
REVOKE ALL ON FUNCTION public._note_contact_proven(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public._note_contact_proven(uuid, uuid) IS
  'D3: true when the person completed a code or link sent to this promissory note''s phone or email themselves (OTP login, verified phone change, verified email change, verified Google/Apple sign-in), against the contacts frozen at the cut-off when the note has a window. Confirmed-flags on auth.users are not proof. Owner-run only.';

-- ===========================================================================
-- 4. Owner-run activation bound to the caller's JWT. Same contract as the security branch (5e2ad5e930):
--    the caller is the account (no user id parameter); a note linked to someone else is refused; a role
--    staff disabled is never re-enabled. Runs as the owner, so Phase 1's guard_promissory_note_return_rate
--    and the security branch's guard_promissory_note_direct_edit (both check current_user) do not apply;
--    the late-link, receivable and commission triggers fire exactly as for today's service-role update.
--    D3 (default ON): after the cut-off a note whose frozen window would open for the caller
--    (partner_note_window_open, the rule's own test) links by token only when the caller proved the note's
--    phone or email (_note_contact_proven). Others go to Partner Ops (promissory_confirm_arrival_match).
--    trg_zz_guard_note_window_link applies the same rule to every other linking path. Before the cut-off
--    there are no windows, so nothing changes.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.activate_promissory_note(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := (SELECT auth.uid());
  n         public.promissory_notes;
  v_already boolean := false;
  v_your    numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: please sign in to activate this note' USING ERRCODE = '42501';
  END IF;
  IF p_token IS NULL OR length(p_token) NOT BETWEEN 16 AND 256 THEN
    RAISE EXCEPTION 'NOTE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('lock_timeout', '5s', true);   -- the late-link trigger takes rate locks: fail fast (409)
  BEGIN
    SELECT * INTO STRICT n FROM public.promissory_notes WHERE activation_token = p_token FOR UPDATE;
  EXCEPTION WHEN no_data_found OR too_many_rows THEN
    RAISE EXCEPTION 'NOTE_NOT_FOUND' USING ERRCODE = 'P0002';
  END;
  IF n.partner_user_id IS NOT NULL AND n.partner_user_id <> v_uid THEN
    RAISE EXCEPTION 'NOTE_LINKED_ELSEWHERE: this note is already linked to another account' USING ERRCODE = '42501';
  END IF;
  IF n.status NOT IN ('pending', 'activated') THEN
    RAISE EXCEPTION 'NOTE_NOT_OPEN: note is already %', n.status USING ERRCODE = '22023';
  END IF;

  -- D3: a pre-cut-off note whose frozen window would open for the caller needs the caller's own proof of
  -- the note's phone or email (the hold trigger would otherwise keep the link off silently).
  IF n.partner_user_id IS NULL
     AND EXISTS (SELECT 1 FROM public.partner_return_note_windows w
                  WHERE w.note_id = n.id
                    AND public.partner_note_window_open(n.status, w.ends_on, w.partner_user_id, w.agent_id,
                                                        n.agent_id, v_uid))
     AND NOT public._note_contact_proven(v_uid, n.id) THEN
    RAISE EXCEPTION 'NOTE_CONTACT_MISMATCH: this note was written for a phone number or email this account has not confirmed with a code; Partner Ops can link the note to you'
      USING ERRCODE = '42501';
  END IF;

  IF n.status = 'activated' THEN
    v_already := true;
    IF n.partner_user_id IS NULL THEN
      UPDATE public.promissory_notes SET partner_user_id = v_uid, updated_at = now() WHERE id = n.id;
      INSERT INTO public.system_events (event_type, description, metadata)
      VALUES ('promissory_note_activated',
              format('Partner %s linked to already-active promissory note for %s', n.partner_name, n.amount),
              jsonb_build_object('note_id', n.id, 'partner_user_id', v_uid, 'agent_id', n.agent_id,
                                 'amount', n.amount, 'link_only', true, 'via', 'activate_promissory_note'));
    END IF;
  ELSE
    UPDATE public.promissory_notes SET status = 'activated', partner_user_id = v_uid, updated_at = now()
     WHERE id = n.id;
    -- Parity with today's edge function (owner decision D12 ties this to agent vetting).
    INSERT INTO public.user_roles (user_id, role, enabled)
    SELECT v_uid, r::public.app_role, true FROM unnest(ARRAY['tenant', 'agent', 'landlord', 'supporter']) r
    ON CONFLICT (user_id, role) DO NOTHING;             -- user_roles_user_id_role_key; a disabled row stays disabled
    INSERT INTO public.system_events (event_type, description, metadata)
    VALUES ('promissory_note_activated',
            format('Partner %s activated promissory note for %s', n.partner_name, n.amount),
            jsonb_build_object('note_id', n.id, 'partner_user_id', v_uid, 'agent_id', n.agent_id,
                               'amount', n.amount, 'via', 'activate_promissory_note'));
  END IF;

  SELECT * INTO n FROM public.promissory_notes WHERE id = n.id;   -- the late-link trigger may have raised it
  BEGIN
    v_your := public.partner_rate_now(v_uid);         -- what a deposit opens at for the caller
  EXCEPTION WHEN OTHERS THEN
    v_your := NULL;                                   -- fail closed
  END;

  RETURN jsonb_build_object(
    'success', true, 'already_active', v_already, 'note_id', n.id, 'amount', n.amount,
    'status', n.status, 'your_rate', v_your)
    || public._promissory_note_rate_view(n, v_uid);
END $function$;
REVOKE ALL ON FUNCTION public.activate_promissory_note(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.activate_promissory_note(text) TO authenticated;
COMMENT ON FUNCTION public.activate_promissory_note(text) IS
  'Links a promissory note to the signed-in caller (owner-run; the Phase 1 note guard refuses direct linking after the Partner Returns cut-off; a pre-cut-off note whose window would open for the caller needs the caller''s own proof of the note''s phone or email). Called by the activate-promissory-note edge function with the caller''s JWT.';

-- ===========================================================================
-- 4b. D3 on every other linking path (backstop). Production links notes owner-run from the profile
--     triggers (link_promissory_notes_for_user by profiles.phone / profiles.email,
--     link_proxy_records_on_profile by profiles.phone, any note status), the note insert's phone match
--     and promissory_confirm_arrival_match. A first link - no person before, or a move away from an account
--     that has no profile any more (what the arrival match re-links) - is HELD (the note keeps its old
--     value, and a 'promissory_note_link_held' system event records it for Partner Ops) when all hold:
--       * it is not the note's own agent with the agent unchanged by the same statement (an author link
--         gives no window; an agent moved onto the person in the same UPDATE is not trusted);
--       * the note's pre-cut-off window would open for that person (partner_note_window_open, the rule's
--         own test) under the note's agent after the change or, when the statement also changes the agent,
--         under the agent before it. The test treats the note as open ('pending') whatever its status now:
--         operations and agent_ops staff can set any status, and link_proxy_records_on_profile and the
--         arrival match link notes of any status, so a note linked while 'defaulted' or 'cancelled' and
--         reopened later (by collusion, or by a genuine reactivation) would otherwise hand the window to an
--         unproven person. Status still matters at the cut-off snapshot (a note closed then has no window)
--         and in activate_promissory_note, which links only a pending or activated note;
--       * the caller is not partner staff acting on someone else (partner_rate_visible_to_caller: the same
--         role list, with staff MFA; a backend or owner session without a JWT is not staff);
--       * the person has not proved the note's phone or email (_note_contact_proven, frozen contacts).
--     An agent change on a linked note (same person) that opens the window for that person - not open
--     under the old agent, open under the new one (a note the person activated as its agent, then moved
--     away) - is REFUSED (42501 NOTE_AGENT_CHANGE_OPENS_WINDOW) unless one of the same two exemptions
--     holds (partner staff, e.g. partner_ops_transfer_proxy_book; or proof). It raises rather than holds:
--     keeping the old agent silently would undo a book transfer.
--     The row's other changes go through. A held row shows no link to Phase 2's statement-level
--     trg_zz_partner_note_linked_late (it compares partner_user_id before and after), so nothing is caught
--     up for it. Rows of the same statement are decided one by one; a held row never raises, so the
--     multi-note UPDATEs of the link functions (and the profile save behind them) carry on.
--     Named to fire after trg_zz_guard_note_return_rate (Phase 1; BEFORE triggers fire in name order), so a
--     browser or service-role link after the cut-off is still refused there, not held here. Production's
--     other BEFORE UPDATE triggers on promissory_notes (trg_guard_one_approved_note_per_partner,
--     trg_validate_promissory_note; the security branch's trg_guard_note_direct_edit) never set
--     partner_user_id or agent_id. Before the cut-off there are no windows, so nothing is held or refused
--     (switch-off parity).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.guard_note_window_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  w             public.partner_return_note_windows%ROWTYPE;
  v_uid         uuid;
  v_agent_moved boolean := NEW.agent_id IS DISTINCT FROM OLD.agent_id;
  v_first       boolean;
  v_ctx         text;
  v_source      text;
BEGIN
  IF NEW.partner_user_id IS NULL THEN
    RETURN NEW;                                   -- nobody to give a window to
  END IF;
  -- A first link: no person before, or a move away from an account that has no profile (arrival match).
  v_first := NEW.partner_user_id IS DISTINCT FROM OLD.partner_user_id
             AND (OLD.partner_user_id IS NULL
                  OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = OLD.partner_user_id));
  IF NOT v_first AND (NOT v_agent_moved OR NEW.partner_user_id IS DISTINCT FROM OLD.partner_user_id) THEN
    RETURN NEW;                                   -- neither a first link nor an agent change on a linked note
  END IF;
  IF v_first AND NOT v_agent_moved AND NEW.partner_user_id IS NOT DISTINCT FROM NEW.agent_id THEN
    RETURN NEW;                                   -- the note's own (unchanged) agent: no window
  END IF;
  SELECT * INTO w FROM public.partner_return_note_windows WHERE note_id = NEW.id;
  IF NOT FOUND THEN
    RETURN NEW;                                   -- written after the cut-off (or no cut-off yet): no window
  END IF;
  IF v_first THEN
    IF NOT (COALESCE(public.partner_note_window_open('pending', w.ends_on, w.partner_user_id, w.agent_id,
                                                     NEW.agent_id, NEW.partner_user_id), false)
            OR (v_agent_moved
                AND COALESCE(public.partner_note_window_open('pending', w.ends_on, w.partner_user_id, w.agent_id,
                                                             OLD.agent_id, NEW.partner_user_id), false))) THEN
      RETURN NEW;                                 -- no open pre-cut-off window for this person
    END IF;
  ELSIF COALESCE(public.partner_note_window_open('pending', w.ends_on, w.partner_user_id, w.agent_id,
                                                 OLD.agent_id, NEW.partner_user_id), false)
        OR NOT COALESCE(public.partner_note_window_open('pending', w.ends_on, w.partner_user_id, w.agent_id,
                                                        NEW.agent_id, NEW.partner_user_id), false) THEN
    RETURN NEW;                                   -- the agent change opens no window that was closed
  END IF;
  v_uid := (SELECT auth.uid());
  IF v_uid IS NOT NULL AND v_uid IS DISTINCT FROM NEW.partner_user_id
     AND public.partner_rate_visible_to_caller(NEW.partner_user_id) THEN
    RETURN NEW;                                   -- partner staff acting on someone else
  END IF;
  IF public._note_contact_proven(NEW.partner_user_id, NEW.id) THEN
    RETURN NEW;
  END IF;

  IF NOT v_first THEN
    RAISE EXCEPTION 'NOTE_AGENT_CHANGE_OPENS_WINDOW: moving this note to another agent would give its partner the pre-cut-off Returns window, and the partner has not confirmed the note''s phone or email with a code; Partner Ops can move it'
      USING ERRCODE = '42501';
  END IF;

  -- One event per note and person per transaction (a profile save runs both profile link triggers).
  IF NOT EXISTS (SELECT 1 FROM public.system_events e
                  WHERE e.event_type = 'promissory_note_link_held' AND e.created_at = now()
                    AND e.related_entity_id = NEW.id AND e.user_id = NEW.partner_user_id) THEN
    -- How the link arose, for the Partner Ops queue: the calling function (call stack), then which of the
    -- person's unproven profile contacts matched the note (the profile link functions match phone OR email).
    GET DIAGNOSTICS v_ctx = PG_CONTEXT;
    v_source := CASE
      WHEN position('promissory_confirm_arrival_match' in v_ctx) > 0 THEN 'arrival_match'
      WHEN position('link_proxy_records_on_profile' in v_ctx) > 0
        OR position('link_promissory_notes_for_user' in v_ctx) > 0 THEN
        CASE
          WHEN EXISTS (SELECT 1 FROM public.profiles p
                        WHERE p.id = NEW.partner_user_id
                          AND length(right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 9)) = 9
                          AND right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 9) IN
                              (right(regexp_replace(COALESCE(NEW.whatsapp_number, ''), '\D', '', 'g'), 9),
                               right(regexp_replace(COALESCE(NEW.phone_number, ''), '\D', '', 'g'), 9)))
            THEN 'profile_phone'
          WHEN EXISTS (SELECT 1 FROM public.profiles p
                        WHERE p.id = NEW.partner_user_id
                          AND NULLIF(lower(btrim(COALESCE(p.email, ''))), '') = lower(btrim(COALESCE(NEW.email, ''))))
            THEN 'profile_email'
          ELSE 'other'
        END
      ELSE 'other'
    END;
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata, created_at)
    VALUES ('promissory_note_link_held', NEW.partner_user_id, 'promissory_notes', NEW.id,
            'Promissory note link held: the note carries a pre-cut-off Returns window and this account has not confirmed the note''s phone or email with a code. A held event is not a claim of ownership: anyone can type a contact into their profile. Partner Ops links the note only after proof (a code sent to the note''s phone or email as frozen at the cut-off, or the CFO late-link request)',
            jsonb_build_object('note_id', NEW.id,
                               'reason', 'D3: open pre-cut-off note window; the account has not proved the note''s phone or email; Partner Ops can link it only after proof',
                               'source', v_source,
                               'not_proof_of_ownership', true,
                               'held_user_id', NEW.partner_user_id, 'linked_by', v_uid, 'agent_id', NEW.agent_id,
                               'window_ends_on', w.ends_on),
            now());
  END IF;
  NEW.partner_user_id := OLD.partner_user_id;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.guard_note_window_link() FROM PUBLIC, anon, authenticated, service_role;
-- CREATE OR REPLACE TRIGGER (PG14+): a re-apply keeps the trigger (no ACCESS EXCLUSIVE lock) and widens an
-- earlier apply's column list.
CREATE OR REPLACE TRIGGER trg_zz_guard_note_window_link
  BEFORE UPDATE OF partner_user_id, agent_id ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_note_window_link();

-- 4c. The held-link queue is written only by the hold above (owner-run; the owner bypasses RLS). Production's
--     system_events_insert_authenticated lets a signed-in user insert any event about themselves, which would
--     let anyone queue a forged held link to a stranger's note for Partner Ops to complete.
DROP POLICY IF EXISTS system_events_no_browser_link_held ON public.system_events;
CREATE POLICY system_events_no_browser_link_held ON public.system_events AS RESTRICTIVE FOR INSERT TO authenticated, anon
  WITH CHECK (event_type IS DISTINCT FROM 'promissory_note_link_held');

-- ===========================================================================
-- 5. Who typed a rate that a service-role insert queued for the CFO. The gate writes
--    requested_by = auth.uid(), NULL for the service role. Edge functions that insert portfolios with
--    staff-typed rates build their service-role client per request with header x-welile-actor = the staff
--    user id; PostgREST exposes request headers in request.headers. Only the service role can use it
--    (browser roles are excluded by the role check), and only an existing user id is accepted.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.portfolio_rate_requests_stamp_actor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_hdr   text;
  v_actor uuid;
BEGIN
  IF NEW.requested_by IS NULL AND NEW.source IN ('new_portfolio', 'rate_change')
     AND COALESCE(auth.role(), '') = 'service_role' THEN
    v_hdr := NULLIF(current_setting('request.headers', true), '');   -- '' after a pooled reset
    IF v_hdr IS NOT NULL THEN
      BEGIN
        v_actor := NULLIF(v_hdr::json ->> 'x-welile-actor', '')::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_actor := NULL;
      END;
      IF v_actor IS NOT NULL AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_actor) THEN
        NEW.requested_by := v_actor;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.portfolio_rate_requests_stamp_actor() FROM PUBLIC, anon, authenticated;
-- CREATE OR REPLACE TRIGGER (PG14+, as Phase 1/2): no ACCESS EXCLUSIVE lock, and a re-apply keeps the trigger.
CREATE OR REPLACE TRIGGER trg_portfolio_rate_requests_stamp_actor
  BEFORE INSERT ON public.portfolio_rate_approvals
  FOR EACH ROW EXECUTE FUNCTION public.portfolio_rate_requests_stamp_actor();

-- ===========================================================================
-- 6. Confirmed, real login emails (batch). Synthetic, deleted (.invalid, or the account soft-deleted)
--    and unconfirmed addresses are left out.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.partner_confirmed_login_emails(p_ids uuid[])
 RETURNS TABLE (user_id uuid, email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT u.id, lower(btrim(u.email))
    FROM auth.users u
   WHERE cardinality(COALESCE(p_ids, '{}'::uuid[])) <= 1000
     AND u.id = ANY (COALESCE(p_ids, '{}'::uuid[]))
     AND u.email_confirmed_at IS NOT NULL
     AND u.deleted_at IS NULL
     AND NULLIF(btrim(u.email), '') IS NOT NULL
     AND lower(u.email) !~ '@([a-z0-9-]+\.)*(welile\.user|welile\.agent)$'
     AND lower(u.email) !~ '\.invalid$';
$function$;
REVOKE ALL ON FUNCTION public.partner_confirmed_login_emails(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_confirmed_login_emails(uuid[]) TO service_role;

-- ===========================================================================
-- 7. Profiles by email, case-insensitive (import-partners; replaces one ilike call per partner).
--    Matches lower(p.email), so production's idx_profiles_email_lower serves it (no profile email has
--    surrounding spaces, checked 2026-11-07; the old .ilike('email', x) did not trim the stored value either).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.profile_ids_by_emails(p_emails text[])
 RETURNS TABLE (email text, id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT lower(p.email), p.id
    FROM public.profiles p
   WHERE cardinality(COALESCE(p_emails, '{}'::text[])) <= 500
     AND lower(p.email) = ANY (ARRAY(SELECT DISTINCT lower(btrim(e)) FROM unnest(p_emails) e
                                      WHERE NULLIF(btrim(e), '') IS NOT NULL));
$function$;
REVOKE ALL ON FUNCTION public.profile_ids_by_emails(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profile_ids_by_emails(text[]) TO service_role;

-- ===========================================================================
-- 8. Phase 4's structural checks, in one place. The assert calls it (one line, item 11); the report and
--    the Phase 7 release migration call it directly, so a later re-run of Phase 2's assert (e.g. a Lovable
--    copy of the file) cannot silently drop them. Checks that need work outside Phase 4 (masks, the
--    security migration) pass until release_ready is set, or always fail when p_for_release.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public._partner_return_phase4_checks(p_for_release boolean DEFAULT false)
 RETURNS TABLE (check_name text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ready boolean := COALESCE((SELECT p.release_ready FROM public.partner_return_policy p WHERE p.id), false);
  v_need  boolean := COALESCE(p_for_release, false) OR v_ready;
  v_bad   integer;
BEGIN
  RETURN QUERY SELECT 'activation_owner_run',
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'public' AND p.proname = 'activate_promissory_note' AND p.prosecdef
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')),
    'after the cut-off a promissory note links to its person only through activate_promissory_note (signed-in caller)';

  RETURN QUERY SELECT 'activation_contact_match',
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'public' AND p.proname = 'activate_promissory_note'
               AND position('NOTE_CONTACT_MISMATCH' in p.prosrc) > 0
               AND position('_note_contact_proven' in p.prosrc) > 0)
    AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                 WHERE t.tgrelid = 'public.promissory_notes'::regclass
                   AND t.tgname = 'trg_zz_guard_note_window_link' AND t.tgenabled <> 'D'
                   AND p.proname = 'guard_note_window_link'
                   AND position('_note_contact_proven' in p.prosrc) > 0
                   AND position('NOTE_AGENT_CHANGE_OPENS_WINDOW' in p.prosrc) > 0
                   -- fires on both columns (an UPDATE OF list; an empty tgattr would mean every column)
                   AND (t.tgtype::integer & 16) <> 0
                   AND (SELECT count(*) FROM pg_attribute a
                         WHERE a.attrelid = t.tgrelid AND a.attname IN ('partner_user_id', 'agent_id')
                           AND (cardinality(t.tgattr::int2[]) = 0 OR a.attnum = ANY (t.tgattr::int2[]))) = 2)
    AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                 WHERE ns.nspname = 'public' AND p.proname = '_note_contact_proven'
                   AND position('contact_phones' in p.prosrc) > 0)
    AND EXISTS (SELECT 1 FROM pg_policies pp
                 WHERE pp.schemaname = 'public' AND pp.tablename = 'system_events'
                   AND pp.policyname = 'system_events_no_browser_link_held' AND pp.permissive = 'RESTRICTIVE'
                   AND pp.cmd = 'INSERT' AND pp.roles @> '{authenticated,anon}'::name[]
                   AND position('promissory_note_link_held' in COALESCE(pp.with_check, '')) > 0)
    AND COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.system_events'::regclass), false),
    'after the cut-off a pre-cut-off note opens its window (by token, profile phone or email, any other link, or a move to another agent) only for a person who proved its phone or email as frozen at the cut-off with a code, or through partner staff; browsers cannot forge held-link events';

  -- Phase 1's carve-out guard must also stop browser and edge sessions from re-pointing locked_from_portfolio_id
  -- (partner_rates_for walks it: re-pointing a new portfolio at a redeemed pre-cut-off one makes a returning
  -- partner existing again).
  RETURN QUERY SELECT 'carry_link_immutable',
    EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE t.tgrelid = 'public.investor_portfolios'::regclass
               AND t.tgname = 'trg_partner_return_carry_guard' AND t.tgenabled <> 'D'
               AND p.proname = 'guard_partner_return_carry'
               AND position('OLD.locked_from_portfolio_id' in p.prosrc) > 0
               AND position('OLD.investor_id' in p.prosrc) > 0
               AND position('partner_return_cutoff_at' in p.prosrc) > 0
               AND (t.tgtype::integer & 4) <> 0 AND (t.tgtype::integer & 16) <> 0
               AND (SELECT count(*) FROM pg_attribute a
                     WHERE a.attrelid = t.tgrelid AND a.attname IN ('locked_from_portfolio_id', 'investor_id', 'status')
                       AND (cardinality(t.tgattr::int2[]) = 0 OR a.attnum = ANY (t.tgattr::int2[]))) = 3
               AND position('lose its partner only by being cancelled' in p.prosrc) > 0
               AND position('OLD.invite_id' in p.prosrc) > 0),
    'a carved-off portfolio''s link to its parent is set only by the split or lock tools and never changed from a browser or edge session, and after the cut-off no browser or edge session moves a portfolio from one partner to another';

  SELECT count(*) INTO v_bad FROM (VALUES ('lookup_promissory_note'), ('activate_promissory_note')) f(fn)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn
                        AND position('_promissory_note_rate_view' in p.prosrc) > 0);
  RETURN QUERY SELECT 'note_rate_view_shared',
    v_bad = 0 AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                           WHERE ns.nspname = 'public' AND p.proname = '_promissory_note_rate_view'
                             AND position('_promissory_note_rate_json' in p.prosrc) > 0)
      AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                   WHERE ns.nspname = 'public' AND p.proname = '_promissory_note_rate_json'
                     AND position('return_rate_basis = ''legacy''' in p.prosrc) > 0),
    'the activation page shows a note''s rate only when it is not a person''s rate or the note is the caller''s';

  SELECT count(*) INTO v_bad FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('get_partner_return_report', 'partner_confirmed_login_emails', 'profile_ids_by_emails',
                       'partner_rate_visible_to_caller')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  RETURN QUERY SELECT 'rate_tools_backend_only', v_bad = 4,
    'the rate report and the batch readers must exist and be closed to browsers';

  RETURN QUERY SELECT 'requester_trigger_enabled',
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.portfolio_rate_approvals'::regclass
             AND t.tgname = 'trg_portfolio_rate_requests_stamp_actor' AND t.tgenabled <> 'D'),
    'a rate typed by staff through an edge function must record who typed it';

  -- A 'funded' booking notice whose houses carry different rates has no single rate on purpose (no % line).
  SELECT (SELECT count(*) FROM public.promissory_house_booking_notices b
            LEFT JOIN public.promissory_notes n ON n.id = b.note_id
           WHERE b.return_rate IS NULL AND (b.sms_sent_at IS NULL OR b.email_sent_at IS NULL)
             AND NOT (b.kind = 'funded'
                      AND cardinality(public._promissory_note_funded_house_rates(n.id, n.partner_user_id)) > 1))
       + (SELECT count(*) FROM public.promissory_note_pledge_notices p
           WHERE p.return_rate IS NULL AND (p.sms_status = 'pending' OR p.email_status = 'pending'))
    INTO v_bad;
  RETURN QUERY SELECT 'open_notices_carry_rate', v_bad = 0,
    v_bad || ' unsent pledge/booking notice(s) have no stored Returns rate (their email would show none)';

  -- Needed before release only (they depend on 4b and on the security branch's migration). The four
  -- masking readers use 4b's one visibility helper (partner_returns_visible_to_caller: self, partner staff,
  -- approved active supporter proxy); the trust profile also carries the vouch mask (it rebuilt the Returns
  -- figures), and the public profile carries no mask of its own (it shows get_user_trust_profile's masked
  -- answer), so its marker is 4b's.
  SELECT count(*) INTO v_bad
    FROM (VALUES ('get_portfolio_by_activation_token', ARRAY['partner_returns_visible_to_caller']),
                 ('agent_onboarded_portfolios',        ARRAY['partner_returns_visible_to_caller']),
                 ('get_user_trust_profile',            ARRAY['partner_returns_visible_to_caller', 'vouch_breakdown']),
                 ('get_public_trust_profile',          ARRAY['Partner Returns Phase 4b']),
                 ('get_partner_wallet_hub',            ARRAY['partner_returns_visible_to_caller'])) f(fn, markers)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn
                        AND NOT EXISTS (SELECT 1 FROM unnest(f.markers) m WHERE position(m in p.prosrc) = 0));
  RETURN QUERY SELECT 'rate_masked_for_others', v_bad = 0 OR NOT v_need,
    v_bad || ' reader(s) still show another person''s Returns rate or Returns earned (4b; required before release_ready)';

  -- The security migration (20261106200000) drops the browser INSERT policy and guards the agent UPDATE
  -- policy with trg_guard_note_direct_edit (descriptive fields only; partner_user_id, status, approval and
  -- token are locked). It keeps "Agents can update own pending notes" on purpose (the agents' notes screen
  -- edits descriptive fields through it), so that policy may remain while the trigger guards it.
  RETURN QUERY SELECT 'note_browser_writes_closed',
    (NOT EXISTS (SELECT 1 FROM pg_policies pp WHERE pp.schemaname = 'public' AND pp.tablename = 'promissory_notes'
                  AND pp.policyname = 'Agents can create promissory notes')
     AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.promissory_notes'::regclass
                  AND t.tgname = 'trg_guard_note_direct_edit' AND t.tgenabled <> 'D'))
    OR NOT v_need,
    'agents must not insert promissory notes or change who a note belongs to from the browser (security migration 20261106200000; required before release_ready)';
END $function$;
REVOKE ALL ON FUNCTION public._partner_return_phase4_checks(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._partner_return_phase4_checks(boolean) TO service_role;

-- ===========================================================================
-- 9. The daily partner report's "Returns rate check". Counts only; no names, no person ids.
--    Kampala days; window at most 92 days. Partner staff, CEO/CFO/COO or a backend context.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.get_partner_return_report(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_from     timestamptz := (p_start::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to       timestamptz := ((p_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_pol      public.partner_return_policy%ROWTYPE;
  v_assert   jsonb;
  v_p4       jsonb;
  v_release  jsonb;
  v_hook     boolean;
  v_monitor  jsonb;
BEGIN
  IF NOT public._partner_return_policy_caller_ok(ARRAY['cfo', 'ceo', 'coo', 'super_admin', 'partner_ops']) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_end - p_start > 92 THEN
    RAISE EXCEPTION 'INVALID_WINDOW: the report window must be 1 to 93 days' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_pol FROM public.partner_return_policy WHERE id;

  -- Failing checks: the assert (which includes Phase 4's through its hook) and Phase 4's own checks
  -- called directly, so a lost hook cannot hide them. Each read fails on its own.
  BEGIN
    SELECT COALESCE(jsonb_agg(c.check_name ORDER BY c.check_name), '[]'::jsonb) INTO v_assert
      FROM public.assert_partner_return_policy_intact() c WHERE NOT c.ok;
  EXCEPTION WHEN OTHERS THEN
    v_assert := jsonb_build_array('assert_failed: ' || left(SQLERRM, 120));
  END;
  BEGIN
    SELECT COALESCE(jsonb_agg(c.check_name ORDER BY c.check_name), '[]'::jsonb) INTO v_p4
      FROM public._partner_return_phase4_checks(false) c WHERE NOT c.ok;
    SELECT COALESCE(jsonb_agg(c.check_name ORDER BY c.check_name), '[]'::jsonb) INTO v_release
      FROM public._partner_return_phase4_checks(true) c WHERE NOT c.ok;
  EXCEPTION WHEN OTHERS THEN
    v_p4 := jsonb_build_array('phase4_checks_failed: ' || left(SQLERRM, 120));
    v_release := v_p4;
  END;
  v_hook := EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                     WHERE ns.nspname = 'public' AND p.proname = 'assert_partner_return_policy_intact'
                       AND position('_partner_return_phase4_checks' in p.prosrc) > 0);

  -- Last run of the 10-minute monitor. cron.job_run_details (~290k rows, 7 days, pkey on runid only):
  -- walk runid backwards, so the newest run of this job is found within a few hundred rows.
  IF to_regclass('cron.job') IS NOT NULL AND to_regclass('cron.job_run_details') IS NOT NULL THEN
    EXECUTE $q$
      SELECT jsonb_build_object('scheduled', true, 'active', j.active, 'schedule', j.schedule,
                                'last_start', d.start_time, 'last_end', d.end_time, 'last_status', d.status)
        FROM cron.job j
        LEFT JOIN LATERAL (SELECT r.start_time, r.end_time, r.status FROM cron.job_run_details r
                            WHERE r.jobid = j.jobid ORDER BY r.runid DESC LIMIT 1) d ON true
       WHERE j.jobname = 'partner-rate-drift-check' LIMIT 1 $q$ INTO v_monitor;
  END IF;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('start', p_start, 'end', p_end),
    'policy', jsonb_build_object(
       'enabled', COALESCE(v_pol.enabled, false), 'release_ready', v_pol.release_ready,
       'cutoff_at', v_pol.cutoff_at, 'enabled_at', v_pol.enabled_at,
       'public_rate', public.partner_new_contract_rate(), 'new_contract_rate', v_pol.new_contract_rate,
       'legacy_rate', v_pol.legacy_rate, 'employee_rate', v_pol.employee_rate,
       'existing_partner_mode', v_pol.existing_partner_mode, 'existing_partner_rate', v_pol.existing_partner_rate,
       'existing_partner_cap', v_pol.existing_partner_cap),
    'new_portfolios', (
       SELECT COALESCE(jsonb_agg(jsonb_build_object('basis', x.basis, 'rate', x.rate, 'count', x.n, 'amount', x.amt)
                                 ORDER BY x.n DESC, x.basis, x.rate), '[]'::jsonb)
         FROM (SELECT COALESCE(ip.rate_basis, 'unstamped') AS basis, trim_scale(ip.roi_percentage) AS rate,
                      count(*) AS n, COALESCE(sum(ip.investment_amount), 0) AS amt
                 FROM public.investor_portfolios ip
                WHERE ip.rate_decided_at >= v_from AND ip.rate_decided_at < v_to
                GROUP BY 1, 2) x),
    'notes', (
       SELECT COALESCE(jsonb_agg(jsonb_build_object('basis', x.basis, 'rate', x.rate, 'count', x.n)
                                 ORDER BY x.n DESC, x.basis, x.rate), '[]'::jsonb)
         FROM (SELECT n.return_rate_basis AS basis, trim_scale(n.return_rate) AS rate, count(*) AS n
                 FROM public.promissory_notes n
                WHERE n.created_at >= v_from AND n.created_at < v_to GROUP BY 1, 2) x),
    'cfo_queue', (
       SELECT jsonb_build_object(
         'pending', count(*) FILTER (WHERE a.status = 'pending'),
         'pending_without_requester', count(*) FILTER (WHERE a.status = 'pending' AND a.requested_by IS NULL),
         -- Measured against the portfolio's rate now (an invite claimed by an existing partner carries
         -- their own rate; the gate re-measures the request too).
         'pending_lowering', count(*) FILTER (WHERE a.status = 'pending'
                                                AND a.requested_rate < COALESCE(ip.roi_percentage, a.standard_rate)),
         'oldest_pending_at', min(a.requested_at) FILTER (WHERE a.status = 'pending'),
         'scheduled', count(*) FILTER (WHERE a.status = 'approved' AND a.applied_at IS NULL),
         'requested_in_window', count(*) FILTER (WHERE a.requested_at >= v_from AND a.requested_at < v_to),
         'approved_in_window', count(*) FILTER (WHERE a.status = 'approved' AND a.decided_at >= v_from AND a.decided_at < v_to),
         'rejected_in_window', count(*) FILTER (WHERE a.status = 'rejected' AND a.decided_at >= v_from AND a.decided_at < v_to),
         'applied_in_window', count(*) FILTER (WHERE a.applied_at >= v_from AND a.applied_at < v_to))
         FROM public.portfolio_rate_approvals a
         LEFT JOIN public.investor_portfolios ip ON ip.id = a.portfolio_id),
    -- D3 holds in the window (trg_zz_guard_note_window_link): notes Partner Ops may need to link by hand.
    -- Distinct notes, and only those still without a person (none, or an account with no profile); browsers
    -- cannot write these events (system_events_no_browser_link_held).
    'note_links_held', (
       SELECT count(DISTINCT e.related_entity_id)::integer FROM public.system_events e
        WHERE e.event_type = 'promissory_note_link_held' AND e.created_at >= v_from AND e.created_at < v_to
          AND EXISTS (SELECT 1 FROM public.promissory_notes n
                       WHERE n.id = e.related_entity_id
                         AND (n.partner_user_id IS NULL
                              OR NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = n.partner_user_id)))),
    'conformance', (
       SELECT COALESCE(jsonb_object_agg(c.issue, c.n), '{}'::jsonb)
         FROM (SELECT r.issue, count(*) AS n FROM public.partner_rate_conformance(NULL) r GROUP BY r.issue) c),
    'checks_failing', (SELECT COALESCE(jsonb_agg(DISTINCT x.v ORDER BY x.v), '[]'::jsonb)
                         FROM (SELECT jsonb_array_elements_text(v_assert) AS v
                               UNION SELECT jsonb_array_elements_text(v_p4)) x),
    'release_checks_failing', v_release,
    'assert_has_phase4_hook', v_hook,
    'rule_check', jsonb_build_object(
      'cohort_new_below_own', (
         SELECT count(*) FROM public.investor_portfolios ip
           JOIN public.partner_return_cohort c ON c.partner_id = ip.investor_id AND c.basis = 'live_portfolio'
          WHERE v_pol.cutoff_at IS NOT NULL AND ip.rate_decided_at >= v_pol.cutoff_at
            AND ip.locked_from_portfolio_id IS NULL
            AND ip.status = ANY (public.partner_live_portfolio_statuses())
            AND ip.roi_percentage < CASE v_pol.existing_partner_mode
                                      WHEN 'fixed' THEN v_pol.existing_partner_rate
                                      ELSE LEAST(c.max_rate, COALESCE(v_pol.existing_partner_cap, c.max_rate)) END),
      'non_cohort_new_above_public', (
         SELECT count(*) FROM public.investor_portfolios ip
          WHERE v_pol.cutoff_at IS NOT NULL AND ip.rate_decided_at >= v_pol.cutoff_at
            AND ip.rate_basis = 'new' AND ip.roi_percentage > v_pol.new_contract_rate
            AND ip.status = ANY (public.partner_live_portfolio_statuses())),
      'precutoff_offer_live_non_cohort', (
         SELECT count(*) FROM public.investor_portfolios ip
          WHERE v_pol.cutoff_at IS NOT NULL
            AND ip.status = ANY (public.partner_live_portfolio_statuses())
            AND (ip.rate_decided_at IS NULL OR ip.rate_decided_at < v_pol.cutoff_at)
            AND ip.investor_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.partner_return_cohort c WHERE c.partner_id = ip.investor_id)
            AND ip.roi_percentage > v_pol.new_contract_rate),
      'open_pending_portfolios', (           -- release checklist: clear before switch-on (D14, D16)
         -- not yet live, or live but not yet claimed (an invite with no investor keeps its pre-cut-off
         -- rate for whoever claims it after switch-on)
         SELECT count(*) FROM public.investor_portfolios ip
          WHERE ip.status NOT IN ('active', 'locked', 'redeemed', 'cancelled')
             OR (ip.investor_id IS NULL AND ip.status = ANY (public.partner_live_portfolio_statuses()))),
      'note_windows_beyond_90d', (            -- D3b
         SELECT count(*) FROM public.partner_return_note_windows w
          WHERE v_pol.cutoff_at IS NOT NULL
            AND w.ends_on > ((v_pol.cutoff_at AT TIME ZONE 'Africa/Kampala')::date + 90))),
    'drift_open', (
       SELECT COALESCE(jsonb_agg(jsonb_build_object('check', e.check_name, 'since', e.detected_at)
                                 ORDER BY e.detected_at), '[]'::jsonb)
         FROM public.money_path_drift_events e
        WHERE e.resolved_at IS NULL AND e.check_name LIKE 'partner\_rate.%'),
    'monitor', COALESCE(v_monitor, jsonb_build_object('scheduled', false)));
END $function$;
REVOKE ALL ON FUNCTION public.get_partner_return_report(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_return_report(date, date) TO service_role;
COMMENT ON FUNCTION public.get_partner_return_report(date, date) IS
  'Partner Returns rate check for the daily partner report (counts only). Called by partner-ops-daily-report with the service role.';

-- ===========================================================================
-- 10. Unsent notices queued before Phase 2 carry no rate. Give them the note's (or the houses') rate once,
--     so the senders read only the row. Rows already sent are not touched. Re-running changes nothing.
--     A 'funded' booking notice states the rate of the houses the person funded (the same rule as Phase 2's
--     psm_queue_house_booking_notice: one distinct rate, or none); houses at different rates leave it NULL
--     on purpose (no % line; the open_notices_carry_rate check leaves such a notice out, through the same
--     helper). Only rows that GET a rate are written, so a re-run writes nothing (row triggers bump
--     updated_at only on the rows filled the first time).
-- ===========================================================================
-- The distinct monthly rates of the live houses a note's person funded through the note.
CREATE OR REPLACE FUNCTION public._promissory_note_funded_house_rates(p_note_id uuid, p_partner uuid)
 RETURNS numeric[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(array_agg(DISTINCT h.monthly_rate ORDER BY h.monthly_rate), '{}'::numeric[])
    FROM public.promissory_note_house_intents i
    JOIN public.partner_supported_houses h ON h.house_id = i.house_id
         AND h.partner_id = p_partner AND h.cancelled_at IS NULL AND h.monthly_rate IS NOT NULL
   WHERE i.note_id = p_note_id AND i.status = 'funded';
$function$;
REVOKE ALL ON FUNCTION public._promissory_note_funded_house_rates(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

UPDATE public.promissory_house_booking_notices b
   SET return_rate = x.rate
  FROM (SELECT b2.id,
               CASE WHEN b2.kind = 'funded' THEN
                 (SELECT CASE WHEN cardinality(r.rates) = 1 THEN r.rates[1] END
                    FROM (SELECT public._promissory_note_funded_house_rates(n.id, n.partner_user_id) AS rates) r)
               ELSE n.return_rate END AS rate
          FROM public.promissory_house_booking_notices b2
          JOIN public.promissory_notes n ON n.id = b2.note_id
         WHERE b2.return_rate IS NULL
           AND (b2.sms_sent_at IS NULL OR b2.email_sent_at IS NULL)) x
 WHERE b.id = x.id AND x.rate IS NOT NULL;
UPDATE public.promissory_note_pledge_notices p
   SET return_rate = n.return_rate
  FROM public.promissory_notes n
 WHERE n.id = p.note_id AND p.return_rate IS NULL
   AND (p.sms_status = 'pending' OR p.email_status = 'pending');
UPDATE public.funder_house_progress_notices f
   SET return_rate = x.rate
  FROM (SELECT f2.id,
               COALESCE((SELECT h.monthly_rate FROM public.partner_supported_houses h WHERE h.id = f2.supported_house_id),
                        (SELECT c.monthly_rate FROM public.partner_self_commitments c WHERE c.id = f2.commitment_id)) AS rate
          FROM public.funder_house_progress_notices f2
         WHERE f2.return_rate IS NULL AND (f2.sms_sent_at IS NULL OR f2.email_sent_at IS NULL)) x
 WHERE f.id = x.id AND x.rate IS NOT NULL;

-- ===========================================================================
-- 11. Assert hook. assert_partner_return_policy_intact() = Phase 2's body (20261105151000) with ONE line
--     inserted immediately before the final 'release_ready' RETURN QUERY:
--       RETURN QUERY SELECT * FROM public._partner_return_phase4_checks(false);
--     This is the only copy of the assert in Phase 4 (4b and the rollbacks do not touch it; the 4a
--     rollback restores Phase 2's body). The policy guard therefore also requires Phase 4's checks at
--     switch-on (it ignores only rates_conform and release_ready).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.assert_partner_return_policy_intact()
 RETURNS TABLE(check_name text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol   public.partner_return_policy%ROWTYPE;
  v_src   text;
  v_bad   integer;
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy WHERE id;
  RETURN QUERY SELECT 'policy_row_exists', v_pol.id IS NOT NULL, 'partner_return_policy must hold exactly one row';

  RETURN QUERY SELECT 'gate_trigger_enabled',
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_rate_policy' AND t.tgenabled <> 'D')
    AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_carry_guard' AND t.tgenabled <> 'D'),
    'every new portfolio must pass the Partner Returns gate';

  RETURN QUERY SELECT 'rate_has_no_default',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
               AND c.column_name = 'roi_percentage' AND c.column_default IS NULL AND c.is_nullable = 'NO'),
    'the portfolio Returns rate must be required and have no default (the gate fills it)';

  RETURN QUERY SELECT 'decision_stamp_columns',
    (SELECT count(*) = 4 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
        AND c.column_name IN ('entitled_rate', 'rate_basis', 'rate_decided_at', 'rate_existing_at_decision')),
    'each portfolio must record the rate it was entitled to and why';

  RETURN QUERY SELECT 'note_rate_column',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'promissory_notes'
               AND c.column_name = 'return_rate' AND c.is_nullable = 'NO'),
    'each promissory note must record its Returns rate';

  RETURN QUERY SELECT 'note_triggers_enabled',
    (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = 'public.promissory_notes'::regclass
       AND t.tgname IN ('trg_zz_stamp_note_return_rate', 'trg_zz_guard_note_return_rate') AND t.tgenabled <> 'D'),
    'promissory notes must be stamped at insert and guarded on update';

  RETURN QUERY SELECT 'cutoff_guards_enabled',
    (SELECT count(*) = 4 FROM pg_trigger t
      WHERE t.tgname IN ('trg_partner_return_policy_guard', 'trg_partner_return_cohort_guard',
                         'trg_partner_return_note_windows_guard', 'trg_partner_return_legacy_guard') AND t.tgenabled <> 'D'),
    'the cut-off, the existing-partner list, the note windows and the legacy list must be protected';

  RETURN QUERY SELECT 'cutoff_set_when_enabled',
    (NOT COALESCE(v_pol.enabled, false))
      OR (v_pol.cutoff_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.partner_return_cohort)),
    'with the switch on, the cut-off must be set and the existing-partner list filled';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'set_partner_return_policy' LIMIT 1;
  RETURN QUERY SELECT 'switch_ceo_only',
    v_src IS NOT NULL AND position('ARRAY[''ceo'']' in v_src) > 0
      AND v_src !~ 'ARRAY\[[^]]*''cfo''',
    'only the CEO may turn the switch on or off';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'apply_portfolio_renewal' LIMIT 1;
  RETURN QUERY SELECT 'renewal_keeps_rate',
    v_src IS NOT NULL
      AND v_src !~* 'update\s+(public\.)?investor_portfolios(\s+(as\s+)?\w+)?\s+set\s+([^;]*?,\s*)?(\w+\.)?roi_percentage\s*=',
    'a renewal must keep the portfolio''s stored rate';

  SELECT count(*) INTO v_bad FROM public.partner_rate_conformance(NULL);
  RETURN QUERY SELECT 'rates_conform', v_bad = 0,
    v_bad || ' portfolio(s) since the cut-off have a Returns rate that does not match what they were entitled to (see partner_rate_conformance())';

  RETURN QUERY SELECT 'cron_jobs_scheduled',
    CASE WHEN to_regclass('cron.job') IS NULL THEN false
         ELSE (SELECT count(*) = 2 FROM cron.job j
                WHERE j.jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check') AND j.active) END,
    'the next-cycle job and the drift check must be scheduled';
  -- Phase 2: every creation path leaves the rate to the gate (or types it on purpose, which the
  -- gate checks), and nothing quotes a fixed 15% any more.
  SELECT count(*) INTO v_bad
    FROM (VALUES ('funder_create_pending_portfolio'), ('psm_confirm_commitment_for'),
                 ('partner_support_houses'), ('countersign_prepare_support')) f(fn)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn
                    AND p.prosrc ~* 'insert\s+into\s+(public\.)?investor_portfolios\s*\([^)]*roi_percentage');
  RETURN QUERY SELECT 'creation_paths_leave_rate_to_gate', v_bad = 0,
    v_bad || ' creation function(s) are missing or type a Returns rate themselves (they must let the gate decide)';

  SELECT count(*) INTO v_bad
    FROM (VALUES ('psm_confirm_commitment_for', 'partner_rate_now'), ('partner_support_houses', 'partner_rate_now'),
                 ('get_countersign_summary', 'partner_rate_now'), ('hr_pay_post_staff_reinvestment', 'partner_rate_context'),
                 ('agent_list_empty_house_opportunities', 'partner_quote_rate'),
                 ('empty_house_opportunity_summary', 'partner_quote_rate'),
                 ('post_rent_facilitation_reward', 'rent_facilitation_reward_rates')) f(fn, must)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn AND position(f.must in p.prosrc) = 0);
  RETURN QUERY SELECT 'creation_paths_use_rule', v_bad = 0,
    v_bad || ' function(s) no longer take their rate from the Partner Returns rule';

  SELECT count(*) INTO v_bad
    FROM (VALUES ('enqueue_funder_house_notice'), ('get_or_create_house_share_link'), ('get_supporter_pool_stats'),
                 ('agent_create_promissory_note_for_houses'), ('agent_create_promissory_note'),
                 ('psm_queue_promissory_pledge_notice'), ('post_rent_facilitation_reward'),
                 ('agent_list_empty_house_opportunities'), ('empty_house_opportunity_summary'),
                 ('get_or_create_plan_share_link'), ('public_house_support_offer'), ('public_support_plan'),
                 ('hr_pay_post_staff_reinvestment'), ('partner_supported_house_returns')) f(fn)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn
                    AND p.prosrc ~ '0\.15|\m(15|20)%');
  RETURN QUERY SELECT 'quotes_use_stored_or_public_rate', v_bad = 0,
    v_bad || ' quote/notice function(s) are missing or still use a fixed Returns rate';

  RETURN QUERY SELECT 'phase2_triggers_enabled',
    (SELECT count(*) = 3 FROM pg_trigger t
      WHERE t.tgname IN ('trg_zz_partner_note_linked_late', 'trg_zz_stamp_rent_reward_rate_ins',
                         'trg_zz_stamp_rent_reward_rate_upd') AND t.tgenabled <> 'D'),
    'late-linked promissory notes and legacy rent-facilitation fundings must be decided by the rule';

  RETURN QUERY SELECT * FROM public._partner_return_phase4_checks(false);
  RETURN QUERY SELECT 'release_ready', COALESCE(v_pol.release_ready OR NOT v_pol.enabled, true),
    'the switch may only be on after the release marked every creation path, agreement, edge function and screen ready (ready='
      || COALESCE(v_pol.release_ready::text, 'unknown') || ')';
END $function$;
REVOKE ALL ON FUNCTION public.assert_partner_return_policy_intact() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_partner_return_policy_intact() TO service_role;
