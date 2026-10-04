import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return errorResponse("Unauthorized", 401);

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: allowedRoles } = await adminClient
      .from("user_roles").select("role")
      .eq("user_id", user.id)
      .in("role", ["coo", "operations", "manager", "super_admin", "cfo", "cto"]);
    if (!allowedRoles || allowedRoles.length === 0) return errorResponse("Only COO, Operations, or authorized staff can import partners", 403);

    // Parse body
    const { partners } = await req.json() as {
      partners: {
        partner_name: string;
        phone: string;
        email: string | null;
        portfolios: {
          amount: number;
          roiPercentage: number;
          durationMonths: number;
          roiMode: string;
          contributionDate?: string | null;
        }[];
      }[];
    };

    if (!partners || !Array.isArray(partners) || partners.length === 0) {
      return errorResponse("No partners provided", 400);
    }
    if (partners.length > 200) {
      return errorResponse("Maximum 200 partners per import", 400);
    }

    let partnersCreated = 0;
    let partnersMatched = 0;
    let portfoliosCreated = 0;
    const credentials: { partner: string; temp_password: string }[] = [];
    let skippedDuplicates = 0;
    const errors: { partner: string; error: string }[] = [];

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const seq = () => String(Math.floor(1000 + Math.random() * 9000));

    for (const partner of partners) {
      try {
        // Validate
        if (!partner.partner_name?.trim()) {
          pushImportError(errors, partner.phone || 'Unknown partner', 'Missing partner name. Add the Partner Name/Supporter Name column value for this row.', 'Missing partner name.');
          continue;
        }
        // Phone is optional. If blank/missing, omit it completely so email-only
        // partner imports are not blocked by phone-specific auth/profile triggers.
        const suppliedPhone = partner.phone?.trim() || null;
        const hasPhone = !!suppliedPhone && suppliedPhone.length >= 10;

        // Normalise the phone to its Uganda local-9 form so we match an
        // existing profile regardless of the stored format (0780…, 256780…,
        // +256780…, 780…). Matching only the exact string caused false
        // "duplicate" errors: the lookup missed the existing user, then auth
        // creation collided on the generated placeholder email.
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

        // Check for an existing profile by normalised phone, then by real email.
        let existing: { id: string } | null = null;
        if (hasPhone && phoneFormats.length) {
          const { data: found } = await adminClient
            .from("profiles").select("id")
            .in("phone", phoneFormats).limit(1).maybeSingle();
          existing = found;
        }
        if (!existing && realEmail) {
          const { data: foundByEmail } = await adminClient
            .from("profiles").select("id")
            .ilike("email", realEmail).limit(1).maybeSingle();
          existing = foundByEmail;
        }

        let userId: string;

        if (existing) {
          // Existing user — add portfolios to their account instead of skipping
          userId = existing.id;

          // Ensure they have the supporter role
          const { data: existingRole } = await adminClient
            .from("user_roles").select("id")
            .eq("user_id", userId).eq("role", "supporter").maybeSingle();
          if (!existingRole) {
            const { error: roleErr } = await adminClient.from("user_roles").insert({ user_id: userId, role: "supporter" });
            if (roleErr) {
              pushImportError(errors, partner.partner_name, roleErr, "Could not assign the supporter role to this existing user. Please confirm the account is active and try again.");
              continue;
            }
          }

          // Deliberately do NOT touch the password of an account that already
          // exists: overwriting it with an import-time credential would lock
          // the real owner out and hand access to whoever ran the import.
          // Use the dedicated temporary-password tool if a reset is needed.

          // Keep the contact email on the profile. Do not force-update Auth email here:
          // old/imported Auth records can already own the address while the profile is
          // missing, which caused false "email not in system" import failures.
          if (realEmail) {
            const { error: profileEmailErr } = await adminClient
              .from("profiles")
              .update({ email: realEmail, full_name: partner.partner_name.trim() })
              .eq("id", userId);
            if (profileEmailErr) {
              pushImportError(errors, partner.partner_name, profileEmailErr, "Could not save this partner's contact email on their profile.");
              continue;
            }
          }
          // Existing partner — count so the results screen doesn't show
          // "0 Partners" when portfolios were actually added to their account.
          partnersMatched++;
        } else {
          // Create auth user with a unique, random temporary password
          const tempPassword = generateTempPassword();
          // Generate email: use the real email when supplied, otherwise a
          // GLOBALLY-UNIQUE placeholder. Placeholders always carry a random
          // suffix so a phone-derived address can never falsely collide with
          // another placeholder — login is by phone, not by this address.
          const placeholderLocal = local9 ?? crypto.randomUUID().slice(0, 9);
          const placeholderEmail = `${placeholderLocal}.${crypto.randomUUID().slice(0, 8)}@noapp.welile.user`;
          let authEmailUsed = realEmail ?? placeholderEmail;

          let { data: authData, error: authErr } = await adminClient.auth.admin.createUser({
            email: authEmailUsed,
            password: tempPassword,
            email_confirm: true,
            user_metadata: {
              full_name: partner.partner_name,
              ...(hasPhone ? { phone: suppliedPhone } : {}),
              contact_email: realEmail,
              intended_role: 'supporter',
            },
          });

          if (authErr || !authData.user) {
            // Surface the true reason in the function logs so failures are
            // never silently reduced to a generic "please try again".
            console.error(
              `[import-partners] createUser failed for "${partner.partner_name}" (email=${authEmailUsed}, hasPhone=${!!hasPhone}):`,
              JSON.stringify(authErr ?? { note: "no error but no user returned" }),
            );
            // If the real email is already reserved by an old/hidden Auth row
            // with no visible profile, do not fail the import. Create the login
            // account with a unique placeholder Auth email and store the real
            // email as the partner contact email on profiles below.
            if (realEmail && isEmailTakenError(authErr)) {
              const { data: recovered } = await adminClient
                .from("profiles").select("id")
                .ilike("email", realEmail).limit(1).maybeSingle();
              if (recovered?.id) {
                userId = recovered.id;
                // fall through to the shared profile/role/wallet upserts below
              } else {
                const { data: backfilled, error: backfillErr } = await adminClient.rpc("backfill_missing_profile_by_email", {
                  _email: realEmail,
                });
                const backfilledUserId = typeof backfilled === "object" && backfilled !== null
                  ? (backfilled as Record<string, unknown>).user_id
                  : null;

                if (!backfillErr && typeof backfilledUserId === "string" && backfilledUserId) {
                  userId = backfilledUserId;
                } else {
                  pushImportError(errors, partner.partner_name, backfillErr || authErr, `The email "${realEmail}" already exists in login records, but its partner profile could not be linked. Please check this email and try again.`);
                  continue;
                }
              }
            } else if (realEmail && authEmailUsed === realEmail) {
              // The account could not be created with the supplied REAL email
              // for some reason other than "already taken" (e.g. the auth
              // service rejected the address, or returned an empty result).
              // Do not block the import: retry once with a guaranteed-unique
              // placeholder email and keep the real email as the contact
              // address on the profile. Login is by phone, not this address.
              authEmailUsed = placeholderEmail;
              const retry = await adminClient.auth.admin.createUser({
                email: authEmailUsed,
                password: tempPassword,
                email_confirm: true,
                user_metadata: {
                  full_name: partner.partner_name,
                  ...(hasPhone ? { phone: suppliedPhone } : {}),
                  contact_email: realEmail,
                  intended_role: 'supporter',
                },
              });
              if (retry.error || !retry.data?.user) {
                console.error(
                  `[import-partners] placeholder retry failed for "${partner.partner_name}":`,
                  JSON.stringify(retry.error ?? { note: "no error but no user returned" }),
                );
                pushImportError(
                  errors,
                  partner.partner_name,
                  retry.error ?? authErr,
                  "Could not create the login account for this partner even with a fallback address. Please try again.",
                );
                continue;
              }
              authData = retry.data;
              userId = retry.data.user.id;
            } else {
              pushImportError(
                errors,
                partner.partner_name,
                authErr,
                "Could not create the login account for this partner. Please try again.",
              );
              continue;
            }
          }
          else {
            userId = authData.user.id;
          }

          if (!userId) { continue; }

          // Create/update profile. Phone is skipped when not supplied.
          const profileData: Record<string, any> = {
            id: userId,
            full_name: partner.partner_name.trim(),
            email: realEmail ?? authEmailUsed,
          };
          // Force a password change on first sign-in so the import-time
          // temporary credential cannot linger.
          profileData.must_change_password = true;
          if (hasPhone) profileData.phone = suppliedPhone;
          const { error: profileErr } = await adminClient.from("profiles").upsert(profileData);
          if (profileErr) {
            pushImportError(errors, partner.partner_name, profileErr, "Could not save the partner profile. Please check the name and phone number.");
            continue;
          }

          // Assign supporter role
          const { error: roleErr } = await adminClient.from("user_roles").upsert(
            { user_id: userId, role: "supporter" },
            { onConflict: "user_id,role", ignoreDuplicates: true },
          );
          if (roleErr) {
            pushImportError(errors, partner.partner_name, roleErr, "Could not assign the supporter role to this partner. Please try again.");
            continue;
          }

          // Create wallet
          const { error: walletErr } = await adminClient.from("wallets").upsert({
            user_id: userId,
            balance: 0,
          }, { onConflict: 'user_id' });
          if (walletErr) {
            pushImportError(errors, partner.partner_name, walletErr, "Could not prepare this partner's wallet record. Please try again.");
            continue;
          }

          partnersCreated++;
          credentials.push({ partner: partner.partner_name.trim(), temp_password: tempPassword });
        }

        // Create portfolios (with duplicate detection)
        for (const pf of partner.portfolios) {
          try {
            if (pf.amount < 50000 || pf.roiPercentage < 1 || pf.durationMonths < 1) {
              pushImportError(errors, partner.partner_name, `Invalid portfolio data: amount ${pf.amount}, return ${pf.roiPercentage}%, duration ${pf.durationMonths} months. Amount must be at least UGX 50,000, return must be at least 1%, and duration must be at least 1 month.`, "Invalid portfolio data.");
              continue;
            }

            // Check for existing portfolio with same amount, ROI, and duration for this user
            const { data: existingPortfolio } = await adminClient
              .from("investor_portfolios")
              .select("id")
              .eq("investor_id", userId)
              .eq("investment_amount", pf.amount)
              .eq("roi_percentage", pf.roiPercentage)
              .eq("duration_months", pf.durationMonths)
              .maybeSingle();

            if (existingPortfolio) {
              skippedDuplicates++;
              continue;
            }

            // Use contribution date as the start date if provided, otherwise use now
            const startDate = pf.contributionDate ? new Date(pf.contributionDate) : now;
            const isHistorical = pf.contributionDate && !isNaN(startDate.getTime());
            const effectiveStart = isHistorical ? startDate : now;

            const startYY = String(effectiveStart.getFullYear()).slice(-2);
            const startMM = String(effectiveStart.getMonth() + 1).padStart(2, "0");
            const startDD = String(effectiveStart.getDate()).padStart(2, "0");

            const portfolioCode = `WIP${startYY}${startMM}${startDD}${seq()}`;
            const portfolioPin = String(Math.floor(1000 + Math.random() * 9000));
            const activationToken = crypto.randomUUID();

            const maturityDate = new Date(effectiveStart);
            maturityDate.setMonth(maturityDate.getMonth() + pf.durationMonths);

            // First payout: 30 days from start date
            const firstPayoutMs = effectiveStart.getTime() + 30 * 24 * 60 * 60 * 1000;
            const firstPayout = new Date(firstPayoutMs);
            const nextRoiDate = `${firstPayout.getFullYear()}-${String(firstPayout.getMonth() + 1).padStart(2, "0")}-${String(firstPayout.getDate()).padStart(2, "0")}`;

            const insertData: Record<string, any> = {
              investor_id: userId,
              agent_id: userId, // Self-linked for imports (no agent)
              portfolio_code: portfolioCode,
              portfolio_pin: portfolioPin,
              activation_token: activationToken,
              investment_amount: pf.amount,
              roi_percentage: pf.roiPercentage,
              duration_months: pf.durationMonths,
              roi_mode: pf.roiMode,
              payout_day: null, // 30-day default cycle
              maturity_date: maturityDate.toISOString().split("T")[0],
              next_roi_date: nextRoiDate,
              status: "pending_approval",
            };

            // If historical date, set created_at to match
            if (isHistorical) {
              insertData.created_at = effectiveStart.toISOString();
            }

            const { error: portfolioErr } = await adminClient.from("investor_portfolios").insert(insertData);

            if (portfolioErr) {
              pushImportError(errors, partner.partner_name, portfolioErr, "Portfolio could not be created. Please check the amount, return mode, duration, contribution date, and whether the portfolio already exists.");
              continue;
            }

            portfoliosCreated++;
          } catch (pfErr: any) {
            pushImportError(errors, partner.partner_name, pfErr, "Portfolio could not be created. Please check the portfolio details and try again.");
          }
        }

        // Audit log
        const { error: auditErr } = await adminClient.from("audit_logs").insert({
          user_id: user.id,
          action_type: "partner_import",
          table_name: "profiles",
          record_id: userId,
          metadata: {
            reason: "Bulk partner portfolio import by authorized staff.",
            partner_name: partner.partner_name,
            phone: partner.phone,
            portfolio_count: partner.portfolios.length,
            imported_by: user.id,
          },
        });
        if (auditErr) {
          pushImportError(errors, partner.partner_name, auditErr, "The partner was imported, but the audit record could not be saved.");
        }

      } catch (partnerErr: any) {
        pushImportError(errors, partner.partner_name || partner.phone, partnerErr, partnerImportFallback(partner.partner_name));
      }
    }

    console.log(`[import-partners] COO ${user.id} imported: ${partnersCreated} partners, ${portfoliosCreated} portfolios, ${skippedDuplicates} skipped`);

    return new Response(JSON.stringify({
      partnersCreated,
      partnersMatched,
      portfoliosCreated,
      skippedDuplicates,
      credentials,
      errors,
    }), { status: 200, headers: JSON_HEADERS });

  } catch (err: any) {
    console.error("[import-partners] Error:", err.message);
    return errorResponse(err.message || "Internal error", 500);
  }
});
