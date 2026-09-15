import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, Wallet, Lock, Pencil, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  userId: string;
}

type Provider = "mtn" | "airtel";

/** Detects MTN / Airtel from the Ugandan operator prefix. */
function detectProvider(raw: string): Provider | null {
  const d = raw.replace(/\D/g, "");
  const local = d.startsWith("256") ? `0${d.slice(3)}` : d.startsWith("0") ? d : `0${d}`;
  const p = local.slice(0, 3);
  if (["077", "078", "076", "039"].includes(p)) return "mtn";
  if (["075", "070", "074", "020"].includes(p)) return "airtel";
  return null;
}

/**
 * Withdrawal account panel — the single mobile money destination (number +
 * provider + registered name) that every withdrawal for this user is paid to.
 * Saved through `set_withdrawal_account`, which guarantees a number can only
 * ever be linked to ONE Welile account. The WithdrawFlow reads these details
 * back as read-only prefill.
 */
export default function MobileMoneyNameCard({ userId }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const [savedNumber, setSavedNumber] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savedProvider, setSavedProvider] = useState<Provider>("mtn");

  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("mtn");

  /* Once the identity is captured, the withdrawal number is locked to the
     account and cannot be changed from anywhere in the app. */
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data }, { data: bindingRows }] = await Promise.all([
        supabase
          .from("profiles")
          .select("mobile_money_name, mobile_money_number, mobile_money_provider, full_name, phone")
          .eq("id", userId)
          .maybeSingle(),
        supabase
          .from("user_identity_bindings")
          .select("locked_payout_number")
          .eq("user_id", userId)
          .neq("status", "revoked")
          .limit(1),
      ]);
      if (cancelled) return;
      const lockedNumber = (bindingRows?.[0]?.locked_payout_number ?? "").trim();
      const n = lockedNumber || (data?.mobile_money_number ?? "").trim();
      const nm = (data?.mobile_money_name ?? "").trim();
      const pv = ((data?.mobile_money_provider ?? "").toLowerCase() === "airtel" ? "airtel" : "mtn") as Provider;
      setLocked(!!lockedNumber);
      setSavedNumber(n);
      setSavedName(nm);
      setSavedProvider(pv);
      setNumber(n || (data?.phone ?? ""));
      setName(nm || (data?.full_name ?? ""));
      setProvider(detectProvider(n || data?.phone || "") ?? pv);
      setEditing(!lockedNumber && (!n || !nm));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    const digits = number.replace(/\D/g, "");
    if (digits.length < 9) {
      toast.error("Enter a valid mobile money number");
      return;
    }
    if (trimmedName.split(/\s+/).filter(Boolean).length < 2) {
      toast.error("Enter the full name exactly as it shows on mobile money");
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("set_withdrawal_account" as never, {
        p_number: number.trim(),
        p_name: trimmedName,
        p_provider: provider,
      } as never);
      if (error) throw error;
      const res = (data ?? {}) as Record<string, string>;
      setSavedNumber(res.mobile_money_number ?? number.trim());
      setSavedName(res.mobile_money_name ?? trimmedName);
      setSavedProvider((res.mobile_money_provider as Provider) ?? provider);
      setNumber(res.mobile_money_number ?? number.trim());
      setEditing(false);
      toast.success("Withdrawal account saved");
    } catch (e: any) {
      toast.error(e?.message || "Failed to save withdrawal account");
    } finally {
      setSaving(false);
    }
  };

  const isSaved = !!savedNumber && !!savedName;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary" /> Withdrawal account
        </CardTitle>
        <CardDescription>
          The mobile money number and the exact registered name that all your
          withdrawals are paid to. Locked to your account only — one number can
          never be used by two Welile accounts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !editing && isSaved ? (
          <>
            <div className="rounded-xl border bg-muted/40 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Number</span>
                <span className="font-bold tracking-wide">{savedNumber}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Provider</span>
                <Badge variant="secondary" className="uppercase">{savedProvider}</Badge>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Name</span>
                <span className="font-semibold text-right truncate">{savedName}</span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              Used automatically on every withdrawal — you can't change it during cash-out.
            </p>
            <Button
              variant="outline"
              className="w-full gap-2 h-12 rounded-xl text-sm font-bold"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-4 w-4" /> Edit withdrawal details
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="mm-number" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Mobile money number for withdrawals
              </Label>
              <Input
                id="mm-number"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="e.g. 0770123456"
                value={number}
                onChange={(e) => {
                  const v = e.target.value;
                  setNumber(v);
                  const d = detectProvider(v);
                  if (d) setProvider(d);
                }}
                disabled={saving}
                className="h-12 rounded-xl"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Provider
              </Label>
              <RadioGroup
                value={provider}
                onValueChange={(v) => setProvider(v as Provider)}
                className="flex gap-6"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="mtn" id="mm-mtn" />
                  <Label htmlFor="mm-mtn" className="font-medium cursor-pointer">MTN</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="airtel" id="mm-airtel" />
                  <Label htmlFor="mm-airtel" className="font-medium cursor-pointer">Airtel</Label>
                </div>
              </RadioGroup>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mm-name" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Name on mobile money
              </Label>
              <Input
                id="mm-name"
                type="text"
                autoComplete="name"
                placeholder="e.g. WATSALA ENOCK"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                className="h-12 rounded-xl"
              />
            </div>

            <div className="flex gap-2">
              {isSaved && (
                <Button
                  variant="outline"
                  className="h-12 rounded-xl"
                  disabled={saving}
                  onClick={() => {
                    setNumber(savedNumber);
                    setName(savedName);
                    setProvider(savedProvider);
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button
                className="flex-1 gap-2 h-12 rounded-xl text-sm font-bold"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save withdrawal account
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5" />
              This number is bound to your account only. If it's already linked
              elsewhere, saving will be rejected.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
