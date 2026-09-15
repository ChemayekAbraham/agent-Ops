/**
 * Tenant self-onboarding — submitted directly by the tenant, with any saved
 * referring agent assigned server-side; no service centre.
 *
 * Two actions:
 *  - identity_check : tells the tenant only whether a phone / National ID is
 *                     already on file. Never returns whose it is.
 *  - submit         : creates/reuses the landlord + LC1 chairperson, updates the
 *                     tenant profile, and posts ONE rent request into the normal
 *                     pipeline at status `pending` (using the authenticated
 *                     tenant's verified profile referrer when present, with no
 *                     service centre routing). Fee fields are passed as 0 — the DB
 *                     trigger `enforce_rent_request_formula` is authoritative.
 *
 * No wallet or ledger writes happen here.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  scoreNameMatch,
  isLikelyDifferentPerson,
  findConsentedDeclaration,
  requestDeclarationConsent,
  confirmDeclarationConsent,
  linkBorrowerProfile,
} from "../_shared/nationalIdDeclaration.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ok = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (msg: string, status = 400) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const last9 = (v: string) => v.replace(/\D/g, "").slice(-9);
const cleanNin = (v: string) => v.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

// Photos: JPG/JPEG/PNG only, 5 MB max. Mirrors the client-side rule.
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function validPhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  return v.trim();
}

const OPEN_STATUSES = [
  "pending", "service_center_review", "approved", "agent_ops_approved", "tenant_ops_approved",
  "agent_verified", "landlord_ops_approved", "partner_ops_approved", "coo_approved",
  "funded", "disbursed", "repaying",
];

// Stages where the plan is already live and money is moving.
const REPAYING_STATUSES = ["funded", "disbursed", "repaying"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!token) return err("Sign in to continue", 401);
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !authData?.user) return err("Sign in to continue", 401);
    const userId = authData.user.id;

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return err("Invalid request body"); }
    const action = String(body.action || "");

    /* ------------------------------------------------ identity_check ------ */
    if (action === "identity_check") {
      const result: Record<string, boolean> = {};
      const phone = typeof body.phone === "string" ? body.phone : "";
      const nin = typeof body.national_id === "string" ? body.national_id : "";

      if (last9(phone).length === 9) {
        const { data } = await admin.from("profiles").select("id").ilike("phone", `%${last9(phone)}`).limit(2);
        const rows = data ?? [];
        result.phone_known = rows.length > 0;
        result.phone_is_you = rows.some((r: any) => r.id === userId);
      }
      if (cleanNin(nin).length >= 10) {
        const c = cleanNin(nin);
        const spaced = c.replace(/(.{4})/g, "$1 ").trim();
        const { data } = await admin
          .from("profiles").select("id, national_id")
          .or(`national_id.ilike.${c}%,national_id.ilike.${spaced}%`).limit(10);
        const match = (data ?? []).filter((r: any) => cleanNin(r.national_id || "") === c);
        result.nin_known = match.length > 0;
        result.nin_is_you = match.some((r: any) => r.id === userId);
      }
      return ok(result);
    }

    /* -------------------------------------------- application_status ------
       Read-only gate for the self-onboarding form. Looks for an existing open
       rent request belonging to this person — matched on their own user id AND
       on any other profile carrying the same phone number or the same email —
       so one household cannot be vetted or supported twice on one plan.
       Returns nothing but the stage; no financial data, no other identities. */
    if (action === "application_status") {
      const { data: me } = await admin
        .from("profiles").select("id, phone, email").eq("id", userId).maybeSingle();

      const ids = new Set<string>([userId]);
      const myPhone = last9(String((me as any)?.phone || ""));
      const myEmail = String((me as any)?.email || authData.user.email || "").trim();

      if (myPhone.length === 9) {
        const { data } = await admin.from("profiles").select("id").ilike("phone", `%${myPhone}`).limit(20);
        (data ?? []).forEach((r: any) => ids.add(r.id));
      }
      if (myEmail) {
        const { data } = await admin.from("profiles").select("id").ilike("email", myEmail).limit(20);
        (data ?? []).forEach((r: any) => ids.add(r.id));
      }

      const { data: rows } = await admin
        .from("rent_requests")
        .select("id, status, created_at, tenant_id")
        .in("tenant_id", Array.from(ids))
        .in("status", OPEN_STATUSES)
        .order("created_at", { ascending: false })
        .limit(10);

      const open = rows ?? [];
      if (open.length === 0) return ok({ blocked: false, stage: "none" });

      const active = open.find((r: any) => REPAYING_STATUSES.includes(r.status)) ?? open[0];
      const stage = REPAYING_STATUSES.includes(active.status) ? "repaying" : "under_review";
      return ok({
        blocked: true,
        stage,
        status: active.status,
        created_at: active.created_at,
        other_account: active.tenant_id !== userId,
      });
    }

    /* --------------------------------------------------------- submit ----- */
    if (action !== "submit") return err("Unknown action");

    const full_name = String(body.full_name || "").trim();
    const phone = validPhone(body.phone);
    const national_id = cleanNin(String(body.national_id || ""));
    const occupation = String(body.occupation || "").trim() || null;
    const preferred_language = typeof body.preferred_language === "string" ? body.preferred_language : null;
    const rent_amount = Number(body.rent_amount) || 0;
    const duration_days = Number(body.duration_days) || 0;
    const repayment_frequency = body.repayment_frequency === "weekly" ? "weekly" : "daily";
    const house_category = String(body.house_category || "single-room");
    const property_address = String(body.property_address || "").trim();
    const gps_lat = typeof body.gps_lat === "number" ? body.gps_lat : null;
    const gps_lng = typeof body.gps_lng === "number" ? body.gps_lng : null;
    const village = String(body.village || "").trim();
    const district = String(body.district || "").trim();
    const ug_village_id = typeof body.ug_village_id === "number" ? body.ug_village_id : null;
    const smartphone = body.no_smartphone === true ? "NO" : "YES";
    const house_photos = Array.isArray(body.house_photos) ? (body.house_photos as string[]) : [];
    const tenant_photo = typeof body.tenant_photo === "string" ? body.tenant_photo : null;
    // SHA-256 returned by the passport-photo check, used to link the stored photo
    // to its recorded fingerprint + verdict. Reference data only.
    const tenant_photo_sha256 = typeof body.tenant_photo_sha256 === "string" ? body.tenant_photo_sha256 : null;

    const id_photo = typeof body.id_photo === "string" ? body.id_photo : null;
    const lc_letter = typeof body.lc_letter === "string" ? body.lc_letter : null;
    const tenant_note = String(body.tenant_note || "").trim().slice(0, 1000);

    if (full_name.split(/\s+/).filter(Boolean).length < 2) return err("Enter your first and last name");
    if (!phone) return err("Enter a valid phone number");
    if (national_id.length < 10 || national_id.length > 14) return err("National ID must be 10–14 characters");
    if (rent_amount < 50000) return err("Rent amount must be at least UGX 50,000");
    if (!(duration_days === 30 || duration_days === 60 || duration_days === 90 || duration_days === 120 ||
      (duration_days >= 7 && duration_days <= 364 && duration_days % 7 === 0))) return err("Choose a valid repayment period");
    if (!property_address) return err("Enter your house address");
    if (!village || !district) return err("Pick your official village");

    // The National ID must not belong to somebody else.
    {
      const spaced = national_id.replace(/(.{4})/g, "$1 ").trim();
      const { data } = await admin
        .from("profiles").select("id, national_id")
        .or(`national_id.ilike.${national_id}%,national_id.ilike.${spaced}%`).limit(20);
      const conflict = (data ?? []).find((r: any) => cleanNin(r.national_id || "") === national_id && r.id !== userId);
      if (conflict) return err("This National ID is already registered to another account. Please check the number.");
    }
    // The phone must not belong to somebody else either.
    {
      const { data } = await admin.from("profiles").select("id").ilike("phone", `%${last9(phone)}`).limit(5);
      if ((data ?? []).some((r: any) => r.id !== userId)) {
        return err("This phone number is already registered to another account. Sign in with it instead.");
      }
    }

    // ---- National ID borrowing consent gate --------------------------------
    // One account, one national ID, one phone — but sometimes a tenant is
    // registered using a relative's National ID (no ID of their own yet). If
    // the caller supplies national_id_name (the name on the ID) and it does
    // not match this tenant's own full_name, the claimed ID owner must
    // confirm by SMS code before the registration proceeds. No-op when
    // national_id_name isn't supplied (existing callers are unaffected).
    let pendingDeclarationId: string | null = null;
    const rawNationalIdName = typeof body.national_id_name === "string" ? body.national_id_name.trim() : "";
    if (national_id && rawNationalIdName) {
      const matchScore = await scoreNameMatch(admin, full_name, rawNationalIdName);
      if (isLikelyDifferentPerson(matchScore)) {
        const alreadyConsented = await findConsentedDeclaration(admin, phone, national_id);
        if (alreadyConsented) {
          pendingDeclarationId = alreadyConsented.id;
        } else {
          const rawConsentCode = typeof body.consent_code === "string" ? body.consent_code.trim() : "";
          const rawDeclarationId = typeof body.consent_declaration_id === "string" ? body.consent_declaration_id.trim() : "";

          if (rawConsentCode && rawDeclarationId) {
            const result = await confirmDeclarationConsent(admin, rawDeclarationId, rawConsentCode);
            if (!result.ok) {
              return new Response(JSON.stringify({
                error: result.error, code: "id_owner_consent_required", stage: "awaiting_code", declaration_id: rawDeclarationId,
              }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            pendingDeclarationId = rawDeclarationId;
          } else {
            const rawIdOwnerPhone = validPhone(body.id_owner_phone);
            if (!rawIdOwnerPhone) {
              return new Response(JSON.stringify({
                error: `This National ID appears to belong to ${rawNationalIdName}, not ${full_name}. Enter the ID owner's phone number so we can confirm they've allowed this.`,
                code: "id_owner_consent_required", stage: "awaiting_owner_phone",
              }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            const { data: ownerProfile } = await admin
              .from("profiles").select("id").eq("national_id", national_id).maybeSingle();
            const { declarationId } = await requestDeclarationConsent(admin, {
              borrowerPhone: phone,
              borrowerFullName: full_name,
              nationalId: national_id,
              nationalIdName: rawNationalIdName,
              idOwnerPhone: rawIdOwnerPhone,
              idOwnerProfileId: (ownerProfile as any)?.id ?? null,
              matchScore,
            });
            return new Response(JSON.stringify({
              error: `We've sent a code to the ID owner's phone. Ask them to share it with you, then resubmit with the same consent_declaration_id and the code.`,
              code: "id_owner_consent_required", stage: "awaiting_code", declaration_id: declarationId,
            }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
      }
    }

    // One open request at a time.
    {
      const { data: open } = await admin
        .from("rent_requests").select("id, status").eq("tenant_id", userId).in("status", OPEN_STATUSES).limit(1);
      if (open && open.length > 0) {
        return err("You already have a rent request in progress. Track it from your dashboard.");
      }
    }

    /* ---- Referring agent -------------------------------------------------
       Attribution comes only from the authenticated tenant's saved profile.
       Never trust an agent id supplied by the browser: it could be altered to
       move a tenant into another agent's portfolio. A missing, self-referential,
       frozen or disabled/non-agent referrer leaves the request unassigned. */
    let referringAgentId: string | null = null;
    const { data: tenantAttribution, error: attributionErr } = await admin
      .from("profiles")
      .select("referrer_id")
      .eq("id", userId)
      .maybeSingle();
    if (attributionErr) return err(`Could not verify your referring agent: ${attributionErr.message}`, 500);

    const candidateReferrerId = typeof tenantAttribution?.referrer_id === "string"
      ? tenantAttribution.referrer_id
      : null;
    if (candidateReferrerId && candidateReferrerId !== userId) {
      const [{ data: referrerProfile, error: referrerErr }, { data: agentRole, error: roleErr }] = await Promise.all([
        admin.from("profiles").select("id, is_frozen").eq("id", candidateReferrerId).maybeSingle(),
        admin.from("user_roles").select("id").eq("user_id", candidateReferrerId)
          .eq("role", "agent").eq("enabled", true).limit(1).maybeSingle(),
      ]);
      if (referrerErr || roleErr) {
        return err(`Could not verify your referring agent: ${referrerErr?.message ?? roleErr?.message ?? "unknown"}`, 500);
      }
      if (referrerProfile && referrerProfile.is_frozen !== true && agentRole) {
        referringAgentId = candidateReferrerId;
      }
    }

    /* ---- Landlord: reuse the picked one, else match by phone, else create -- */
    let landlordId = typeof body.landlord_id === "string" ? body.landlord_id : null;
    const landlord_name = String(body.landlord_name || "").trim();
    const landlord_phone = validPhone(body.landlord_phone);
    if (!landlordId) {
      if (!landlord_name || !landlord_phone) return err("Landlord name and phone are required");
      const { data: existing } = await admin
        .from("landlords").select("id").ilike("phone", `%${last9(landlord_phone)}`).limit(1).maybeSingle();
      if (existing) {
        landlordId = existing.id;
      } else {
        const { data: created, error: lErr } = await admin
          .from("landlords")
          .insert({ name: landlord_name, phone: landlord_phone, property_address, district, village, ug_village_id, registered_by: userId })
          .select("id").single();
        if (lErr || !created) return err(`Could not save the landlord: ${lErr?.message ?? "unknown"}`, 500);
        landlordId = created.id;
      }
    }

    /* ---- LC1 chairperson: reuse by id / phone, else create ---------------- */
    let lc1Id = typeof body.lc1_id === "string" ? body.lc1_id : null;
    const lc1_name = String(body.lc1_name || "").trim();
    const lc1_phone = validPhone(body.lc1_phone);
    if (!lc1Id) {
      if (!lc1_name || !lc1_phone) return err("LC1 chairperson name and phone are required");
      const { data: existing } = await admin
        .from("lc1_chairpersons").select("id").ilike("phone", `%${last9(lc1_phone)}`)
        .order("verified", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
      if (existing) {
        lc1Id = existing.id;
      } else {
        const { data: created, error: cErr } = await admin
          .from("lc1_chairpersons")
          .insert({ name: lc1_name, phone: lc1_phone, village, district, ug_village_id, registered_by: userId })
          .select("id").single();
        if (cErr || !created) return err(`Could not save the LC1 chairperson: ${cErr?.message ?? "unknown"}`, 500);
        lc1Id = created.id;
      }
    }

    /* ---- Profile: keep the vetting details on the tenant record ---------- */
    const profilePatch: Record<string, unknown> = {
      full_name, phone, national_id, occupation, village, district,
    };
    if (preferred_language) profilePatch.preferred_language = preferred_language;
    if (ug_village_id) profilePatch.ug_village_id = ug_village_id;
    const { error: pErr } = await admin.from("profiles").update(profilePatch).eq("id", userId);
    if (pErr) return err(`Could not save your details: ${pErr.message}`, 400);
    if (pendingDeclarationId) await linkBorrowerProfile(admin, pendingDeclarationId, userId).catch(() => {});

    /* ---- Photo uploads ---------------------------------------------------
       These run BEFORE the insert on purpose. `enforce_rent_request_tenant_photo`
       is a BEFORE INSERT trigger that rejects any rent request whose
       tenant_photo_url is empty, falling back only to a photo from an EARLIER
       request by the same tenant. A first-time tenant has no earlier request,
       so inserting first and patching the photo in afterwards — which is what
       this function used to do — failed 100% of the time with
       "Tenant passport photo is required to submit a rent request", however
       many photos the tenant had actually taken.

       Storage paths are keyed on a generated folder id rather than the rent
       request id, because that id does not exist yet. */
    const assetFolder = crypto.randomUUID();

    /** Uploads a data URL into a bucket. Returns the storage path, or null. */
    const uploadTo = async (bucket: string, dataUrl: string, path: string): Promise<string | null> => {
      // Accept any image data URL, including ones carrying extra parameters
      // (e.g. `data:image/jpeg;charset=utf-8;base64,`) and subtypes with
      // non-word characters (`image/svg+xml`). The old strict pattern silently
      // returned null for those, which then tripped the tenant-photo trigger.
      const m = dataUrl.match(/^data:([^;,]+)?;base64,([\s\S]+)$/);
      if (!m) return null;
      // Only JPG/JPEG/PNG are accepted, mirroring the client-side rule.
      const declared = (m[1] ?? "").split(";")[0].toLowerCase();
      if (!ALLOWED_IMAGE_TYPES.includes(declared)) {
        console.warn("[tenant-self-onboarding] rejected image type", bucket, declared);
        return null;
      }
      const contentType = declared === "image/jpg" ? "image/jpeg" : declared;
      let raw: Uint8Array;
      try {
        raw = Uint8Array.from(atob(m[2].replace(/\s/g, "")), (c) => c.charCodeAt(0));
      } catch {
        console.warn("[tenant-self-onboarding] undecodable image payload", bucket);
        return null;
      }
      if (raw.byteLength === 0) return null;
      if (raw.byteLength > MAX_IMAGE_BYTES) {
        console.warn("[tenant-self-onboarding] image over size limit", bucket, raw.byteLength);
        return null;
      }
      // Magic-byte check: JPEG starts FF D8 FF, PNG starts 89 50 4E 47.
      const isJpeg = raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff;
      const isPng = raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47;
      if (!(isJpeg || isPng)) {
        console.warn("[tenant-self-onboarding] image failed signature check", bucket);
        return null;
      }
      const { error: upErr } = await admin.storage.from(bucket)
        .upload(path, raw, { contentType, cacheControl: "86400", upsert: true });
      if (upErr) { console.warn("[tenant-self-onboarding] upload failed", bucket, upErr.message); return null; }
      return path;
    };
    /** Public bucket helper — returns the public URL. */
    const uploadDataUrl = async (dataUrl: string, path: string): Promise<string | null> => {
      const stored = await uploadTo("house-images", dataUrl, path);
      return stored ? admin.storage.from("house-images").getPublicUrl(stored).data.publicUrl : null;
    };

    let tenantPhotoUrl: string | null = null;
    if (tenant_photo && tenant_photo.startsWith("data:")) {
      tenantPhotoUrl = await uploadDataUrl(tenant_photo, `${userId}/${assetFolder}/tenant.jpg`);
    } else if (tenant_photo && /^https?:\/\//.test(tenant_photo)) {
      // Already-hosted photo (e.g. restored from a draft) — keep it as-is.
      tenantPhotoUrl = tenant_photo;
    }
    if (!tenantPhotoUrl) {
      // Last resort: an existing profile photo satisfies the same requirement.
      const { data: prof } = await admin
        .from("profiles").select("avatar_url").eq("id", userId).maybeSingle();
      if (prof?.avatar_url) tenantPhotoUrl = prof.avatar_url as string;
    }
    if (!tenantPhotoUrl) {
      // Stop here with a clear message rather than letting the DB trigger
      // reject the insert with a 500.
      return err("Your passport photo is required as a JPG, JPEG or PNG image under 5 MB. Please retake it and try again.", 400);
    }


    /* ---- The rent request itself (normal pipeline) ------------------------ */
    const insertPayload: Record<string, unknown> = {
      tenant_id: userId,
      agent_id: referringAgentId,
      landlord_id: landlordId,
      lc1_id: lc1Id,
      rent_amount,
      duration_days,
      repayment_frequency,
      access_fee: 0, request_fee: 0, total_repayment: 0, daily_repayment: 0,
      status: "pending",
      house_category,
      request_latitude: gps_lat,
      request_longitude: gps_lng,
      request_city: district || null,
      request_country: "Uganda",
      preferred_language,
      tenant_no_smartphone: smartphone === "NO",
      registration_type: "normal",
      // Present at INSERT so the tenant-photo trigger is satisfied.
      tenant_photo_url: tenantPhotoUrl,
    };
    const { data: rentReq, error: rErr } = await admin
      .from("rent_requests").insert(insertPayload as any).select("id, rent_amount, duration_days, access_fee, request_fee, total_repayment, daily_repayment").single();
    if (rErr || !rentReq) return err(`Could not post your rent request: ${rErr?.message ?? "unknown"}`, 500);

    /* ---- Remaining documents -------------------------------------------- */
    const houseUrls: string[] = [];
    for (let i = 0; i < Math.min(house_photos.length, 4); i++) {
      const url = await uploadDataUrl(house_photos[i], `${userId}/${assetFolder}/house_${i}.jpg`);
      if (url) houseUrls.push(url);
    }
    // National ID and the LC1 letter are private documents.
    let ninPhotoPath: string | null = null;
    if (id_photo) ninPhotoPath = await uploadTo("tenant-ids", id_photo, `${userId}/${assetFolder}/national_id.jpg`);
    let lcLetterPath: string | null = null;
    if (lc_letter) lcLetterPath = await uploadTo("lc-letters", lc_letter, `${userId}/${assetFolder}/lc_letter.jpg`);

    if (houseUrls.length || ninPhotoPath || lcLetterPath) {
      const patch: Record<string, unknown> = {};
      if (houseUrls.length) patch.house_image_urls = houseUrls;
      if (ninPhotoPath) { patch.nin_photo_path = ninPhotoPath; patch.nin_photo_bucket = "tenant-ids"; }
      if (lcLetterPath) { patch.lc_letter_path = lcLetterPath; patch.lc_letter_bucket = "lc-letters"; }
      await admin.from("rent_requests").update(patch).eq("id", rentReq.id);
    }
    if (tenantPhotoUrl) await admin.from("profiles").update({ avatar_url: tenantPhotoUrl }).eq("id", userId);

    /* Link the stored passport photo to the fingerprint recorded when it was
       checked, so hash + verdict + photo + request stay together. */
    if (tenant_photo_sha256) {
      const { error: fpErr } = await admin
        .from("identity_photo_fingerprints")
        .upsert({
          user_id: userId,
          sha256: tenant_photo_sha256,
          source: "tenant_onboarding",
          photo_url: tenantPhotoUrl,
          rent_request_id: rentReq.id,
        }, { onConflict: "user_id,sha256" });
      if (fpErr) console.warn("[tenant-self-onboarding] fingerprint link failed", fpErr.message);
    }


    /* ---- Event trail + trust signal ------------------------------------- */
    await admin.from("system_events").insert({
      event_type: "rent_request_created",
      user_id: userId,
      metadata: {
        source: "tenant_self_onboarding",
        rent_request_id: rentReq.id,
        rent_amount, duration_days, repayment_frequency,
        village, district, ug_village_id,
        landlord_id: landlordId, lc1_id: lc1Id,
        gps: gps_lat && gps_lng ? { lat: gps_lat, lng: gps_lng } : null,
        house_photos: houseUrls.length,
        house_photo_urls: houseUrls,
        tenant_photo_url: tenantPhotoUrl,
        national_id_photo: ninPhotoPath ? { bucket: "tenant-ids", path: ninPhotoPath } : null,
        lc_letter: lcLetterPath ? { bucket: "lc-letters", path: lcLetterPath } : null,
        tenant_note: tenant_note || null,
         referring_agent_id: referringAgentId,
      },
    } as any).then(({ error }) => { if (error) console.warn("[tenant-self-onboarding] event failed", error.message); });

    if (gps_lat && gps_lng) {
      const { error: tErr } = await admin.rpc("capture_trust_signal", {
        p_tenant_id: userId,
        p_signal_type: "location_shared",
        p_venue_category: "home",
        p_venue_name: village || null,
        p_latitude: gps_lat,
        p_longitude: gps_lng,
        p_accuracy: typeof body.gps_accuracy === "number" ? body.gps_accuracy : null,
        p_notes: `tenant_self_onboarding:${rentReq.id}`,
      } as any);
      if (tErr) console.warn("[tenant-self-onboarding] trust signal failed", tErr.message);
    }

    return ok({ success: true, rent_request_id: rentReq.id, request: rentReq });
  } catch (e: any) {
    console.error("[tenant-self-onboarding] unhandled", e?.message || e);
    return err(`Service error: ${e?.message || "unknown"}`, 500);
  }
});
