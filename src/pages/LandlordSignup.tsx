import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { supabase } from '@/integrations/supabase/client';
import { Shield, CheckCircle2, Clock, Users, Home, BadgeCheck, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { toast } from 'sonner';

const formatUGX = (n: number) =>
  'UGX ' + n.toLocaleString('en-UG');

const VALUE_PROPS = [
  { icon: Clock, text: 'Get paid every month on time' },
  { icon: Shield, text: 'Welile pays even if tenant delays or runs away' },
  { icon: Users, text: 'No chasing tenants' },
  { icon: Home, text: 'We handle tenant placement and replacement' },
  { icon: BadgeCheck, text: 'Predictable, stress-free income' },
];

export default function LandlordSignup() {
  const [params] = useSearchParams();
  const agentId = params.get('ref') || null;
  const campaign = params.get('campaign') || params.get('utm_campaign') || null;

  // Calculator state
  const [calcRent, setCalcRent] = useState('');
  const [calcUnits, setCalcUnits] = useState('');
  const guaranteed = useMemo(() => {
    const r = Number(calcRent) || 0;
    const u = Number(calcUnits) || 0;
    return r * u * 12;
  }, [calcRent, calcUnits]);

  // Form state
  const [form, setForm] = useState({
    phone: '',
    location: '',
    units: '',
    rentPerUnit: '',
  });
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const set = useCallback((k: keyof typeof form, v: string) => setForm(p => ({ ...p, [k]: v })), []);

  // Name is captured in parts but stored as the same single `full_name` string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const nameCheckLive = validatePersonNameParts(nameParts);
  const nameOk = nameCheckLive.valid;
  const canSubmit = nameOk && form.phone && form.location && form.units && form.rentPerUnit && agreed && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) {
      toast.error(nameCheck.error || 'Please enter your full name (first and last)');
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.from('landlord_leads').insert({
        full_name: nameCheck.fullName,
        phone: form.phone.trim(),
        property_location: form.location.trim(),
        number_of_units: Number(form.units),
        rent_per_unit: Number(form.rentPerUnit),
        referrer_agent_id: agentId,
        campaign,
        status: 'new_lead',
      });
      if (error) throw error;
      setSubmitted(true);
    } catch (err) {
      console.error('Submission error:', err);
      alert('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // Confirmation must go to the Welile WhatsApp line shown in the SMS invite.
  const whatsappUrl = `https://wa.me/256777607640?text=${encodeURIComponent('I have completed my Welile landlord signup')}`;

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <Helmet>
          <title>Welcome to Welile — Rent Guaranteed</title>
          <link rel="canonical" href="https://welileapp.com/landlord-signup" />
          <meta property="og:url" content="https://welileapp.com/landlord-signup" />
        </Helmet>
        <div className="max-w-md w-full text-center space-y-6 py-12">
          <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
            <CheckCircle2 className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">You're Now Secured</h1>
          <p className="text-muted-foreground text-lg leading-relaxed">
            Welcome to Welile. Your rent is now protected for the next 12 months.
          </p>
          <p className="text-muted-foreground">A Welile agent will contact you shortly.</p>
          <p className="text-xl font-semibold text-primary">You will not miss rent.</p>

          <div className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-4 py-3">
            <MessageCircle className="w-4 h-4 text-[#25D366]" />
            <span className="text-sm text-muted-foreground">Confirm on WhatsApp</span>
            <span className="text-sm font-semibold text-foreground">0777 607 640</span>
          </div>

          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-[#25D366] text-white font-semibold rounded-xl px-6 py-3.5 hover:bg-[#1da851] transition-colors"
          >
            <MessageCircle className="w-5 h-5" />
            Confirm on WhatsApp
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Get 12 Months Rent Guaranteed | Welile</title>
        <meta name="description" content="Get paid every month on time, even if tenants don't pay. Welile guarantees your rent for 12 months." />
        <link rel="canonical" href="https://welileapp.com/landlord-signup" />
        <meta property="og:url" content="https://welileapp.com/landlord-signup" />
      </Helmet>

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary via-primary/90 to-primary/80 text-primary-foreground px-4 pt-12 pb-16">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.1),transparent_60%)]" />
        <div className="relative max-w-lg mx-auto text-center space-y-4">
          <p className="text-sm font-medium tracking-widest uppercase opacity-80">Welile Technologies</p>
          <h1 className="text-3xl sm:text-4xl font-extrabold leading-tight">
            Your Next 12 Months of Rent — Guaranteed
          </h1>
          <p className="text-lg opacity-90">
            Get paid every month on time, even if tenants don't pay.
          </p>
        </div>
      </section>

      {/* Calculator */}
      <section className="px-4 -mt-8 relative z-10">
        <div className="max-w-lg mx-auto bg-card rounded-2xl border border-border/60 shadow-lg p-6 space-y-5">
          <h2 className="text-lg font-semibold text-foreground text-center">
            Calculate Your Guaranteed Income
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Monthly Rent (UGX)</Label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 500,000"
                value={calcRent}
                onChange={e => setCalcRent(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Number of Units</Label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 5"
                value={calcUnits}
                onChange={e => setCalcUnits(e.target.value)}
              />
            </div>
          </div>

          <div className="text-center pt-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
              Your 12-Month Guaranteed Income
            </p>
            <p className={cn(
              "font-extrabold tracking-tight transition-all duration-300",
              guaranteed > 0 ? "text-4xl sm:text-5xl text-primary" : "text-3xl text-muted-foreground"
            )}>
              {guaranteed > 0 ? formatUGX(guaranteed) : 'UGX 0'}
            </p>
          </div>
        </div>
      </section>

      {/* Value Props */}
      <section className="px-4 py-10 max-w-lg mx-auto">
        <h2 className="text-lg font-semibold text-foreground mb-5 text-center">
          Why Landlords Choose Welile
        </h2>
        <div className="space-y-3">
          {VALUE_PROPS.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-start gap-3 p-3 rounded-xl bg-card border border-border/40">
              <div className="mt-0.5 shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <p className="text-sm text-foreground leading-relaxed">{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Form */}
      <section className="px-4 pb-32 max-w-lg mx-auto">
        <h2 className="text-lg font-semibold text-foreground mb-5 text-center">
          Activate Your Rent Guarantee
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <PersonNameFields idPrefix="landlord-signup" value={nameParts} onChange={setNameParts} />
          <div className="space-y-1.5">
            <Label>Phone Number</Label>
            <Input
              type="tel"
              inputMode="tel"
              placeholder="e.g. 0770 000 000"
              value={form.phone}
              onChange={e => set('phone', e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Property Location</Label>
            <Input
              placeholder="e.g. Ntinda, Kampala"
              value={form.location}
              onChange={e => set('location', e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Number of Units</Label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 5"
                value={form.units}
                onChange={e => set('units', e.target.value)}
                required
                min={1}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Rent per Unit (UGX)</Label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 500000"
                value={form.rentPerUnit}
                onChange={e => set('rentPerUnit', e.target.value)}
                required
                min={1}
              />
            </div>
          </div>

          {/* Agreement */}
          <div className="flex items-start gap-3 p-4 rounded-xl bg-muted/50 border border-border/40">
            <Checkbox
              id="agree"
              checked={agreed}
              onCheckedChange={(c) => setAgreed(c === true)}
              className="mt-0.5"
            />
            <label htmlFor="agree" className="text-sm text-muted-foreground leading-relaxed cursor-pointer">
              I agree to enroll in the Welile Rent Guarantee Program where Welile commits to pay my rent for 12 months on time.
            </label>
          </div>

          {/* Sticky CTA */}
          <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur-sm border-t border-border/40 z-50">
            <div className="max-w-lg mx-auto">
              <Button
                type="submit"
                disabled={!canSubmit}
                className="w-full h-14 text-base font-bold rounded-2xl shadow-lg"
                size="xl"
              >
                {submitting ? 'Submitting…' : 'Activate My 12-Month Rent Guarantee'}
              </Button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
