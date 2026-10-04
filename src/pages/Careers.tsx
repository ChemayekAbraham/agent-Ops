import { useState, useRef, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import {
  Code2, TrendingUp, Briefcase, Megaphone, Headphones, Loader2,
  ArrowRight, CheckCircle2, MessageCircle, Mail, Sparkles,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { normalizeWa, isValidWaNumber } from '@/lib/whatsapp';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import welileLogo from '@/assets/welile-logo.png';

const CATEGORIES = [
  { value: 'developer', label: 'Developer / Engineering', icon: Code2, note: 'We are hiring 100+ developers', gradient: 'from-indigo-500 to-blue-600' },
  { value: 'sales', label: 'Sales & Field Agents', icon: TrendingUp, note: '1,000+ sales roles open', gradient: 'from-emerald-500 to-teal-600' },
  { value: 'marketing', label: 'Marketing & Growth', icon: Megaphone, note: 'Grow the Welile brand', gradient: 'from-pink-500 to-rose-600' },
  { value: 'operations', label: 'Operations & Support', icon: Headphones, note: 'Keep the engine running', gradient: 'from-amber-500 to-orange-600' },
  { value: 'other', label: 'Other / Any Role', icon: Briefcase, note: 'Tell us where you fit', gradient: 'from-slate-500 to-slate-700' },
];

export default function Careers() {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Capture UTM attribution once on mount (persists across form edits).
  const utmRef = useRef<{ source: string | null; medium: string | null; campaign: string | null }>({
    source: null,
    medium: null,
    campaign: null,
  });
  const [form, setForm] = useState({
    fullName: '',
    whatsapp: '',
    email: '',
    category: 'developer',
    roleInterest: '',
    experience: '',
    portfolio: '',
    location: '',
    coverNote: '',
  });
  // Name captured in parts; `form.fullName` stays the single submitted string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const applyNameParts = (next: PersonNameParts) => {
    setNameParts(next);
    setForm(prev => ({ ...prev, fullName: joinPersonName(next) }));
  };

  // Read UTM params + log an anonymous click for platform attribution.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const source = params.get('utm_source');
    const medium = params.get('utm_medium');
    const campaign = params.get('utm_campaign');
    utmRef.current = { source, medium, campaign };

    // Only log clicks that arrived via a tagged share link.
    if (source) {
      const key = `career-click-${source}-${medium ?? ''}-${campaign ?? ''}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        (supabase.from('career_link_clicks' as any) as any)
          .insert({
            utm_source: source,
            utm_medium: medium,
            utm_campaign: campaign,
            referrer: document.referrer || null,
            landing_path: window.location.pathname + window.location.search,
          })
          .then(() => {}, (err: any) => console.error('Failed to log careers click:', err));
      }
    }
  }, []);

  const updateField = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid || !form.whatsapp.trim()) {
      toast({ title: 'Required fields', description: nameCheck.error || 'Please enter your name and WhatsApp number', variant: 'destructive' });
      return;
    }

    if (!isValidWaNumber(form.whatsapp)) {
      toast({
        title: 'Check your WhatsApp number',
        description: 'Enter a valid number, e.g. 0782 123 456 or +256 782 123 456.',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { data: inserted, error } = await (supabase.from('job_applications' as any) as any).insert({
        full_name: form.fullName.trim(),
        whatsapp_number: normalizeWa(form.whatsapp),
        email: form.email.trim() || null,
        category: form.category,
        role_interest: form.roleInterest.trim() || null,
        experience_level: form.experience.trim() || null,
        portfolio_url: form.portfolio.trim() || null,
        location: form.location.trim() || null,
        cover_note: form.coverNote.trim() || null,
        status: 'new',
        utm_source: utmRef.current.source,
        utm_medium: utmRef.current.medium,
        utm_campaign: utmRef.current.campaign,
      }).select('id').single();
      if (error) throw error;

      // Auto-reply confirmation email from info@welile.com (only when an email
      // was provided). Best-effort — never block the success screen on it.
      const applicantEmail = form.email.trim();
      if (applicantEmail) {
        const categoryLabel = CATEGORIES.find((c) => c.value === form.category)?.label ?? 'a role';
        supabase.functions.invoke('send-transactional-email', {
          body: {
            templateName: 'job-application-received',
            recipientEmail: applicantEmail,
            idempotencyKey: `job-application-received-${inserted?.id ?? applicantEmail}`,
            templateData: {
              recipient_name: form.fullName.trim() || 'there',
              category_label: categoryLabel,
              role_interest: form.roleInterest.trim(),
            },
          },
        }).catch((err) => console.error('Failed to send applicant confirmation email:', err));
      }

      setSubmitted(true);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to submit. Please try again.', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8 text-success" />
          </div>
          <h2 className="text-xl font-bold">Application received! 🎉</h2>
          <p className="text-muted-foreground">
            Our team will review your details and reach out on WhatsApp or by email from <span className="font-semibold text-foreground">info@welile.com</span>.
          </p>
          <Button variant="outline" onClick={() => { setSubmitted(false); setNameParts({ firstName: '', otherNames: '', lastName: '' }); setForm({ fullName: '', whatsapp: '', email: '', category: 'developer', roleInterest: '', experience: '', portfolio: '', location: '', coverNote: '' }); }}>
            Submit another application
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Careers at Welile — Join Our Team</title>
        <meta name="description" content="Apply for a job at Welile. We are hiring 100+ developers, 1,000+ sales people, and more. Submit your details and our team will reach out." />
        <link rel="canonical" href="https://welileapp.com/careers" />
        <meta property="og:title" content="Careers at Welile — Join Our Team" />
        <meta property="og:description" content="We are hiring 100+ developers, 1,000+ sales people, and more. Apply in under 2 minutes." />
        <meta property="og:url" content="https://welileapp.com/careers" />
      </Helmet>

      {/* Hero */}
      <div className="relative overflow-hidden bg-gradient-to-br from-primary/10 via-background to-indigo-500/10">
        <div className="max-w-lg mx-auto px-4 pt-8 pb-6 text-center">
          <img src={welileLogo} alt="Welile" className="h-10 mx-auto mb-4" />
          <div className="inline-flex items-center gap-2 bg-primary/15 text-primary rounded-full px-3 py-1 text-xs font-semibold mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            We're Hiring Across Africa
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
            Build your career<br />
            <span className="text-primary">with Welile</span>
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm mx-auto">
            We're hiring <strong className="text-foreground">100+ developers</strong>, <strong className="text-foreground">1,000+ sales people</strong>, and many more. Apply in under 2 minutes.
          </p>
        </div>
      </div>

      {/* Form */}
      <div className="max-w-lg mx-auto px-4 pb-12 pt-4">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Category picker */}
          <div className="space-y-2">
            <Label>Which team are you applying for? *</Label>
            <div className="grid grid-cols-1 gap-2">
              {CATEGORIES.map((c) => {
                const active = form.category === c.value;
                return (
                  <button
                    type="button"
                    key={c.value}
                    onClick={() => updateField('category', c.value)}
                    className={cn(
                      'flex items-center gap-3 rounded-xl border p-3 text-left transition-all',
                      active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border/50 hover:border-border'
                    )}
                  >
                    <div className={cn('w-9 h-9 rounded-lg bg-gradient-to-br flex items-center justify-center shrink-0', c.gradient)}>
                      <c.icon className="w-4.5 h-4.5 text-white" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold leading-tight">{c.label}</p>
                      <p className="text-[11px] text-muted-foreground">{c.note}</p>
                    </div>
                    {active && <CheckCircle2 className="w-5 h-5 text-primary ml-auto shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Basic info */}
          <div className="space-y-3">
            <div>
              <Label>Full Name *</Label>
              <PersonNameFields idPrefix="careers" value={nameParts} onChange={applyNameParts} />
            </div>

            {/* WhatsApp — highlighted */}
            <div className="rounded-xl border-2 border-emerald-500/40 bg-emerald-500/5 p-3">
              <Label htmlFor="whatsapp" className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <MessageCircle className="w-4 h-4" /> WhatsApp Number *
              </Label>
              <p className="text-[11px] text-muted-foreground mb-1.5">This is how we'll contact you — make sure it's active.</p>
              <Input id="whatsapp" type="tel" placeholder="07XX XXX XXX" value={form.whatsapp} onChange={e => updateField('whatsapp', e.target.value)} className="border-emerald-500/40 focus-visible:ring-emerald-500" required />
            </div>

            {/* Email — highlighted */}
            <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-3">
              <Label htmlFor="email" className="flex items-center gap-1.5 text-primary">
                <Mail className="w-4 h-4" /> Email Address
              </Label>
              <p className="text-[11px] text-muted-foreground mb-1.5">We may email you from info@welile.com.</p>
              <Input id="email" type="email" placeholder="you@email.com" value={form.email} onChange={e => updateField('email', e.target.value)} className="border-primary/30 focus-visible:ring-primary" />
            </div>

            <div>
              <Label htmlFor="roleInterest">Role / Position you want</Label>
              <Input id="roleInterest" placeholder="e.g. Frontend Developer, Field Sales Agent" value={form.roleInterest} onChange={e => updateField('roleInterest', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="location">Location (City / District)</Label>
              <Input id="location" placeholder="e.g. Kampala" value={form.location} onChange={e => updateField('location', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="experience">Experience</Label>
              <Input id="experience" placeholder="e.g. 3 years, entry level, student..." value={form.experience} onChange={e => updateField('experience', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="portfolio">Portfolio / LinkedIn / CV link</Label>
              <Input id="portfolio" placeholder="https://..." value={form.portfolio} onChange={e => updateField('portfolio', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="coverNote">Tell us about yourself</Label>
              <Textarea id="coverNote" placeholder="Why do you want to join Welile? What makes you a great fit?" value={form.coverNote} onChange={e => updateField('coverNote', e.target.value)} className="min-h-[80px]" />
            </div>
          </div>

          <Button type="submit" size="xl" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (<><Loader2 className="w-5 h-5 animate-spin" /> Submitting...</>) : (<>Submit Application <ArrowRight className="w-5 h-5" /></>)}
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            Our team will contact you via WhatsApp or email from info@welile.com
          </p>
        </form>
      </div>
    </div>
  );
}
