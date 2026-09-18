import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Phone, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useOtpVerification } from "@/hooks/useOtpVerification";
import { toUgandaE164 } from "@/lib/ugandaPhone";

const SNOOZE_KEY = "welile:phone-collection:snoozed-until";
const OTP_RATE_KEY = "welile:phone-collection:otp-sends";
// Client-side rate limits — layered on top of the backend cooldown so users
// can't burn through SMS credits or trigger carrier abuse flags by spamming
// the "Send code" button, refreshing, or switching phone numbers.
const OTP_MAX_PER_PHONE_HOUR = 3;
const OTP_MAX_PER_HOUR = 5;
const OTP_MAX_PER_DAY = 10;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type OtpSendRecord = { phone: string; at: number };

function readSendHistory(): OtpSendRecord[] {
  try {
    const raw = localStorage.getItem(OTP_RATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - DAY_MS;
    return parsed.filter(
      (r: any) =>
        r && typeof r.phone === "string" && typeof r.at === "number" && r.at > cutoff,
    );
  } catch {
    return [];
  }
}

function recordSend(phone: string) {
  const history = readSendHistory();
  history.push({ phone, at: Date.now() });
  try {
    localStorage.setItem(OTP_RATE_KEY, JSON.stringify(history));
  } catch {
    /* quota exceeded — ignore */
  }
}

/**
 * Returns null if the send is allowed, or a user-facing reason string if it
 * should be blocked. Enforces per-phone (hourly), global (hourly) and global
 * (daily) caps against the localStorage history.
 */
function checkOtpRateLimit(phone: string): string | null {
  const history = readSendHistory();
  const now = Date.now();
  const dayCount = history.length;
  if (dayCount >= OTP_MAX_PER_DAY) {
    return `Too many verification codes today. Try again tomorrow.`;
  }
  const hourCount = history.filter((r) => now - r.at < HOUR_MS).length;
  if (hourCount >= OTP_MAX_PER_HOUR) {
    return `Too many codes this hour. Wait a bit and try again.`;
  }
  const perPhoneHour = history.filter(
    (r) => r.phone === phone && now - r.at < HOUR_MS,
  ).length;
  if (perPhoneHour >= OTP_MAX_PER_PHONE_HOUR) {
    return `You've requested ${OTP_MAX_PER_PHONE_HOUR} codes for this number in the last hour. Try again later.`;
  }
  return null;
}

/**
 * Fire-and-forget audit write to `phone_collection_prompt_events`.
 * Never blocks the UI: any error is swallowed so a logging outage cannot
 * stop a user from actually saving their phone number.
 */
async function logPromptEvent(
  userId: string,
  action: "shown" | "snoozed" | "submitted" | "error",
  extras: {
    phone_verified?: boolean | null;
    had_prior_phone?: boolean | null;
    meta?: Record<string, unknown>;
  } = {},
) {
  try {
    await supabase.from("phone_collection_prompt_events").insert([
      {
        user_id: userId,
        action,
        phone_verified: extras.phone_verified ?? null,
        had_prior_phone: extras.had_prior_phone ?? null,
        meta: (extras.meta ?? {}) as any,
      },
    ]);
  } catch (e) {
    console.warn("[PhoneCollectionGate] audit log failed:", e);
  }
}

// Delegates to the shared strict Ugandan normalizer so the client, edge
// functions and DB uniqueness index all agree on what "the same number" means.
function normalizePhone(raw: string): string | null {
  const e164 = toUgandaE164(raw);
  return e164 ? `+${e164}` : null;
}

export default function PhoneCollectionGate() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  // When true, the user MUST verify a phone number before they can use the
  // app — no snooze, no dismiss, full-screen block. Triggered for Google
  // (OAuth) sign-ups that arrive with no phone number on the profile.
  const [mandatory, setMandatory] = useState(false);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [phone, setPhone] = useState("");
  const [momoName, setMomoName] = useState("");
  const [saving, setSaving] = useState(false);
  const [checked, setChecked] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  // Remembers whether the account had a phone value before this popup opened —
  // included in every audit row so ops can distinguish first-time onboarding
  // from a "phone was cleared / invalid" prompt.
  const [hadPriorPhone, setHadPriorPhone] = useState<boolean | null>(null);
  const {
    otpSent,
    otpVerified,
    otpLoading,
    otpError,
    sendStatus,
    cooldownSeconds,
    sendOtp,
    verifyOtp,
    resetOtp,
  } = useOtpVerification();

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!user?.id || !user.email) return;
      const stop = (await import("@/lib/loginTelemetry"))
        .loginTelemetry.start('gate.phone_collection.check', { userId: user.id });
      // Detect Google (or other OAuth) sign-up: Supabase stores the identity
      // provider on app_metadata.provider and providers[].
      const meta = (user as any).app_metadata || {};
      const providers: string[] = Array.isArray(meta.providers)
        ? meta.providers
        : meta.provider
          ? [meta.provider]
          : [];
      const isOAuthSignup = providers.some((p) => p && p !== "email" && p !== "phone");
      // Profile completion is a NON-BLOCKING onboarding prompt. It never
      // prevents access to the dashboard. Phone verification is enforced
      // downstream, only on sensitive actions (withdrawals, payouts,
      // wallet transfers, etc.). Respect the snooze for everyone.
      const snoozed = Number(localStorage.getItem(SNOOZE_KEY) || 0);
      if (snoozed && Date.now() < snoozed) {
        setChecked(true);
        stop('snoozed');
        return;
      }
      const { data, error } = await supabase
        .from("profiles")
        .select("phone, full_name, mobile_money_name, phone_verified")
        .eq("id", user.id)
        .maybeSingle();
      if (cancelled || error) { stop(error ? 'error' : 'cancelled', { message: error?.message }); return; }
      const priorPhone = String(data?.phone ?? "").trim();
      const priorVerified = Boolean((data as any)?.phone_verified);
      // For OAuth (Google) sign-ups we ALSO force verification when a phone
      // exists but is not yet verified — Google SSO accounts must complete
      // SMS OTP verification before they can use the app.
      const needsPrompt = !priorPhone || (isOAuthSignup && !priorVerified);
      if (needsPrompt) {
        setMomoName(data?.mobile_money_name || data?.full_name || "");
        setHadPriorPhone(Boolean(priorPhone));
        if (priorPhone) setPhone(priorPhone);
        // Never mandatory — users must always be able to dismiss and use the app.
        setMandatory(false);
        setOpen(true);
        void logPromptEvent(user.id, "shown", {
          had_prior_phone: Boolean(priorPhone),
          meta: {
            email: user.email ?? null,
            providers,
            mandatory: false,
            reason: !priorPhone ? "no_phone" : "oauth_phone_unverified",
          },
        });
        stop('prompt_shown', { hadPriorPhone: Boolean(priorPhone), providers });
      } else {
        stop('ok');
      }
      setChecked(true);
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.email]);

  const handleSave = async () => {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      toast.error("Enter a valid Ugandan phone number (e.g. 0772 123 456)");
      return;
    }
    if (mandatory && !otpVerified) {
      toast.error("Verify your phone number with the code we sent before continuing.");
      return;
    }
    const trimmedName = momoName.trim();
    if (trimmedName.length < 2) {
      toast.error("Enter the name that appears on your mobile money");
      return;
    }
    setSaving(true);
    try {
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from("profiles")
        .update({
          phone: normalized,
          mobile_money_name: trimmedName,
          phone_verified: otpVerified,
          phone_verified_at: otpVerified ? nowIso : null,
        })
        .eq("id", user!.id);
      if (error) {
        // Partial UNIQUE index profiles_phone_ug_e164_unique.
        if ((error as any).code === "23505") {
          toast.error(
            "That phone number is already used by another account. Use a different number or contact support to merge accounts.",
          );
          void logPromptEvent(user!.id, "error", {
            phone_verified: otpVerified,
            had_prior_phone: hadPriorPhone,
            meta: { code: "23505", reason: "duplicate_phone" },
          });
          return;
        }
        void logPromptEvent(user!.id, "error", {
          phone_verified: otpVerified,
          had_prior_phone: hadPriorPhone,
          meta: { code: (error as any).code ?? null, message: error.message },
        });
        throw error;
      }
      toast.success(
        otpVerified
          ? "Phone verified — you'll now get SMS updates"
          : "Phone saved — you can verify it later from Settings",
      );
      void logPromptEvent(user!.id, "submitted", {
        phone_verified: otpVerified,
        had_prior_phone: hadPriorPhone,
        meta: {
          momo_name_present: trimmedName.length > 0,
          otp_used: otpSent,
          mandatory,
        },
      });
      setOpen(false);
      setMandatory(false);
    } catch (e: any) {
      toast.error(e?.message || "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const snoozeOneDay = () => {
    if (mandatory) return; // cannot snooze the OAuth mandatory flow
    localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + 24 * 60 * 60 * 1000),
    );
    if (user?.id) {
      void logPromptEvent(user.id, "snoozed", {
        phone_verified: otpVerified,
        had_prior_phone: hadPriorPhone,
        meta: { snooze_hours: 24 },
      });
    }
    setOpen(false);
  };

  const handleSendCode = async () => {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      toast.error("Enter a valid Ugandan phone number first");
      return;
    }
    const blocked = checkOtpRateLimit(normalized);
    if (blocked) {
      toast.error(blocked);
      if (user?.id) {
        void logPromptEvent(user.id, "error", {
          phone_verified: otpVerified,
          had_prior_phone: hadPriorPhone,
          meta: { reason: "otp_rate_limited", detail: blocked },
        });
      }
      return;
    }
    // Pre-check uniqueness so we don't burn an SMS on a number that will be
    // rejected at save time anyway. The DB unique index remains the source
    // of truth — this is just a friendlier UX.
    setCheckingAvailability(true);
    try {
      const { data: available, error: availErr } = await supabase.rpc(
        "is_phone_available",
        { p_phone: normalized },
      );
      if (availErr) {
        console.warn("[PhoneCollectionGate] is_phone_available failed:", availErr);
      } else if (available === false) {
        toast.error(
          "That phone number is already linked to another account. Use a different number or contact support.",
        );
        if (user?.id) {
          void logPromptEvent(user.id, "error", {
            phone_verified: false,
            had_prior_phone: hadPriorPhone,
            meta: { reason: "phone_in_use", phone: normalized },
          });
        }
        return;
      }
    } finally {
      setCheckingAvailability(false);
    }
    const ok = await sendOtp(normalized, { category: 'phone_collection' });
    if (ok) {
      recordSend(normalized);
      toast.success(`Code sent to ${normalized}`);
    }
  };

  const handleVerifyCode = async () => {
    const normalized = normalizePhone(phone);
    if (!normalized) return;
    if (otpCode.length !== 6) {
      toast.error("Enter the 6-digit code");
      return;
    }
    const ok = await verifyOtp(normalized, otpCode, { category: 'phone_collection' });
    if (ok) {
      toast.success("Phone verified ✓");
      setOtpCode("");
    }
  };

  // If the user edits the phone after sending a code, drop the stale OTP state
  // so the verified badge cannot survive a number change.
  const handlePhoneChange = (v: string) => {
    setPhone(v);
    if (otpSent || otpVerified) {
      resetOtp();
      setOtpCode("");
    }
  };

  if (!checked && !open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) return;
        if (mandatory) return; // block dismiss when phone is required
        snoozeOneDay();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={(e) => {
          if (mandatory) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (mandatory) e.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Phone className="h-6 w-6 text-primary" />
          </div>
          <DialogTitle className="text-center">
            {mandatory ? "Complete your profile" : "Add your phone number"}
          </DialogTitle>
          <DialogDescription className="text-center">
            {mandatory
              ? "Your Google account didn't provide a phone number. Add and verify a mobile number to activate your account — every account must have its own verified phone."
              : "We use your phone to send you SMS receipts, payment alerts and security codes. Add it once so you never miss an update."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="pcg-phone">Phone number</Label>
              {otpVerified && (
                <Badge variant="secondary" className="gap-1">
                  <ShieldCheck className="h-3 w-3" /> Verified
                </Badge>
              )}
            </div>
            <Input
              id="pcg-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0772 123 456"
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value)}
              disabled={saving || otpVerified}
            />

            {!otpVerified && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Optional: verify your phone with a one-time code so it's
                  trusted for payouts and security alerts.
                </p>
                {!otpSent ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleSendCode}
                    disabled={otpLoading || saving || cooldownSeconds > 0 || checkingAvailability}
                  >
                    {otpLoading || checkingAvailability ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        {checkingAvailability ? "Checking…" : "Sending…"}
                      </>
                    ) : cooldownSeconds > 0 ? (
                      `Resend in ${cooldownSeconds}s`
                    ) : (
                      "Send verification code"
                    )}
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <Input
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      placeholder="6-digit code"
                      value={otpCode}
                      onChange={(e) =>
                        setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                      disabled={otpLoading || saving}
                      className="tracking-widest text-center text-lg"
                    />
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="flex-1"
                        onClick={handleVerifyCode}
                        disabled={otpLoading || saving || otpCode.length !== 6}
                      >
                        {otpLoading ? (
                          <>
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Verifying…
                          </>
                        ) : (
                          "Verify code"
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleSendCode}
                        disabled={otpLoading || saving || cooldownSeconds > 0}
                      >
                        {cooldownSeconds > 0 ? `${cooldownSeconds}s` : "Resend"}
                      </Button>
                    </div>
                    {sendStatus === "pending" && (
                      <p className="text-[11px] text-muted-foreground">
                        Waiting for the carrier to deliver your code…
                      </p>
                    )}
                  </div>
                )}
                {otpError && (
                  <p className="text-xs text-destructive">{otpError}</p>
                )}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pcg-momo">
              Name shown when you receive mobile money
            </Label>
            <Input
              id="pcg-momo"
              type="text"
              autoComplete="name"
              placeholder="e.g. WATSALA ENOCK"
              value={momoName}
              onChange={(e) => setMomoName(e.target.value)}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              This is the exact name your MTN / Airtel account shows so
              payouts match correctly.
            </p>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {!mandatory && (
              <Button variant="ghost" onClick={snoozeOneDay} disabled={saving}>
                Not now
              </Button>
            )}
            <Button
              onClick={handleSave}
              disabled={saving || (mandatory && !otpVerified)}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                mandatory ? "Activate my account" : "Save phone number"
              )}
            </Button>
          </div>
          {mandatory && !otpVerified && (
            <p className="text-center text-[11px] text-muted-foreground">
              You must verify your phone with the SMS code to activate your account.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}