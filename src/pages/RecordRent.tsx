import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/ui/phone-input';
import { CheckCircle2, Home, Loader2, Sparkles, ShieldCheck, ArrowRight, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { format, subMonths } from 'date-fns';
import WelileLogo from '@/components/WelileLogo';

interface MonthEntry {
  monthKey: string;
  rent_amount: number;
}

/**
 * PUBLIC, no-login rent recorder.
 * Linked from WhatsApp share: /record-rent?a=AGENT_ID
 *
 * Designed for:
 * - Anyone with a smartphone (no signup)
 * - Low-vision / not-tech-savvy users (huge tap targets, big text, minimal fields)
 * - One landlord, multiple months — type once, tap months
 */
export default function RecordRent() {
  const [params] = useSearchParams();
  const agentId = params.get('a') || '';

  const [step, setStep] = useState<'form' | 'done'>('form');
  const [submitting, setSubmitting] = useState(false);

  // Single shared landlord block (most users only had 1-2 landlords in last year)
  const [submitterName, setSubmitterName] = useState('');
  const [submitterPhone, setSubmitterPhone] = useState('');
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [propertyLocation, setPropertyLocation] = useState('');
  const [rentAmount, setRentAmount] = useState<number>(0);
  const [months, setMonths] = useState<MonthEntry[]>([]);

  const monthOptions = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = subMonths(now, i);
      return { key: format(d, 'yyyy-MM'), label: format(d, 'MMM yyyy') };
    });
  }, []);

  useEffect(() => {
    document.title = 'Record your rent history — Welile';

    // Force-unregister any stale service workers and clear caches.
    // This page needs the network anyway and we want a clean slate
    // on devices that may have an old SW serving broken chunk refs.
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((regs) => {
          regs.forEach((r) => r.unregister());
        }).catch(() => {});
      }
      if ('caches' in window) {
        caches.keys().then((keys) =>
          Promise.all(keys.filter((k) => k.startsWith('welile-')).map((k) => caches.delete(k)))
        ).catch(() => {});
      }
    } catch {
      // ignore — restricted in-app browsers
    }
  }, []);

  const toggleMonth = (key: string) => {
    setMonths((prev) =>
      prev.find((m) => m.monthKey === key)
        ? prev.filter((m) => m.monthKey !== key)
        : [...prev, { monthKey: key, rent_amount: rentAmount || 0 }]
    );
  };

  const updateMonthAmount = (key: string, amount: number) => {
    setMonths((prev) => prev.map((m) => (m.monthKey === key ? { ...m, rent_amount: amount } : m)));
  };

  const removeMonth = (key: string) => setMonths((prev) => prev.filter((m) => m.monthKey !== key));

  const formatNum = (raw: string) => {
    const d = raw.replace(/\D/g, '');
    return d ? Number(d).toLocaleString('en-UG') : '';
  };

  const isValid =
    !!agentId &&
    submitterName.trim().length > 1 &&
    submitterPhone.trim().length >= 7 &&
    landlordName.trim().length > 1 &&
    landlordPhone.trim().length >= 7 &&
    propertyLocation.trim().length > 1 &&
    months.length > 0 &&
    months.every((m) => m.rent_amount > 0);

  const handleSubmit = async () => {
    if (!isValid) {
      toast.error('Please fill all fields and pick at least one month');
      return;
    }
    setSubmitting(true);
    try {
      const rows = months.map((m) => ({
        agent_id: agentId,
        submitter_name: submitterName.trim(),
        submitter_phone: submitterPhone.trim(),
        landlord_name: landlordName.trim(),
        landlord_phone: landlordPhone.trim(),
        property_location: propertyLocation.trim(),
        month_key: m.monthKey,
        rent_amount: m.rent_amount,
        status: 'pending',
      }));
      const { error } = await supabase.from('public_rent_history_submissions').insert(rows);
      if (error) throw error;
      setStep('done');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      console.error('[record-rent] submit error', err);
      toast.error(err.message || 'Could not save. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!agentId) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
        <WelileLogo linkToHome={false} />
        <h1 className="text-2xl font-bold mt-6">Invalid link</h1>
        <p className="text-muted-foreground mt-2 max-w-sm">
          This rent recorder link is missing its agent code. Please ask your Welile agent to share the link again.
        </p>
        <Link to="/" className="mt-6">
          <Button>Go to Welile</Button>
        </Link>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-success/10 via-background to-background flex flex-col items-center justify-center p-6 text-center">
        <div className="w-20 h-20 rounded-full bg-success/20 flex items-center justify-center mb-6">
          <CheckCircle2 className="h-12 w-12 text-success" />
        </div>
        <h1 className="text-3xl font-extrabold">Saved! 🎉</h1>
        <p className="text-lg text-muted-foreground mt-3 max-w-sm">
          Your Welile agent will verify your records and call you when your rent advance is ready.
        </p>

        <div className="mt-8 w-full max-w-sm rounded-2xl border-2 border-primary/30 bg-primary/5 p-5 text-left">
          <p className="text-sm font-bold text-primary flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> What happens next
          </p>
          <ol className="mt-3 space-y-2 text-sm text-foreground">
            <li>1. Welile checks your record with your landlord.</li>
            <li>2. We unlock a rent advance you can use any time.</li>
            <li>3. The more months you record, the bigger the limit.</li>
          </ol>
        </div>

        <Link to="/auth" className="mt-8 w-full max-w-sm">
          <Button size="lg" className="w-full h-14 text-base font-bold">
            Create my Welile account <ArrowRight className="ml-2 h-5 w-5" />
          </Button>
        </Link>
        <button
          onClick={() => {
            setStep('form');
            setMonths([]);
          }}
          className="mt-4 text-sm text-muted-foreground underline"
        >
          Add another landlord
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-32">
      {/* Header */}
      <div className="bg-gradient-to-br from-primary to-primary/70 text-primary-foreground px-5 pt-8 pb-10 rounded-b-3xl shadow-lg">
        <div className="flex items-center justify-center mb-4">
          <WelileLogo linkToHome={false} />
        </div>
        <h1 className="text-3xl font-extrabold text-center leading-tight">
          Record your rent.<br />Unlock cash later. 💰
        </h1>
        <p className="text-center text-base mt-3 opacity-90 max-w-md mx-auto">
          Tell us your last few months of rent. We verify it. You get a rent advance when you need one — no paperwork.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2 text-xs opacity-90">
          <ShieldCheck className="h-4 w-4" />
          <span>Trusted by tenants across Africa</span>
        </div>
      </div>

      <div className="px-5 -mt-6 space-y-4 max-w-md mx-auto">
        {/* Step 1: You */}
        <SectionCard step="1" title="Who are you?">
          <div className="space-y-3">
            <div>
              <Label className="text-base">Your name</Label>
              <Input
                value={submitterName}
                onChange={(e) => setSubmitterName(e.target.value)}
                placeholder="e.g. Sarah Namutebi"
                className="h-14 text-lg"
                autoComplete="name"
              />
            </div>
            <div>
              <Label className="text-base">Your phone (WhatsApp)</Label>
              <PhoneInput
                value={submitterPhone}
                onChange={setSubmitterPhone}
                onContactPicked={({ name }) => {
                  if (name && !submitterName.trim()) setSubmitterName(name);
                }}
                placeholder="07XX XXX XXX"
                className="h-14 text-lg"
              />
            </div>
          </div>
        </SectionCard>

        {/* Step 2: Landlord */}
        <SectionCard step="2" title="Who do you pay rent to?">
          <div className="space-y-3">
            <div>
              <Label className="text-base">Landlord name</Label>
              <Input
                value={landlordName}
                onChange={(e) => setLandlordName(e.target.value)}
                placeholder="e.g. Mr. Mukasa"
                className="h-14 text-lg"
              />
            </div>
            <div>
              <Label className="text-base">Landlord phone</Label>
              <PhoneInput
                value={landlordPhone}
                onChange={setLandlordPhone}
                onContactPicked={({ name }) => {
                  if (name && !landlordName.trim()) setLandlordName(name);
                }}
                placeholder="Tap to pick from contacts"
                className="h-14 text-lg"
              />
              <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> Tap the book icon to pick from your phone
              </p>
            </div>
            <div>
              <Label className="text-base">Where is the house?</Label>
              <div className="relative">
                <Home className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <Input
                  value={propertyLocation}
                  onChange={(e) => setPropertyLocation(e.target.value)}
                  placeholder="e.g. Kabalagala"
                  className="h-14 text-lg pl-11"
                />
              </div>
            </div>
            <div>
              <Label className="text-base">Monthly rent (UGX)</Label>
              <Input
                inputMode="numeric"
                value={rentAmount ? rentAmount.toLocaleString('en-UG') : ''}
                onChange={(e) => {
                  const v = parseInt(formatNum(e.target.value).replace(/,/g, '')) || 0;
                  setRentAmount(v);
                  // Cascade to picked months that don't have a custom value
                  setMonths((prev) => prev.map((m) => (m.rent_amount === 0 ? { ...m, rent_amount: v } : m)));
                }}
                placeholder="e.g. 300,000"
                className="h-14 text-xl font-bold"
              />
            </div>
          </div>
        </SectionCard>

        {/* Step 3: Months */}
        <SectionCard step="3" title="Which months did you pay?">
          <p className="text-sm text-muted-foreground -mt-1 mb-3">
            Tap every month you paid rent. The more you pick, the higher your limit.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {monthOptions.map((m) => {
              const picked = months.find((x) => x.monthKey === m.key);
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => toggleMonth(m.key)}
                  className={`h-14 rounded-xl border-2 text-sm font-bold transition-all active:scale-95 ${
                    picked
                      ? 'bg-primary text-primary-foreground border-primary shadow-md'
                      : 'bg-background border-border text-foreground'
                  }`}
                  style={{ touchAction: 'manipulation' }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          {months.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs uppercase font-bold text-muted-foreground tracking-wider">
                Picked months ({months.length})
              </p>
              {months
                .slice()
                .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
                .map((m) => (
                  <div key={m.monthKey} className="flex items-center gap-2 rounded-xl border border-border p-2 bg-muted/30">
                    <span className="text-sm font-bold w-20 text-primary">
                      {monthOptions.find((o) => o.key === m.monthKey)?.label}
                    </span>
                    <Input
                      inputMode="numeric"
                      value={m.rent_amount ? m.rent_amount.toLocaleString('en-UG') : ''}
                      onChange={(e) =>
                        updateMonthAmount(
                          m.monthKey,
                          parseInt(formatNum(e.target.value).replace(/,/g, '')) || 0
                        )
                      }
                      placeholder="Amount"
                      className="h-11 text-base font-semibold flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeMonth(m.monthKey)}
                      className="h-10 w-10 shrink-0"
                      aria-label="Remove month"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
            </div>
          )}
        </SectionCard>

        {/* Reward callout */}
        <div className="rounded-2xl border-2 border-success/30 bg-success/5 p-4 flex items-start gap-3">
          <div className="p-2 rounded-xl bg-success/15 shrink-0">
            <Sparkles className="h-5 w-5 text-success" />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground">12 months recorded = biggest limit</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Welile uses your record to give you cash for rent — no collateral, no salary slip.
            </p>
          </div>
        </div>
      </div>

      {/* Sticky submit */}
      <div className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur border-t p-4 z-50">
        <div className="max-w-md mx-auto">
          <Button
            onClick={handleSubmit}
            disabled={!isValid || submitting}
            className="w-full h-16 text-lg font-extrabold rounded-2xl shadow-lg"
            size="lg"
          >
            {submitting ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Saving…
              </>
            ) : (
              <>
                Save my rent history
                <ArrowRight className="ml-2 h-5 w-5" />
              </>
            )}
          </Button>
          <p className="text-[11px] text-center text-muted-foreground mt-2">
            By saving, you allow Welile to verify with your landlord.
          </p>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ step, title, children }: { step: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-card border border-border shadow-sm p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-9 w-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-extrabold">
          {step}
        </div>
        <h2 className="text-lg font-bold">{title}</h2>
      </div>
      {children}
    </div>
  );
}
