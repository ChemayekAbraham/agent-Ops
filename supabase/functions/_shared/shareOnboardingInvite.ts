import { formatAllocationDate, randomToken, sha256Hex } from "./angelPoolShares.ts";

export const SHARE_LINK_DAYS = 7;

/** Mint a fresh signing token, store its hash, and send the "shares created" email. */
// deno-lint-ignore no-explicit-any
export async function issueShareInvite(admin: any, req: any, origin: string, attempt: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SHARE_LINK_DAYS * 86_400_000).toISOString();
  const { error } = await admin.from("share_onboarding_requests")
    .update({ token_hash: await sha256Hex(token), token_expires_at: expires })
    .eq("id", req.id);
  if (error) throw error;

  const url = `${origin}/shares/${req.id}/sign?token=${token}`;
  const { data: prof } = await admin.from("profiles")
    .select("full_name, email").eq("id", req.shareholder_id).maybeSingle();
  const email = prof?.email && !/@(placeholder|welile\.local)/i.test(prof.email) ? prof.email : null;

  let emailed = false;
  if (email) {
    const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
      body: {
        templateName: "shareholder-shares-created",
        recipientEmail: email,
        idempotencyKey: `share-invite-${req.id}-${attempt}`,
        templateData: {
          shareholder_name: prof?.full_name || "Shareholder",
          pool_name: "Welile Early Angel Pool",
          shares_allocated: req.shares,
          currency: "UGX",
          investment_amount: Number(req.amount),
          ownership_percentage: Number(req.company_ownership_percent).toFixed(4),
          share_reference: req.reference_id,
          allocation_date: formatAllocationDate(req.created_at || new Date()),
          fill_details_url: url,
          link_expiry_days: SHARE_LINK_DAYS,
        },
      },
    });
    if (mailErr) console.error("share invite email failed", mailErr);
    else emailed = true;
  }
  return { url, emailed, email };
}
