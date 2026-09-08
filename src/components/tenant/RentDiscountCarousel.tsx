import { useMemo } from 'react';
import { BadgePercent } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { Carousel, Card, type SpecialsCard } from '@/components/ui/specials-linear-carousel';
import promoRetire from '@/assets/promo-retire-excuses.jpg.asset.json';
import promoSalary from '@/assets/promo-salary-gone.jpg.asset.json';
import promoPocket from '@/assets/promo-pocket-change.jpg.asset.json';
import promoSchool from '@/assets/promo-school-of-ai.jpg.asset.json';
import promoZeroRent from '@/assets/promo-365-days-zero-rent.jpg.asset.json';
import promoZeroTech from '@/assets/promo-zero-tech-background.jpg.asset.json';
import promoDowry from '@/assets/promo-welile-dowry.jpg.asset.json';
import promoWelcomeSeptember from '@/assets/promo-welcome-september.png';

const PROMOS: SpecialsCard[] = [
  { src: promoWelcomeSeptember, title: 'Welcome September — may this month open new doors and reward your hard work' },
  { src: promoRetire.url, title: 'Retire your creative rent excuse stories' },
  { src: promoDowry.url, title: 'Welile Dowry — from UGX 500K, get your wedding budget sorted' },
  { src: promoZeroRent.url, title: '365 days, zero rent headaches — 12 months paid upfront' },
  { src: promoSalary.url, title: 'Salary came in at 9:00 AM, gone by 9:05 AM?' },
  { src: promoPocket.url, title: 'Turn loose pocket change into solid roof coverage' },
  { src: promoZeroTech.url, title: 'Zero tech background needed — learn to prompt AI effectively' },
  { src: promoSchool.url, title: 'Master the tools driving global tech — Welile School of AI' },
];

interface RentDiscountCarouselProps {
  /** Same percentage discount the tenant earned on bread (e.g. 0.05 for 5%). */
  discountPct: number;
  /** Optional: invoked when the user taps a card. */
  onSelectHouse?: () => void;
}

export function RentDiscountCarousel({ discountPct, onSelectHouse }: RentDiscountCarouselProps) {
  const pct = useMemo(() => Math.max(0, Math.min(0.5, discountPct)), [discountPct]);
  const pctLabel = `${Math.round(pct * 100)}%`;

  const cards = PROMOS.map((card, index) => (
    <Card
      key={card.title}
      card={card}
      index={index}
      onClick={() => {
        hapticTap();
        onSelectHouse?.();
      }}
    />
  ));

  return (
    <section className="space-y-2" aria-label="Welile rent offers">
      <div className="flex items-center justify-between px-1">
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground flex items-center gap-1.5">
            <BadgePercent className="h-4 w-4 text-emerald-600" />
            Use your {pctLabel} on rent
          </p>
          <p className="text-[11px] text-muted-foreground">
            Apply the same discount to your monthly rent at any available house.
          </p>
        </div>
      </div>
      <div className="-mx-4 px-4">
        <Carousel items={cards} autoplay autoplaySpeed={0.4} />
      </div>
    </section>
  );
}

export default RentDiscountCarousel;
