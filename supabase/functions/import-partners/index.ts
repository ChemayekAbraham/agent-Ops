import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  callerIsPartnerStaff,
  POLICY_CHANGED_RESPONSE,
  RATE_NOTE_FOR_OTHER_STAFF,
  rateAwaitsCfo,
  rateIsPublicForRow,
  storedRate,
  typedRate,
  typedRateNeedsReload,
} from "../_shared/partnerReturnPolicy.ts";
import { bearerHasSub, noUserResult } from "../_shared/bearerHasSub.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

function errorResponse(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS });
}

function readableImportError(error: unknown, fallback = "The import could not complete for this partner."): string {
  if (!error) return fallback;

  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed || trimmed === "{}" || trimmed === "[object Object]") return fallback;
    return trimmed;
  }

  if (error instanceof Error) {
    return readableImportError(error.message, fallback);
  }

  const maybeRecord = error as Record<string, unknown>;
  const knownMessage = maybeRecord.message ?? maybeRecord.error ?? maybeRecord.details ?? maybeRecord.hint;
  if (knownMessage) return readableImportError(String(knownMessage), fallback);

  try {
    const json = JSON.stringify(error);
    if (!json || json === "{}") return fallback;
    return json;
  } catch {
    return fallback;
  }
}

function partnerImportFallback(partnerName?: string | null): string {
  const name = partnerName?.trim() || "this partner";
  return `We could not finish importing ${name}. Please check that the phone, email, and portfolio details are valid, then try again.`;
}

function isEmailTakenError(error: unknown): boolean {
  const msg = readableImportError(error, "").toLowerCase();
  return msg.includes("already") || msg.includes("registered") || msg.includes("duplicate") || msg.includes("unique");
}

function isValidEmail(value: string | null): value is string {
  return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Each imported partner gets their OWN cryptographically random temporary
// password. A shared literal would let anyone who knows it sign into every
// freshly-imported investor account.
function rand(set: string): string {
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
  return set[Math.floor(r * set.length)];
}

function generateTempPassword(): string {
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "@#$%&*";
  const all = upper + lower + digits + symbols;
  const chars = [rand(upper), rand(upper), rand(lower), rand(lower), rand(digits), rand(digits), rand(symbols)];
  for (let i = 0; i < 6; i++) chars.push(rand(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000) * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return "Welile-" + chars.join("");
}

function pushImportError(
  errors: { partner: string; error: string }[],
  partner: string | null | undefined,
  error: unknown,
  fallback: string,
) {
  const partnerName = partner?.trim() || "Unknown partner";
  errors.push({ partner: partnerName, error: readableImportError(error, fallback) });
}

// ── Partner Returns (design v2 section 3.1.6) ───────────────────────────────
// Portfolios are inserted with a rate only when staff typed one; otherwise the database gate stores
// the partner's own rate. A typed rate that differs is stored at the partner's rate and queued for the
// CFO (the actor header below records who typed it). Lookups and inserts are batched; results are
// matched by client-made ids, never by order.

type ImportPortfolio = {
  amount: number;
  roiPercentage?: number | string | null;
  durationMonths: number;
  roiMode: string;
  contributionDate?: string | null;
};
type ImportPartner = {
  partner_name: string;
  phone: string;
  email: string | null;
  portfolios: ImportPortfolio[];
};

interface PartnerWork {
  input: ImportPartner;
  name: string;
  suppliedPhone: string | null;
  hasPhone: boolean;
  local9: string | null;
  phoneFormats: string[];
  realEmail: string | null;
  userId: string | null;
  isNew: boolean;
  tempPassword: string | null;
  authEmailUsed: string | null;
  failed: boolean;
}

interface PortfolioCandidate {
  partner: PartnerWork;
  key: string;
  typed: number | null;
  row: Record<string, unknown>;
}

const PHONE_FORMATS_PER_SELECT = 150;
const EMAILS_PER_RPC = 500;
const IDS_PER_SELECT = 100;
const ROWS_PER_INSERT = 100;
const PAGE = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const cents = (n: number) => Math.round(n * 100);
const dupKey = (investor: string, amount: unknown, duration: unknown) =>
  `${investor}|${Number(amount)}|${Number(duration)}`;

const NEW_PARTNER_TYPED_MESSAGE =
  "Not on the books at the cut-off: Returns start at the new-partner rate; the typed rate waits for the CFO.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Auth — verify COO role
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing authorization", 401);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await (bearerHasSub(authHeader) ? userClient.auth.getUser() : noUserResult());
    if (userErr || !user) return errorResponse("Unauthorized", 401);

    // Built per request with the caller as x-welile-actor, so a typed rate the gate queues for the
    // CFO records who typed it (trg_portfolio_rate_requests_stamp_actor; service role only).
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { "x-welile-actor": user.id } },
      auth: { persistSession: false },
    });

    const { data: allowedRoles } = await adminClient
      .from("user_roles").select("role")
      .eq("user_id", user.id)
      .in("role", ["coo", "operations", "manager", "super_admin", "cfo", "cto"]);
    if (!allowedRoles || allowedRoles.length === 0) return errorResponse("Only COO, Operations, or authorized staff can import partners", 403);

    // Parse body
    const { partners, policy_enabled_seen } = await req.json() as {
      partners: ImportPartner[];
      policy_enabled_seen?: boolean;
    };

    if (!partners || !Array.isArray(partners) || partners.length === 0) {
      return errorResponse("No partners provided", 400);
    }
    if (partners.length > 200) {
      return errorResponse("Maximum 200 partners per import", 400);
    }

    // A screen that typed a rate without seeing the switch on is stale once it is on (409, before
    // any write).
    const anyTyped = partners.some((p) =>
      Array.isArray(p?.portfolios) && p.portfolios.some((pf) => typedRate(pf?.roiPercentage) !== null)
    );
    if (await typedRateNeedsReload(adminClient, anyTyped, policy_enabled_seen)) {
      return new Response(JSON.stringify(POLICY_CHANGED_RESPONSE), { status: 409, headers: JSON_HEADERS });
    }

    let partnersCreated = 0;
    let partnersMatched = 0;
    let portfoliosCreated = 0;
    const credentials: { partner: string; temp_password: string }[] = [];
    let skippedDuplicates = 0;
    const errors: { partner: string; error: string }[] = [];

    const now = new Date();
    const seq = () => String(Math.floor(1000 + Math.random() * 9000));

    // ── Pass 1, step 1: normalise every partner ─────────────────────────────
    const work: PartnerWork[] = [];
    for (const partner of partners) {
      try {
        if (!partner?.partner_name?.trim()) {
          pushImportError(errors, partner?.phone || 'Unknown partner', 'Missing partner name. Add the Partner Name/Supporter Name column value for this row.', 'Missing partner name.');
          continue;
        }
        // Phone is optional. If blank/missing, omit it completely so email-only
        // partner imports are not blocked by phone-specific auth/profile triggers.
        const suppliedPhone = partner.phone?.trim() || null;
        const hasPhone = !!suppliedPhone && suppliedPhone.length >= 10;

        // Normalise the phone to its Uganda local-9 form so we match an
        // existing profile regardless of the stored format (0780…, 256780…,
        // +256780…, 780…).
        const digits = (suppliedPhone || "").replace(/\D/g, "");
        const local9 = digits.length >= 9 ? digits.slice(-9) : null;
        const phoneFormats = local9
          ? [local9, `0${local9}`, `256${local9}`, `+256${local9}`]
          : [];
        const rawEmail = partner.email?.trim().toLowerCase() || null;
        const realEmail =
          rawEmail && !rawEmail.includes("@noapp.welile") && !rawEmail.includes("@welile.user")
            ? rawEmail
            : null;

        if (realEmail && !isValidEmail(realEmail)) {
          pushImportError(errors, partner.partner_name, `Invalid email address: ${realEmail}`, "Invalid email address.");
          continue;
        }

        work.push({
          input: partner,
          name: partner.partner_name.trim(),
          suppliedPhone,
          hasPhone,
          local9,
          phoneFormats,
          realEmail,
          userId: null,
          isNew: false,
          tempPassword: null,
          authEmailUsed: null,
          failed: false,
        });
      } catch (partnerErr: unknown) {
        pushImportError(errors, partner?.partner_name || partner?.phone, partnerErr, partnerImportFallback(partner?.partner_name));
      }
    }

    // ── Pass 1, step 2: existing profiles by phone (one select per 150 formats) ──
    // A failed lookup aborts the import before any write: guessing "not found" would create
    // duplicate accounts.
    const idByLocal9 = new Map<string, string>();
    const formats = [...new Set(work.filter((w) => w.hasPhone).flatMap((w) => w.phoneFormats))];
    for (const part of chunk(formats, PHONE_FORMATS_PER_SELECT)) {
      const { data, error } = await adminClient.from("profiles").select("id, phone").in("phone", part);
      if (error) {
        console.error("[import-partners] phone lookup failed:", error.message);
        return errorResponse("Could not look up existing partners by phone. Nothing was imported; please try again.", 500);
      }
      for (const row of (data ?? []) as { id: string; phone: string | null }[]) {
        const d = String(row.phone ?? "").replace(/\D/g, "");
        if (d.length >= 9 && !idByLocal9.has(d.slice(-9))) idByLocal9.set(d.slice(-9), row.id);
      }
    }
    for (const w of work) {
      if (w.hasPhone && w.local9 && idByLocal9.has(w.local9)) w.userId = idByLocal9.get(w.local9)!;
    }

    // ── Pass 1, step 3: existing profiles by real email (one RPC per 500 emails) ──
    const idByEmail = new Map<string, string>();
    const lookupEmails = async (emails: string[]): Promise<boolean> => {
      for (const part of chunk([...new Set(emails)], EMAILS_PER_RPC)) {
        const { data, error } = await adminClient.rpc("profile_ids_by_emails", { p_emails: part });
        if (error) {
          console.error("[import-partners] email lookup failed:", error.message);
          return false;
        }
        for (const row of (data ?? []) as { email: string; id: string }[]) {
          const e = String(row.email ?? "").toLowerCase();
          if (e && !idByEmail.has(e)) idByEmail.set(e, row.id);
        }
      }
      return true;
    };
    if (!await lookupEmails(work.filter((w) => !w.userId && w.realEmail).map((w) => w.realEmail!))) {
      return errorResponse("Could not look up existing partners by email. Nothing was imported; please try again.", 500);
    }
    for (const w of work) {
      if (!w.userId && w.realEmail && idByEmail.has(w.realEmail)) w.userId = idByEmail.get(w.realEmail)!;
    }

    // ── Pass 1, step 4: supporter role for existing users (one select, one bulk insert) ──
    const existingWork = work.filter((w) => w.userId);
    const existingIds = [...new Set(existingWork.map((w) => w.userId!))];
    const hasSupporter = new Set<string>();
    for (const part of chunk(existingIds, IDS_PER_SELECT)) {
      const { data, error } = await adminClient
        .from("user_roles").select("user_id").in("user_id", part).eq("role", "supporter");
      if (error) {
        console.error("[import-partners] supporter role lookup failed:", error.message);
        return errorResponse("Could not check partner roles. Nothing was imported; please try again.", 500);
      }
      for (const row of (data ?? []) as { user_id: string }[]) hasSupporter.add(row.user_id);
    }
    const missingRole = existingIds.filter((id) => !hasSupporter.has(id));
    const roleFailed = new Map<string, unknown>();
    if (missingRole.length > 0) {
      const { error } = await adminClient.from("user_roles").upsert(
        missingRole.map((id) => ({ user_id: id, role: "supporter" })),
        { onConflict: "user_id,role", ignoreDuplicates: true },
      );
      if (error) {
        // Retry one by one so each partner keeps its own error.
        for (const id of missingRole) {
          const { error: oneErr } = await adminClient.from("user_roles").upsert(
            { user_id: id, role: "supporter" },
            { onConflict: "user_id,role", ignoreDuplicates: true },
          );
          if (oneErr) roleFailed.set(id, oneErr);
        }
      }
    }

    // ── Pass 1, step 5: per partner where needed (profile email of existing users; new logins) ──
    for (const w of work) {
      try {
        if (w.userId) {
          // Existing user — add portfolios to their account instead of skipping.
          if (roleFailed.has(w.userId)) {
            pushImportError(errors, w.input.partner_name, roleFailed.get(w.userId), "Could not assign the supporter role to this existing user. Please confirm the account is active and try again.");
            w.failed = true;
            continue;
          }
          // Deliberately do NOT touch the password of an account that already
          // exists: overwriting it with an import-time credential would lock
          // the real owner out and hand access to whoever ran the import.
          // Keep the contact email on the profile. Do not force-update Auth email here:
          // old/imported Auth records can already own the address while the profile is
          // missing, which caused false "email not in system" import failures.
          if (w.realEmail) {
            const { error: profileEmailErr } = await adminClient
              .from("profiles")
              .update({ email: w.realEmail, full_name: w.name })
              .eq("id", w.userId);
            if (profileEmailErr) {
              pushImportError(errors, w.input.partner_name, profileEmailErr, "Could not save this partner's contact email on their profile.");
              w.failed = true;
              continue;
            }
          }
          partnersMatched++;
          continue;
        }

        // An earlier row of this file may have just created the same person.
        const sameAsEarlier = (w.hasPhone && w.local9 && idByLocal9.get(w.local9)) ||
          (w.realEmail && idByEmail.get(w.realEmail)) || null;
        if (sameAsEarlier) {
          w.userId = sameAsEarlier;
          partnersMatched++;
          continue;
        }

        // Create auth user with a unique, random temporary password
        const tempPassword = generateTempPassword();
        // Generate email: use the real email when supplied, otherwise a
        // GLOBALLY-UNIQUE placeholder. Placeholders always carry a random
        // suffix so a phone-derived address can never falsely collide with
        // another placeholder — login is by phone, not by this address.
        const placeholderLocal = w.local9 ?? crypto.randomUUID().slice(0, 9);
        const placeholderEmail = `${placeholderLocal}.${crypto.randomUUID().slice(0, 8)}@noapp.welile.user`;
        let authEmailUsed = w.realEmail ?? placeholderEmail;
        let userId: string | null = null;

        const userMetadata = {
          full_name: w.input.partner_name,
          ...(w.hasPhone ? { phone: w.suppliedPhone } : {}),
          contact_email: w.realEmail,
          intended_role: 'supporter',
        };
        const { data: authData, error: authErr } = await adminClient.auth.admin.createUser({
          email: authEmailUsed,
          password: tempPassword,
          email_confirm: true,
          user_metadata: userMetadata,
        });

        if (authErr || !authData.user) {
          // Surface the true reason in the function logs so failures are
          // never silently reduced to a generic "please try again".
          console.error(
            `[import-partners] createUser failed for "${w.input.partner_name}" (email=${authEmailUsed}, hasPhone=${!!w.hasPhone}):`,
            JSON.stringify(authErr ?? { note: "no error but no user returned" }),
          );
          // If the real email is already reserved by an old/hidden Auth row
          // with no visible profile, do not fail the import. Link the profile
          // that owns it, or backfill one.
          if (w.realEmail && isEmailTakenError(authErr)) {
            const { data: recovered } = await adminClient.rpc("profile_ids_by_emails", { p_emails: [w.realEmail] });
            const recoveredId = Array.isArray(recovered) && recovered.length > 0 ? (recovered[0] as { id?: string }).id : null;
            if (recoveredId) {
              userId = recoveredId;
            } else {
              const { data: backfilled, error: backfillErr } = await adminClient.rpc("backfill_missing_profile_by_email", {
                _email: w.realEmail,
              });
              const backfilledUserId = typeof backfilled === "object" && backfilled !== null
                ? (backfilled as Record<string, unknown>).user_id
                : null;

              if (!backfillErr && typeof backfilledUserId === "string" && backfilledUserId) {
                userId = backfilledUserId;
              } else {
                pushImportError(errors, w.input.partner_name, backfillErr || authErr, `The email "${w.realEmail}" already exists in login records, but its partner profile could not be linked. Please check this email and try again.`);
                w.failed = true;
                continue;
              }
            }
          } else if (w.realEmail && authEmailUsed === w.realEmail) {
            // The account could not be created with the supplied REAL email
            // for some reason other than "already taken". Retry once with a
            // guaranteed-unique placeholder email and keep the real email as
            // the contact address on the profile.
            authEmailUsed = placeholderEmail;
            const retry = await adminClient.auth.admin.createUser({
              email: authEmailUsed,
              password: tempPassword,
              email_confirm: true,
              user_metadata: userMetadata,
            });
            if (retry.error || !retry.data?.user) {
              console.error(
                `[import-partners] placeholder retry failed for "${w.input.partner_name}":`,
                JSON.stringify(retry.error ?? { note: "no error but no user returned" }),
              );
              pushImportError(
                errors,
                w.input.partner_name,
                retry.error ?? authErr,
                "Could not create the login account for this partner even with a fallback address. Please try again.",
              );
              w.failed = true;
              continue;
            }
            userId = retry.data.user.id;
          } else {
            pushImportError(
              errors,
              w.input.partner_name,
              authErr,
              "Could not create the login account for this partner. Please try again.",
            );
            w.failed = true;
            continue;
          }
        } else {
          userId = authData.user.id;
        }

        if (!userId) { w.failed = true; continue; }
        w.userId = userId;
        w.isNew = true;
        w.tempPassword = tempPassword;
        w.authEmailUsed = authEmailUsed;
        if (w.hasPhone && w.local9) idByLocal9.set(w.local9, userId);
        if (w.realEmail) idByEmail.set(w.realEmail, userId);
      } catch (partnerErr: unknown) {
        pushImportError(errors, w.input.partner_name || w.input.phone, partnerErr, partnerImportFallback(w.input.partner_name));
        w.failed = true;
      }
    }

    // ── Pass 1, step 6: bulk profile upsert and bulk supporter role for new logins ──
    // Rows with and without a phone go in separate upserts so a missing phone never overwrites a
    // stored one (a bulk upsert sends the union of keys).
    const newWork = work.filter((w) => w.isNew && !w.failed && w.userId);
    const profileRow = (w: PartnerWork) => ({
      id: w.userId!,
      full_name: w.name,
      email: w.realEmail ?? w.authEmailUsed,
      // Force a password change on first sign-in so the import-time
      // temporary credential cannot linger.
      must_change_password: true,
      ...(w.hasPhone ? { phone: w.suppliedPhone } : {}),
    });
    for (const group of [newWork.filter((w) => w.hasPhone), newWork.filter((w) => !w.hasPhone)]) {
      if (group.length === 0) continue;
      const { error } = await adminClient.from("profiles").upsert(group.map(profileRow));
      if (!error) continue;
      for (const w of group) {
        const { error: oneErr } = await adminClient.from("profiles").upsert(profileRow(w));
        if (oneErr) {
          pushImportError(errors, w.input.partner_name, oneErr, "Could not save the partner profile. Please check the name and phone number.");
          w.failed = true;
        }
      }
    }
    const newOk = newWork.filter((w) => !w.failed);
    if (newOk.length > 0) {
      const { error } = await adminClient.from("user_roles").upsert(
        newOk.map((w) => ({ user_id: w.userId!, role: "supporter" })),
        { onConflict: "user_id,role", ignoreDuplicates: true },
      );
      if (error) {
        for (const w of newOk) {
          const { error: oneErr } = await adminClient.from("user_roles").upsert(
            { user_id: w.userId!, role: "supporter" },
            { onConflict: "user_id,role", ignoreDuplicates: true },
          );
          if (oneErr) {
            pushImportError(errors, w.input.partner_name, oneErr, "Could not assign the supporter role to this partner. Please try again.");
            w.failed = true;
          }
        }
      }
    }
    for (const w of newOk) {
      if (w.failed) continue;
      // Signup trigger inserts wallets_physical. public.wallets is a read-only view.
      partnersCreated++;
      credentials.push({ partner: w.name, temp_password: w.tempPassword! });
    }

    // ── Pass 2, step 1: candidate portfolio rows (client-made ids) ──
    const ready = work.filter((w) => !w.failed && w.userId);
    const usedCodes = new Set<string>();
    const candidates: PortfolioCandidate[] = [];
    for (const w of ready) {
      for (const pf of Array.isArray(w.input.portfolios) ? w.input.portfolios : []) {
        try {
          const amount = Number(pf?.amount);
          const durationMonths = Number(pf?.durationMonths);
          const t = typedRate(pf?.roiPercentage);
          // Origin's lower bound is kept: a typed rate below 1% is refused. With a typed rate the
          // message is origin's, word for word; a row without one gets the same check minus the rate.
          const rateBelowOne = t !== null && Number(pf?.roiPercentage) < 1;
          if (!Number.isFinite(amount) || amount < 50000 || !Number.isFinite(durationMonths) || durationMonths < 1 || rateBelowOne) {
            pushImportError(
              errors,
              w.input.partner_name,
              t !== null
                ? `Invalid portfolio data: amount ${pf?.amount}, return ${pf?.roiPercentage}%, duration ${pf?.durationMonths} months. Amount must be at least UGX 50,000, return must be at least 1%, and duration must be at least 1 month.`
                : `Invalid portfolio data: amount ${pf?.amount}, duration ${pf?.durationMonths} months. Amount must be at least UGX 50,000 and duration must be at least 1 month.`,
              "Invalid portfolio data.",
            );
            continue;
          }
          if (t === "invalid") {
            pushImportError(errors, w.input.partner_name, `Monthly Returns rate must be above 0% and at most 100% (got ${pf.roiPercentage}).`, "Monthly Returns rate must be above 0% and at most 100%.");
            continue;
          }

          // Use contribution date as the start date if provided, otherwise use now
          const startDate = pf.contributionDate ? new Date(pf.contributionDate) : now;
          const isHistorical = !!pf.contributionDate && !isNaN(startDate.getTime());
          const effectiveStart = isHistorical ? startDate : now;

          const startYY = String(effectiveStart.getFullYear()).slice(-2);
          const startMM = String(effectiveStart.getMonth() + 1).padStart(2, "0");
          const startDD = String(effectiveStart.getDate()).padStart(2, "0");

          let portfolioCode = `WIP${startYY}${startMM}${startDD}${seq()}`;
          for (let i = 0; i < 20 && usedCodes.has(portfolioCode); i++) {
            portfolioCode = `WIP${startYY}${startMM}${startDD}${seq()}`;
          }
          usedCodes.add(portfolioCode);

          const maturityDate = new Date(effectiveStart);
          maturityDate.setMonth(maturityDate.getMonth() + durationMonths);

          // First payout: 30 days from start date
          const firstPayout = new Date(effectiveStart.getTime() + 30 * 24 * 60 * 60 * 1000);
          const nextRoiDate = `${firstPayout.getFullYear()}-${String(firstPayout.getMonth() + 1).padStart(2, "0")}-${String(firstPayout.getDate()).padStart(2, "0")}`;

          const row: Record<string, unknown> = {
            id: crypto.randomUUID(),
            investor_id: w.userId,
            agent_id: w.userId, // Self-linked for imports (no agent)
            portfolio_code: portfolioCode,
            portfolio_pin: String(Math.floor(1000 + Math.random() * 9000)),
            activation_token: crypto.randomUUID(),
            investment_amount: amount,
            duration_months: durationMonths,
            roi_mode: pf.roiMode,
            payout_day: null, // 30-day default cycle
            maturity_date: maturityDate.toISOString().split("T")[0],
            next_roi_date: nextRoiDate,
            status: "pending_approval",
          };
          if (t !== null) row.roi_percentage = t;               // typed only; else the gate decides
          if (isHistorical) row.created_at = effectiveStart.toISOString();

          candidates.push({ partner: w, key: dupKey(w.userId!, amount, durationMonths), typed: t, row });
        } catch (pfErr: unknown) {
          pushImportError(errors, w.input.partner_name, pfErr, "Portfolio could not be created. Please check the portfolio details and try again.");
        }
      }
    }

    // ── Pass 2, steps 2-3: existing portfolios and their rate requests (batched) ──
    const existingByKey = new Map<string, { id: string; roi_percentage: unknown }[]>();
    const candidateInvestors = [...new Set(candidates.map((c) => c.partner.userId!))];
    for (const part of chunk(candidateInvestors, IDS_PER_SELECT)) {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await adminClient
          .from("investor_portfolios")
          .select("id, investor_id, investment_amount, duration_months, roi_percentage, status")
          .in("investor_id", part)
          .order("id")
          .range(from, from + PAGE - 1);
        if (error) {
          console.error("[import-partners] existing portfolio lookup failed:", error.message);
          return errorResponse("Could not check for existing portfolios. Partners were saved but no portfolio was imported; please run the import again.", 500);
        }
        const rows = (data ?? []) as { id: string; investor_id: string; investment_amount: unknown; duration_months: unknown; roi_percentage: unknown }[];
        for (const p of rows) {
          const k = dupKey(p.investor_id, p.investment_amount, p.duration_months);
          const list = existingByKey.get(k) ?? [];
          list.push({ id: p.id, roi_percentage: p.roi_percentage });
          existingByKey.set(k, list);
        }
        if (rows.length < PAGE) break;
      }
    }
    // Rate requests (any status and source) of the existing rows a typed candidate could match.
    const requestedByPortfolio = new Map<string, number[]>();
    const toCheck = [...new Set(candidates
      .filter((c) => c.typed !== null)
      .flatMap((c) => (existingByKey.get(c.key) ?? [])
        .filter((e) => { const s = storedRate(e); return s === null || cents(s) !== cents(c.typed!); })
        .map((e) => e.id)))];
    for (const part of chunk(toCheck, IDS_PER_SELECT)) {
      const { data, error } = await adminClient
        .from("portfolio_rate_approvals").select("portfolio_id, requested_rate").in("portfolio_id", part);
      if (error) {
        console.error("[import-partners] rate request lookup failed:", error.message);
        return errorResponse("Could not check for existing portfolios. Partners were saved but no portfolio was imported; please run the import again.", 500);
      }
      for (const r of (data ?? []) as { portfolio_id: string; requested_rate: unknown }[]) {
        const n = Number(r.requested_rate);
        if (!Number.isFinite(n)) continue;
        const list = requestedByPortfolio.get(r.portfolio_id) ?? [];
        list.push(n);
        requestedByPortfolio.set(r.portfolio_id, list);
      }
    }

    // ── Pass 2, step 4: duplicates (in memory) ──
    const seenInFile = new Set<string>();
    const toInsert: PortfolioCandidate[] = [];
    for (const c of candidates) {
      const fileKey = `${c.key}|${c.typed === null ? "gate" : cents(c.typed)}`;
      const existing = existingByKey.get(c.key) ?? [];
      const isDuplicate = seenInFile.has(fileKey) || (c.typed === null
        ? existing.length > 0
        : existing.some((e) => {
          const s = storedRate(e);
          if (s !== null && cents(s) === cents(c.typed!)) return true;
          return (requestedByPortfolio.get(e.id) ?? []).some((r) => cents(r) === cents(c.typed!));
        }));
      seenInFile.add(fileKey);
      if (isDuplicate) {
        skippedDuplicates++;
        continue;
      }
      toInsert.push(c);
    }

    // ── Pass 2, steps 5-6: insert per 100 rows; a failing chunk is retried row by row ──
    const inserted = new Map<string, { roi_percentage: unknown; rate_basis: unknown }>();
    for (const part of chunk(toInsert, ROWS_PER_INSERT)) {
      const { data, error } = await adminClient
        .from("investor_portfolios")
        .insert(part.map((c) => c.row), { defaultToNull: false })
        .select("id, roi_percentage, rate_basis");
      if (!error) {
        for (const r of (data ?? []) as { id: string; roi_percentage: unknown; rate_basis: unknown }[]) {
          inserted.set(r.id, { roi_percentage: r.roi_percentage, rate_basis: r.rate_basis });
        }
        continue;
      }
      for (const c of part) {
        const { data: one, error: oneErr } = await adminClient
          .from("investor_portfolios")
          .insert(c.row, { defaultToNull: false })
          .select("id, roi_percentage, rate_basis")
          .maybeSingle();
        if (oneErr || !one) {
          pushImportError(errors, c.partner.input.partner_name, oneErr, "Portfolio could not be created. Please check the amount, return mode, duration, contribution date, and whether the portfolio already exists.");
          continue;
        }
        inserted.set(one.id, { roi_percentage: one.roi_percentage, rate_basis: one.rate_basis });
      }
    }

    // Per-row results. Stored rates go back to partner staff only (owner decision D11), or to any
    // permitted caller when the row's rate applies to everyone (switch off).
    const callerIsStaff = await callerIsPartnerStaff(adminClient, user.id);
    let ratesAwaitingCfo = 0;
    let anyMasked = false;
    const portfolioResults: Record<string, unknown>[] = [];
    for (const c of toInsert) {
      const got = inserted.get(String(c.row.id));
      if (!got) continue;
      portfoliosCreated++;
      const stored = storedRate(got);
      const awaits = rateAwaitsCfo(c.typed, stored);
      const show = callerIsStaff || rateIsPublicForRow(got);
      if (show && awaits) ratesAwaitingCfo++;
      if (!show) anyMasked = true;
      portfolioResults.push({
        partner: c.partner.name,
        portfolio_code: c.row.portfolio_code,
        amount: c.row.investment_amount,
        duration_months: c.row.duration_months,
        ...(show
          ? { roi_percentage: stored, requested_roi_percentage: c.typed, rate_awaits_cfo: awaits }
          : {}),
        ...(got.rate_basis === "new" && awaits ? { message: NEW_PARTNER_TYPED_MESSAGE } : {}),
      });
    }

    // ── Pass 2, step 7: one bulk audit insert (one row per partner, as before) ──
    if (ready.length > 0) {
      const { error: auditErr } = await adminClient.from("audit_logs").insert(ready.map((w) => ({
        user_id: user.id,
        action_type: "partner_import",
        table_name: "profiles",
        record_id: w.userId,
        metadata: {
          reason: "Bulk partner portfolio import by authorized staff.",
          partner_name: w.input.partner_name,
          phone: w.input.phone,
          portfolio_count: Array.isArray(w.input.portfolios) ? w.input.portfolios.length : 0,
          imported_by: user.id,
        },
      })));
      if (auditErr) {
        for (const w of ready) {
          pushImportError(errors, w.input.partner_name, auditErr, "The partner was imported, but the audit record could not be saved.");
        }
      }
    }

    console.log(`[import-partners] COO ${user.id} imported: ${partnersCreated} partners, ${portfoliosCreated} portfolios, ${skippedDuplicates} skipped, ${ratesAwaitingCfo} typed rate(s) awaiting the CFO`);

    return new Response(JSON.stringify({
      partnersCreated,
      partnersMatched,
      portfoliosCreated,
      skippedDuplicates,
      credentials,
      errors,
      portfolios: portfolioResults,
      rates_awaiting_cfo: ratesAwaitingCfo,
      ...(anyMasked ? { rate_note: RATE_NOTE_FOR_OTHER_STAFF } : {}),
    }), { status: 200, headers: JSON_HEADERS });

  } catch (err: any) {
    console.error("[import-partners] Error:", err.message);
    return errorResponse(err.message || "Internal error", 500);
  }
});
