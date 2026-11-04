// Partner emails sent when a portfolio renewal is APPLIED.
//
// Presentation only: reads the ledger to quote the final-cycle Returns that
// were actually credited, never computes or moves money. Failures are
// swallowed so a renewal is never blocked by email delivery.

// deno-lint-ignore no-explicit-any
type Admin = any;

const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric", timeZone: "Africa/Kampala" });

export const isRealPartnerEmail = (e: string | null | undefined): e is string =>
  !!e && !e.endsWith("@welile.user") && !e.endsWith("@noapp.welile.user");

/** Latest Returns wallet credit recorded for this portfolio in the last 7 days. */
export async function findFinalCycleReturns(admin: Admin, portfolioId: string) {
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data } = await admin
      .from("general_ledger")
      .select("amount, transaction_date")
      .eq("source_table", "investor_portfolios")
      .eq("source_id", portfolioId)
      .eq("category", "roi_wallet_credit")
      .eq("direction", "cash_in")
      .gte("transaction_date", since)
      .order("transaction_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data || !(Number(data.amount) > 0)) return null;
    return { amount: Number(data.amount), paidAt: new Date(data.transaction_date) };
  } catch {
    return null;
  }
}

async function send(url: string, key: string, payload: Record<string, unknown>) {
  try {
    const res = await fetch(`${url}/functions/v1/send-transactional-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (e) {
    console.warn("[partnerRenewalEmails] send failed", e);
    return false;
  }
}

export async function sendReturnsReadyEmail(opts: {
  admin: Admin;
  supabaseUrl: string;
  serviceKey: string;
  portfolioId: string;
  portfolioCode: string;
  portfolioName: string;
  recipientEmail: string;
  partnerName: string;
  newMaturityDate?: Date | null;
  idempotencyKey: string;
}) {
  const ret = await findFinalCycleReturns(opts.admin, opts.portfolioId);
  return send(opts.supabaseUrl, opts.serviceKey, {
    templateName: "portfolio-renewal-returns-ready",
    recipientEmail: opts.recipientEmail,
    idempotencyKey: opts.idempotencyKey,
    templateData: {
      partner_name: opts.partnerName || "Partner",
      portfolio_name: opts.portfolioName || opts.portfolioCode,
      portfolio_id: opts.portfolioCode,
      amount: ret?.amount ?? null,
      paid_date: ret ? fmtDate(ret.paidAt) : "",
      renewal_date: fmtDate(new Date()),
      new_maturity_date:
        opts.newMaturityDate && !Number.isNaN(opts.newMaturityDate.getTime()) ? fmtDate(opts.newMaturityDate) : "",
      currency: "UGX",
    },
  });
}

/** Renewal confirmation (existing `portfolio-renewal` template, "applied today"). */
export async function sendRenewalAppliedEmail(opts: {
  supabaseUrl: string;
  serviceKey: string;
  recipientEmail: string;
  partnerName: string;
  portfolioCode: string;
  portfolioName: string;
  // deno-lint-ignore no-explicit-any
  renewRes: any;
  fallback: { investment_amount?: number; roi_percentage?: number | string; duration_months?: number };
  idempotencyKey: string;
}) {
  const r = opts.renewRes ?? {};
  const amount = Number(r.investment_amount ?? opts.fallback.investment_amount ?? 0);
  return send(opts.supabaseUrl, opts.serviceKey, {
    templateName: "portfolio-renewal",
    recipientEmail: opts.recipientEmail,
    idempotencyKey: opts.idempotencyKey,
    templateData: {
      partner_name: opts.partnerName || "Partner",
      portfolio_name: r.account_name || opts.portfolioName || opts.portfolioCode,
      portfolio_id: r.portfolio_code || opts.portfolioCode,
      amount,
      new_principal: amount,
      return_rate: `${r.roi_percentage ?? opts.fallback.roi_percentage}%`,
      renewal_date: fmtDate(new Date(r.new_start || Date.now())),
      maturity_date: r.new_maturity_date ? fmtDate(new Date(`${r.new_maturity_date}T00:00:00Z`)) : "",
      duration: `${r.duration_months ?? opts.fallback.duration_months ?? 12} months`,
      currency: "UGX",
      company_name: "Welile",
      logo_url: "https://welileapp.com/welile-logo.png",
      unsubscribe_url: "https://welile.com/unsubscribe",
      terms_url: "https://welileapp.com/partners-terms",
      privacy_url: "https://welileapp.com/privacy",
      days_remaining: 0,
      days_remaining_label: "Applied today",
    },
  });
}
