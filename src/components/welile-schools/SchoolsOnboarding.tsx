import { useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, Check, IdCard, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ROLE_INTRO, SCHOOLS_ROLES, SCHOOLS_ROLE_LABEL, type SchoolsRole } from '@/lib/welileSchoolsHome';

const ROLE_CARD: Record<SchoolsRole, { icon: typeof Users; line: string }> = {
  parent: { icon: Users, line: 'Spread your child\'s school fees into small daily payments' },
  school: { icon: Building2, line: 'Receive full fees at the start of every term' },
  agent: { icon: IdCard, line: 'Run Welile Schools at a partner school' },
};

type Step = 'welcome' | 'role' | 'intro';

/**
 * Public onboarding funnel for /schools: welcome → who are you → what you get.
 * No sign-in; the chosen role is handed back and remembered by the page.
 */
export default function SchoolsOnboarding({ wordmarkClass, onDone }: { wordmarkClass: string; onDone: (role: SchoolsRole) => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [role, setRole] = useState<SchoolsRole | null>(null);
  const stepIndex = step === 'welcome' ? 0 : step === 'role' ? 1 : 2;

  return (
    <div className="flex min-h-[calc(100dvh-64px)] flex-col">
      <div className="flex items-center gap-2 pb-4" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className={cn('h-1.5 rounded-full transition-all', i === stepIndex ? 'w-8 bg-primary' : i < stepIndex ? 'w-4 bg-primary/50' : 'w-4 bg-muted')} />
        ))}
      </div>

      {step === 'welcome' && (
        <div className="flex flex-1 flex-col">
          <div className="flex-1 space-y-4 pt-6">
            <h2 className="text-3xl font-bold leading-tight tracking-tight">
              Welcome to <span className={cn(wordmarkClass, 'text-primary')}>Welile</span> Schools
            </h2>
            <p className="text-base text-muted-foreground">
              Welile pays school fees upfront, straight to the school. Families clear them in small daily payments.
            </p>
            <ul className="space-y-2 pt-2">
              {['Nursery to university', 'Mobile money, any day', 'An SMS receipt for every payment'].map((t) => (
                <li key={t} className="flex items-center gap-2 text-sm"><Check className="h-4 w-4 text-primary" aria-hidden />{t}</li>
              ))}
            </ul>
          </div>
          <Button className="mt-8 min-h-[52px] w-full gap-2 text-base" onClick={() => setStep('role')}>
            Get started<ArrowRight className="h-5 w-5" aria-hidden />
          </Button>
        </div>
      )}

      {step === 'role' && (
        <div className="flex flex-1 flex-col">
          <button type="button" onClick={() => setStep('welcome')} className="mb-3 inline-flex min-h-[44px] items-center gap-1 self-start text-sm font-medium text-muted-foreground">
            <ArrowLeft className="h-4 w-4" aria-hidden />Back
          </button>
          <h2 className="text-2xl font-bold leading-tight">Who are you?</h2>
          <p className="mt-1 text-sm text-muted-foreground">Pick one to explore. You can switch any time.</p>
          <div role="radiogroup" aria-label="Who are you?" className="mt-5 space-y-3">
            {SCHOOLS_ROLES.map((r) => {
              const { icon: Icon, line } = ROLE_CARD[r];
              const selected = role === r;
              return (
                <button key={r} type="button" role="radio" aria-checked={selected} onClick={() => setRole(r)}
                  className={cn('flex min-h-[76px] w-full items-center gap-4 rounded-2xl border-2 bg-card p-4 text-left transition-colors',
                    selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40')}>
                  <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', selected ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary')}>
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{SCHOOLS_ROLE_LABEL[r]}</span>
                    <span className="block text-sm text-muted-foreground">{line}</span>
                  </span>
                  <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border')} aria-hidden>
                    {selected && <Check className="h-3.5 w-3.5" />}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex-1" />
          <Button className="mt-8 min-h-[52px] w-full gap-2 text-base" onClick={() => role && setStep('intro')} aria-disabled={!role}>
            {role ? `Continue as ${SCHOOLS_ROLE_LABEL[role].toLowerCase()}` : 'Choose one to continue'}
            {role && <ArrowRight className="h-5 w-5" aria-hidden />}
          </Button>
        </div>
      )}

      {step === 'intro' && role && (
        <div className="flex flex-1 flex-col">
          <button type="button" onClick={() => setStep('role')} className="mb-3 inline-flex min-h-[44px] items-center gap-1 self-start text-sm font-medium text-muted-foreground">
            <ArrowLeft className="h-4 w-4" aria-hidden />Back
          </button>
          <p className="text-sm font-semibold text-primary">{SCHOOLS_ROLE_LABEL[role]}</p>
          <h2 className="mt-1 text-2xl font-bold leading-tight">{ROLE_INTRO[role].title}</h2>
          <ol className="mt-6 space-y-5">
            {ROLE_INTRO[role].points.map((p, i) => (
              <li key={p.title} className="flex gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">{i + 1}</span>
                <span>
                  <span className="block font-semibold">{p.title}</span>
                  <span className="block text-sm text-muted-foreground">{p.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="flex-1" />
          <Button className="mt-8 min-h-[52px] w-full gap-2 text-base" onClick={() => onDone(role)}>
            Explore my home<ArrowRight className="h-5 w-5" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}
