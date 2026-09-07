import { ArrowRight } from 'lucide-react';
import heroAsset from '@/assets/hero.jpg.asset.json';
import { cn } from '@/lib/utils';

function scrollToOpportunities() {
  const el = document.getElementById('opportunities');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


export function CapitalRoutesSection({ className }: { className?: string }) {
  return (
    <section id="capital-routes" className={cn('space-y-4', className)} aria-label="Capital routes">
      {/* CTA */}
      <div className="relative isolate min-h-[260px] overflow-hidden rounded-[clamp(20px,5.5vw,30px)] border border-primary/35 bg-background">
        <img
          src={heroAsset.url}
          alt="Welile capital routes"
          className="absolute inset-0 -z-20 h-full w-full object-cover"
          fetchPriority="high"
          decoding="async"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-black/15 via-black/60 to-black/95" />
        <div className="flex min-h-0 items-end px-4 pb-4 pt-4 md:items-center md:min-h-[clamp(280px,32vw,380px)] md:px-[clamp(20px,5.5vw,44px)] md:pb-[clamp(20px,5.5vw,44px)] md:pt-2">
          <div className="flex w-full flex-col items-start gap-2 md:max-w-[80%] md:gap-[clamp(10px,2.6vw,16px)]">
            <span className="inline-flex items-center gap-[7px] rounded-full border border-white/30 bg-gradient-to-b from-white/25 to-white/10 px-[clamp(11px,3vw,14px)] py-[clamp(7px,2vw,9px)] text-[clamp(9px,2.4vw,11px)] font-bold uppercase tracking-widest text-white backdrop-blur-md">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(74,222,154,0.25)]" />
              Now funding
            </span>
            <h2 className="m-0 max-w-[16ch] text-[clamp(27px,7.6vw,46px)] font-extrabold leading-[1.06] tracking-[-0.03em] text-white md:max-w-[24ch]">
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



    </section>
  );
}
