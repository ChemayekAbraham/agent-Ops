import { ArrowRight, Building2, Handshake, TrendingUp } from 'lucide-react';
import heroAsset from '@/assets/hero.jpg.asset.json';
import { cn } from '@/lib/utils';

function scrollToOpportunities() {
  const el = document.getElementById('opportunities');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const routes = [
  {
    key: 'via-welile',
    title: 'Support tenants via Welile',
    description: 'We deploy the capital and manage the returns.',
    Icon: Building2,
    recommended: false,
  },
  {
    key: 'direct',
    title: 'Support tenants directly',
    description: 'Pay landlords yourself. We handle the introduction and the paperwork.',
    Icon: Handshake,
    recommended: true,
  },
  {
    key: 'angel',
    title: 'Angel pool',
    description: 'Buy a Welile share and back the long-term vision.',
    Icon: TrendingUp,
    recommended: false,
  },
];

export function CapitalRoutesSection({ className }: { className?: string }) {
  return (
    <section id="capital-routes" className={cn('space-y-4', className)} aria-label="Capital routes">
      {/* CTA */}
      <div className="relative isolate overflow-hidden rounded-[clamp(20px,5.5vw,30px)] border border-primary/35">
        <img
          src={heroAsset.url}
          alt="Welile capital routes"
          className="absolute inset-0 -z-20 h-full w-full object-cover"
          loading="lazy"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-black/15 via-black/60 to-black/95" />
        <div className="flex min-h-[clamp(300px,64vw,420px)] items-end px-[clamp(20px,5.5vw,44px)] pb-[clamp(20px,5.5vw,44px)] pt-1 md:items-center md:min-h-[clamp(280px,32vw,380px)] md:pt-2">
          <div className="flex w-full flex-col items-start gap-[clamp(10px,2.6vw,16px)] md:max-w-[60%]">
            <span className="inline-flex items-center gap-[7px] rounded-full border border-white/30 bg-gradient-to-b from-white/25 to-white/10 px-[clamp(11px,3vw,14px)] py-[clamp(7px,2vw,9px)] text-[clamp(9px,2.4vw,11px)] font-bold uppercase tracking-widest text-white backdrop-blur-md">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(74,222,154,0.25)]" />
              Now funding
            </span>
            <h2 className="m-0 max-w-[16ch] text-[clamp(27px,7.6vw,46px)] font-extrabold leading-[1.06] tracking-[-0.03em] text-white md:w-full md:max-w-full">
              Put your capital where the rent is.
            </h2>
            <p className="m-0 max-w-[38ch] text-[clamp(13px,3.6vw,16px)] font-medium leading-relaxed text-white/80">
              Back verified tenants wherever they rent. Three routes into one pool of demand.
            </p>
            <button
              type="button"
              onClick={scrollToOpportunities}
              className="group mt-1 inline-flex items-center justify-center gap-[clamp(6px,1.9vw,10px)] rounded-full border border-white/20 bg-primary px-[clamp(14px,3.8vw,26px)] py-1.5 md:py-[clamp(7px,2vw,12px)] text-[clamp(11.5px,2.9vw,15px)] font-bold tracking-tight text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 active:translate-y-0"
            >
              Choose your route
              <ArrowRight className="h-[clamp(12px,3.1vw,16px)] w-[clamp(12px,3.1vw,16px)] transition-transform group-hover:translate-y-0.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Route cards */}
      <div className="grid scroll-mt-[clamp(14px,4vw,32px)] gap-[clamp(10px,3vw,20px)] md:grid-cols-3">
        {routes.map((route) => (
          <button
            key={route.key}
            type="button"
            onClick={scrollToOpportunities}
            className={cn(
              'group flex w-full flex-col text-left transition-all hover:-translate-y-1 active:-translate-y-px',
              'rounded-[clamp(16px,4.5vw,22px)] bg-card p-[clamp(15px,4.2vw,22px)]',
              route.recommended
                ? 'border-[2.5px] border-primary/50 hover:border-primary'
                : 'border-[1.5px] border-primary hover:border-primary'
            )}
          >
            <div className="mb-[clamp(12px,3.4vw,20px)] flex items-start justify-between gap-2.5">
              <span className="grid h-[clamp(38px,10.5vw,52px)] w-[clamp(38px,10.5vw,52px)] place-items-center rounded-[clamp(11px,3vw,15px)] bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <route.Icon className="h-[clamp(21px,5.8vw,30px)] w-[clamp(21px,5.8vw,30px)]" />
              </span>
              {route.recommended && (
                <span className="inline-flex items-center gap-[clamp(2px,0.8vw,5px)] rounded-full border border-primary/30 bg-primary/10 px-[clamp(6px,2vw,11px)] py-[clamp(4px,1.3vw,7px)] text-[clamp(7.5px,2.1vw,10.5px)] font-bold uppercase tracking-wider text-primary">
                  <svg className="h-[clamp(8px,2.2vw,11px)] w-[clamp(8px,2.2vw,11px)]" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 1.8 9.9 5.7l4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
                  </svg>
                  Recommended
                </span>
              )}
            </div>
            <h3 className="m-0 mb-[clamp(5px,1.6vw,8px)] text-[clamp(18px,5vw,24px)] font-extrabold leading-tight tracking-[-0.02em] text-foreground">
              {route.title}
            </h3>
            <p className="m-0 mb-[clamp(14px,3.8vw,24px)] max-w-[32ch] text-[clamp(12.5px,3.5vw,14.5px)] font-medium leading-relaxed text-muted-foreground">
              {route.description}
            </p>
            <span className="mt-auto grid h-[clamp(30px,8vw,38px)] w-[clamp(30px,8vw,38px)] place-items-center rounded-full bg-primary/10 text-primary transition-all group-hover:translate-x-0.5 group-hover:bg-primary group-hover:text-primary-foreground">
              <ArrowRight className="h-[clamp(13px,3.6vw,16px)] w-[clamp(13px,3.6vw,16px)]" />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
