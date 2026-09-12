// Shared email delivery for the Financial Ops cash deposit code.
//
// SMS stays the primary channel; this is the alternative/extra channel used when
// the operator asks for it (or when SMS is refused, e.g. no provider credit).
// Sending the code by email NEVER credits anything — the wallet is only credited
// when the depositor enters the code in the app.

export interface CashDepositEmailResult {
  sent: boolean;
  email: string | null;
  error: string | null;
}

export function maskDepositCode(raw: unknown): string {
  const code = String(raw ?? "").replace(/\s/g, "");
  if (!code) return "";
  const visibleCharacters = Math.min(2, code.length);
  return `${"•".repeat(code.length - visibleCharacters)}${code.slice(-visibleCharacters)}`;
}

export function cashDepositReference(depositRequestId: string): string {
  return `DEP-${String(depositRequestId).replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : null;
}

/**
 * Resolve the address to use: an explicit operator-supplied override wins,
 * otherwise the depositor's account email.
 */
export async function resolveDepositorEmail(
  admin: any,
  userId: string,
  override?: unknown,
): Promise<string | null> {
  const explicit = normalizeEmail(override);
  if (explicit) return explicit;

  const { data: profile } = await admin
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  const fromProfile = normalizeEmail((profile as any)?.email);
  if (fromProfile) return fromProfile;

  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    return normalizeEmail(data?.user?.email);
  } catch {
    return null;
  }
}

export async function sendCashDepositCodeEmail(
  admin: any,
  params: {
    email: string;
    code: string;
    amount: number;
    depositorName?: string | null;
    cashOwnerName?: string | null;
    depositRequestId: string;
    expiresAt: string;
    minutesValid?: number;
  },
): Promise<CashDepositEmailResult> {
  const {
    email,
    code,
    amount,
    depositorName,
    cashOwnerName,
    depositRequestId,
    expiresAt,
    minutesValid = 10,
  } = params;

  try {
    const { error } = await admin.functions.invoke("send-transactional-email", {
      body: {
        templateName: "cash-deposit-code",
        recipientEmail: email,
        // One address per code issue; reissues must produce a new email.
        idempotencyKey: `cash-deposit-code-${depositRequestId}-${code}`,
        templateData: {
          code,
          referenceNumber: cashDepositReference(depositRequestId),
          amountUgx: amount,
          depositorName: String(depositorName ?? "").split(" ")[0] || "there",
          cashOwnerName: cashOwnerName ?? "",
          issuedAt: new Date().toISOString(),
          expiresAt,
          resendUrl: `https://welileapp.com/cash-deposit/resend?deposit=${encodeURIComponent(depositRequestId)}`,
          minutesValid,
        },
      },
    });
    if (error) {
      return { sent: false, email, error: String(error.message ?? error) };
    }
    return { sent: true, email, error: null };
  } catch (e) {
    return { sent: false, email, error: String((e as Error)?.message ?? e) };
  }
}

export async function sendCashDepositWalletConfirmationEmail(
  admin: any,
  params: {
    email: string;
    amount: number;
    newBalance?: number | null;
    depositorName?: string | null;
    receiptCode: string;
    depositRequestId: string;
    depositedAt: string;
    referenceNumber: string;
    receiptDownloadUrl?: string | null;
    facilitatedRentVolume?: number | null;
    platformServiceFees?: number | null;
    transactionExpenses?: number | null;
    codeExpiredAt?: string | null;
  },
): Promise<CashDepositEmailResult> {
  const {
    email,
    amount,
    newBalance = null,
    depositorName,
    receiptCode,
    depositRequestId,
    depositedAt,
    referenceNumber,
    receiptDownloadUrl = null,
    facilitatedRentVolume = null,
    platformServiceFees = null,
    transactionExpenses = null,
    codeExpiredAt = null,
  } = params;

  try {
    const { data, error } = await admin.functions.invoke("send-transactional-email", {
      body: {
        templateName: "cash-deposit-wallet-confirmation",
        recipientEmail: email,
        // The deposit request can only be credited once. Reusing its ID makes
        // retries safe and prevents duplicate wallet-confirmation emails.
        idempotencyKey: `cash-deposit-wallet-confirmation-${depositRequestId}`,
        templateData: {
          amountUgx: amount,
          newBalanceUgx: newBalance,
          depositorName: String(depositorName ?? "").split(" ")[0] || "there",
          maskedDepositCode: maskDepositCode(receiptCode),
          depositedAt,
          referenceNumber,
          receiptDownloadUrl,
          facilitatedRentVolume,
          platformServiceFees,
          transactionExpenses,
          codeExpiredAt,
        },
      },
    });
    if (error || data?.success === false) {
      return {
        sent: false,
        email,
        error: String(error?.message ?? data?.reason ?? "Email was not accepted"),
      };
    }
    return { sent: true, email, error: null };
  } catch (e) {
    return { sent: false, email, error: String((e as Error)?.message ?? e) };
  }
}
