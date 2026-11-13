import { useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, Check, IdCard, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import pupilsPhoto from '@/assets/welile-schools-pupils.jpg';
import studentsPhoto from '@/assets/welile-schools-students.jpg';
import { ROLE_INTRO, SCHOOLS_ROLES, SCHOOLS_ROLE_LABEL, type SchoolsRole } from '@/lib/welileSchoolsHome';
import StickyCta from './StickyCta';

const ROLE_CARD: Record<SchoolsRole, { icon: typeof Users; line: string }> = {
  parent: { icon: Users, line: 'Spread your child\'s school fees into small daily payments' },
  school: { icon: Building2, line: 'Receive full fees at the start of every term' },
  agent: { icon: IdCard, line: 'Run Welile Schools at a partner school' },
};

type Step = 'welcome' | 'role' | 'intro';

/** Step dots, top of every funnel screen. */
function Progress({ index }: { index: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of 3`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={cn('h-1.5 rounded-full transition-all', i === index ? 'w-6 bg-primary' : i < index ? 'w-3 bg-primary/50' : 'w-3 bg-muted')} />
      ))}
    </div>
  );
}

/** Back link on the left, step dots on the right. */
function TopRow({ index, onBack }: { index: number; onBack?: () => void }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between">
      {onBack ? (
        <button type="button" onClick={onBack} className="-ml-1 inline-flex min-h-[44px] items-center gap-1 px-1 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden />Back
        </button>
      ) : <span />}
      <Progress index={index} />
    </div>
  );
}

/**
 * Public onboarding funnel for /schools: welcome → who are you → what you get.
 * No sign-in; the chosen role is handed back and remembered by the page.
 * Laid out like a phone app: a photo header, short copy, and one button pinned to the bottom.
 */
export default function SchoolsOnboarding({ wordmarkClass, onDone }: { wordmarkClass: string; onDone: (role: SchoolsRole) => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [role, setRole] = useState<SchoolsRole | null>(null);

  return (
    <div className="flex min-h-[calc(100dvh-76px)] flex-col">
      {step === 'welcome' && (
        <>
          <TopRow index={0} />
          {/* Photo with the headline over it, like an app's splash screen. */}
          <div className="relative mt-2 overflow-hidden rounded-3xl">
            <img src={pupilsPhoto} alt="Two smiling primary school pupils in uniform with school bags"
              className="aspect-[4/5] w-full object-cover object-top sm:aspect-[4/3]" width={900} height={675} />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" aria-hidden />
            <div className="absolute inset-x-0 bottom-0 space-y-2 p-5 text-white">
              <h2 className="text-3xl font-bold leading-tight tracking-tight">
                Welcome to <span className={cn(wordmarkClass, 'text-white')}>Welile</span> Schools
              </h2>
              <p className="text-sm text-white/85">
                Welile pays school fees upfront, straight to the school. Families clear them in small daily payments.
              </p>
            </div>
          </div>
          <ul className="mt-4 flex flex-wrap gap-2">
            {['Nursery to university', 'Mobile money, any day', 'SMS receipt every payment'].map((t) => (
              <li key={t} className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
                <Check className="h-3.5 w-3.5" aria-hidden />{t}
              </li>
            ))}
          </ul>
          <div className="flex-1" />
          <StickyCta>
            <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={() => setStep('role')}>
              Get started<ArrowRight className="h-5 w-5" aria-hidden />
            </Button>
          </StickyCta>
        </>
      )}

      {step === 'role' && (
        <>
          <TopRow index={1} onBack={() => setStep('welcome')} />
          <h2 className="mt-2 text-2xl font-bold leading-tight">Who are you?</h2>
          <p className="mt-1 text-sm text-muted-foreground">Pick one to explore. You can switch any time.</p>
          <div role="radiogroup" aria-label="Who are you?" className="mt-5 space-y-2.5">
            {SCHOOLS_ROLES.map((r) => {
              const { icon: Icon, line } = ROLE_CARD[r];
              const selected = role === r;
              return (
                <button key={r} type="button" role="radio" aria-checked={selected} onClick={() => setRole(r)}
                  className={cn('flex min-h-[72px] w-full items-center gap-3 rounded-2xl border-2 bg-card p-3.5 text-left transition-colors active:scale-[0.99]',
                    selected ? 'border-primary bg-primary/5' : 'border-transparent shadow-sm ring-1 ring-border hover:ring-primary/40')}>
                  <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl', selected ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary')}>
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{SCHOOLS_ROLE_LABEL[r]}</span>
                    <span className="block text-sm leading-snug text-muted-foreground">{line}</span>
                  </span>
                  <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border')} aria-hidden>
                    {selected && <Check className="h-3.5 w-3.5" />}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex-1" />
          <StickyCta>
            <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={() => role && setStep('intro')} disabled={!role}>
              {role ? `Continue as ${SCHOOLS_ROLE_LABEL[role].toLowerCase()}` : 'Choose one to continue'}
              {role && <ArrowRight className="h-5 w-5" aria-hidden />}
            </Button>
          </StickyCta>
        </>
      )}

      {step === 'intro' && role && (
        <>
          <TopRow index={2} onBack={() => setStep('role')} />
          <div className="relative mt-2 overflow-hidden rounded-3xl">
            <img src={studentsPhoto} alt="Two smiling students with backpacks and a laptop"
              className="aspect-[16/10] w-full object-cover object-[50%_20%]" width={900} height={506} loading="lazy" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" aria-hidden />
            <div className="absolute inset-x-0 bottom-0 p-4 text-white">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/80">{SCHOOLS_ROLE_LABEL[role]}</p>
              <h2 className="mt-0.5 text-xl font-bold leading-tight">{ROLE_INTRO[role].title}</h2>
            </div>
          </div>
          <ol className="mt-4 space-y-2">
            {ROLE_INTRO[role].points.map((p, i) => (
              <li key={p.title} className="flex gap-3 rounded-2xl bg-muted/50 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{i + 1}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{p.title}</span>
                  <span className="block text-sm text-muted-foreground">{p.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="flex-1" />
          <StickyCta>
            <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={() => onDone(role)}>
              Explore my home<ArrowRight className="h-5 w-5" aria-hidden />
            </Button>
          </StickyCta>
        </>
      )}
    </div>
  );
}
