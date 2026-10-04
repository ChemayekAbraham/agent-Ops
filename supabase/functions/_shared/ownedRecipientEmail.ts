// Ownership guard for personal money notifications (deposits, withdrawals,
// payout receipts, float credits).
//
// WHY: `profiles.email` is not unique. Agents frequently register tenants,
// landlords and sub-accounts using their OWN gmail address, so one mailbox can
// be attached to many user rows. Sending a receipt to `profiles.email` blindly
// means that one person receives every other account's deposit/withdrawal
// email — mass spam, and a privacy leak of other people's balances.
//
// This helper resolves the address that provably belongs to the user:
//   1. their real auth login email (unique per account), else
//   2. their profile email ONLY when no other profile/auth account uses it,
//   3. otherwise null -> do not email (SMS/in-app still notify the user).
export async function resolveOwnedRecipientEmail(
  admin: any,
  userId: string | null | undefined,
  tag = "email-guard",
): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data, error } = await admin.rpc("resolve_owned_notification_email", {
      p_user_id: userId,
    });
    if (error) {
      console.warn(`[${tag}] ownership check failed — skipping email:`, error);
      return null;
    }
    const email = typeof data === "string" ? data.trim() : "";
    if (!email) {
      console.log(`[${tag}] no owned email for user ${userId} — email skipped (shared or placeholder address)`);
      return null;
    }
    return email;
  } catch (e) {
    console.warn(`[${tag}] ownership check threw — skipping email:`, e);
    return null;
  }
}
