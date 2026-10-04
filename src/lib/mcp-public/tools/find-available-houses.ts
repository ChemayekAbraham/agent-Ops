import { createClient } from "@supabase/supabase-js";
import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { buildSignupLinks } from "../links";
import { enforceRateLimit } from "../rateLimit";
import { publicToolResult, spanRange, ugx, type EstimateRange } from "../response";

// PUBLIC, no-auth tool. Returns a small, read-only sample of AVAILABLE house
// listings by district/area for prospective tenants, then hands back the free
// tenant signup link so they can view details and apply. It reads with the
// anon key, so Row-Level Security ("Anyone can view available listings")
// guarantees only listings with status = 'available' are ever returned. Only
// non-sensitive fields are exposed — no exact address, GPS, landlord, caretaker
// phone, or LC1 details. All amounts are in UGX.

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

// Read env without referencing `process`/`Deno` directly: the bundle runs on
// Deno (env via Deno.env), but this file is also type-checked in the Vite build
// where those globals aren't declared. globalThis access avoids both a
// ReferenceError at runtime and a type error at build time.
function readEnv(name: string): string | undefined {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get(name) ?? g.process?.env?.[name];
}

// Anon Supabase client. Created inside the handler so this module stays
// import-safe (no env reads at import time — required by the MCP bundler).
function anonClient() {
  const url = readEnv("SUPABASE_URL");
  const anonKey =
    readEnv("SUPABASE_PUBLISHABLE_KEY") ?? readEnv("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new Error("Supabase env not configured");
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type ListingRow = {
  id: string;
  title: string | null;
  house_category: string | null;
  number_of_rooms: number | null;
  monthly_rent: number | null;
  region: string | null;
  district: string | null;
  sub_county: string | null;
  village: string | null;
  has_water: boolean | null;
  has_electricity: boolean | null;
  has_security: boolean | null;
  has_parking: boolean | null;
  is_furnished: boolean | null;
  verified: boolean | null;
  image_urls: string[] | null;
};

function amenityList(r: ListingRow): string[] {
  const out: string[] = [];
  if (r.has_water) out.push("water");
  if (r.has_electricity) out.push("electricity");
  if (r.has_security) out.push("security");
  if (r.has_parking) out.push("parking");
  if (r.is_furnished) out.push("furnished");
  return out;
}

function locationLabel(r: ListingRow): string {
  return [r.village, r.sub_county, r.district, r.region].filter(Boolean).join(", ") || "Location on request";
}

export default defineTool({
  name: "find_available_houses",
  title: "Find available houses",
  description:
    "Return a small read-only sample of AVAILABLE Welile house listings for a prospective tenant, filtered by district and/or area, then return the free tenant signup link to view details and apply. No sign-in required. Only public, non-sensitive fields are shown (no exact address, GPS, landlord, or contact details). Amounts are in UGX. Provide `district` and/or `area` to narrow the search, optional `max_rent` (UGX) and `limit` (1-10, default 5), and optional `referral_code` for a referral signup link.",
  inputSchema: {
    district: z
      .string()
      .describe("Optional district to search (e.g. 'Wakiso', 'Kampala').")
      .optional(),
    area: z
      .string()
      .describe("Optional area/neighbourhood — matches village, sub-county, district, or region.")
      .optional(),
    max_rent: z
      .number()
      .describe("Optional maximum monthly rent in UGX.")
      .optional(),
    limit: z
      .number()
      .describe("Optional number of listings to return (1-10, default 5).")
      .optional(),
    referral_code: z
      .string()
      .describe("Optional referral code (the referrer's Welile user id) to build a referral signup link.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ district, area, max_rent, limit, referral_code }) => {
    const limited = await enforceRateLimit("find_available_houses");
    if (limited) return limited;

    const { signupUrl, referralUrl, landingUrl } = buildSignupLinks({
      referralCode: referral_code,
      role: "tenant",
    });
    const links = { landing_url: landingUrl, signup_url: signupUrl, referral_url: referralUrl, role: "tenant" };

    const take = Math.min(MAX_LIMIT, Math.max(1, Math.round(limit ?? DEFAULT_LIMIT)));

    let query = anonClient()
      .from("house_listings")
      .select(
        "id,title,house_category,number_of_rooms,monthly_rent,region,district,sub_county,village,has_water,has_electricity,has_security,has_parking,is_furnished,verified,image_urls",
      )
      // RLS already restricts anon to status='available'; keep it explicit and
      // hide any listings flagged hidden.
      .eq("status", "available")
      .not("is_hidden", "is", true);

    const districtTerm = (district ?? "").trim();
    if (districtTerm) query = query.ilike("district", `%${districtTerm}%`);

    const areaTerm = (area ?? "").trim();
    if (areaTerm) {
      const like = `%${areaTerm}%`;
      query = query.or(
        `village.ilike.${like},sub_county.ilike.${like},district.ilike.${like},region.ilike.${like}`,
      );
    }

    if (typeof max_rent === "number" && Number.isFinite(max_rent) && max_rent > 0) {
      query = query.lte("monthly_rent", Math.round(max_rent));
    }

    query = query.order("verified", { ascending: false }).order("created_at", { ascending: false }).limit(take);

    const { data, error } = await query;

    const filters = {
      district: districtTerm || null,
      area: areaTerm || null,
      max_rent: typeof max_rent === "number" && Number.isFinite(max_rent) ? Math.round(max_rent) : null,
      limit: take,
    };
    const filterAssumptions = [
      "Only listings currently marked available are searched; verified listings are shown first.",
      districtTerm ? `District filtered to "${districtTerm}".` : "No district filter applied.",
      areaTerm ? `Area matched against village, sub-county, district, or region for "${areaTerm}".` : "No area filter applied.",
      filters.max_rent != null ? `Maximum monthly rent of ${ugx(filters.max_rent)}.` : "No maximum rent applied.",
      `At most ${take} listing${take === 1 ? "" : "s"} returned — this is a sample, not the full catalogue.`,
    ];

    if (error) {
      return publicToolResult({
        tool: "find_available_houses",
        summary: "Sorry, I couldn't fetch listings right now. You can still browse everything after signing up.",
        data: { filters, count: 0, listings: [] },
        next_steps: ["Create a free tenant account to browse all available houses."],
        links,
        error: { code: "listings_unavailable", message: error.message },
      });
    }

    const rows = (data ?? []) as ListingRow[];

    if (rows.length === 0) {
      const where = districtTerm || areaTerm ? ` in "${districtTerm || areaTerm}"` : "";
      return publicToolResult({
        tool: "find_available_houses",
        kind: "listings",
        summary: `No available listings matched your search${where} right now.`,
        body: ["New houses are added regularly."],
        assumptions: filterAssumptions,
        estimates: null,
        data: { filters, count: 0, listings: [] },
        next_steps: [
          "Try a wider area, a nearby district, or a higher maximum rent.",
          "Create a free tenant account to save a search and get matched when a house is listed.",
        ],
        links,
      });
    }

    const listings = rows.map((r) => ({
      id: r.id,
      title: r.title ?? "Available house",
      category: r.house_category ?? null,
      rooms: r.number_of_rooms ?? null,
      monthly_rent: r.monthly_rent ?? null,
      location: locationLabel(r),
      district: r.district ?? null,
      amenities: amenityList(r),
      verified: !!r.verified,
      photo_count: Array.isArray(r.image_urls) ? r.image_urls.length : 0,
    }));

    const lines = listings
      .map((l) => {
        const bits = [
          `${ugx(l.monthly_rent)}/mo`,
          l.rooms ? `${l.rooms} room${l.rooms === 1 ? "" : "s"}` : null,
          l.location,
          l.amenities.length ? l.amenities.join(", ") : null,
          l.verified ? "✓ verified" : null,
        ].filter(Boolean);
        return `• ${l.title} — ${bits.join(" · ")}`;
      })
      .join("\n");

    // Normalised range: the actual rent span across the listings returned, so a
    // caller can quote "houses from X to Y" without scanning the array.
    const rents = listings
      .map((l) => l.monthly_rent)
      .filter((r): r is number => typeof r === "number" && Number.isFinite(r));
    const ranges: EstimateRange[] = rents.length
      ? [
          spanRange("Monthly rent across these listings", "monthly_rent", Math.min(...rents), Math.max(...rents), "UGX_per_month", {
            unit: "months",
            value: 1,
          }),
        ]
      : [];

    return publicToolResult({
      tool: "find_available_houses",
      kind: "listings",
      summary: `${listings.length} available house${listings.length === 1 ? "" : "s"} on Welile${
        rents.length ? `, from ${ugx(Math.min(...rents))} to ${ugx(Math.max(...rents))} a month` : ""
      }.`,
      body: [lines],
      assumptions: filterAssumptions,
      estimates: ranges.length
        ? {
            basis: "Actual monthly rents recorded on the available listings returned by this search.",
            confidence: "actual",
            currency: "UGX",
            ranges,
          }
        : null,
      data: { filters, count: listings.length, listings },
      disclaimers: [
        "Only public, non-sensitive fields are shown — no exact address, GPS, landlord, or contact details.",
        "Full details, photos, and contact happen inside the app after you create a free account.",
      ],
      next_steps: [
        "Create a free tenant account to view details, photos, and apply.",
        "Ask for an indicative Rent Plan on any of these rents.",
      ],
      links,
    });
  },
});