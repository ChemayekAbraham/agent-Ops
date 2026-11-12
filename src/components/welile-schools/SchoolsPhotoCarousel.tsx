import { useEffect, useState } from 'react';
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from '@/components/ui/carousel';
import { cn } from '@/lib/utils';
import pupilsPhoto from '@/assets/welile-schools-pupils.jpg';
import studentsPhoto from '@/assets/welile-schools-students.jpg';

const SLIDES = [
  { src: pupilsPhoto, alt: 'Two smiling primary school pupils in uniform with school bags', position: 'object-[50%_30%]' },
  { src: studentsPhoto, alt: 'Two smiling students with backpacks and a laptop', position: 'object-[50%_22%]' },
];
const AUTO_ADVANCE_MS = 5000;

/**
 * Welile Schools photos, swipeable, advancing on their own every 5 seconds.
 * Stops advancing once the viewer swipes, and never auto-advances for people
 * who ask their device for reduced motion.
 */
export default function SchoolsPhotoCarousel({ className, dotsAtTop = false }: { className?: string; /** For a header with a card overlapping the photo's bottom edge. */ dotsAtTop?: boolean }) {
  const [api, setApi] = useState<CarouselApi>();
  const [index, setIndex] = useState(0);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!api) return;
    const onSelect = () => setIndex(api.selectedScrollSnap());
    const onPointer = () => setTouched(true);
    onSelect();
    api.on('select', onSelect);
    api.on('pointerDown', onPointer);
    return () => { api.off('select', onSelect); api.off('pointerDown', onPointer); };
  }, [api]);

  useEffect(() => {
    if (!api || touched) return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => api.scrollNext(), AUTO_ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [api, touched]);

  return (
    <div className={cn('relative', className)} aria-roledescription="carousel" aria-label="Welile Schools photos">
      <Carousel setApi={setApi} opts={{ loop: true }}>
        <CarouselContent>
          {SLIDES.map((s, i) => (
            <CarouselItem key={s.src} aria-roledescription="slide" aria-label={`${i + 1} of ${SLIDES.length}`}>
              <img src={s.src} alt={s.alt} width={900} height={506} loading={i === 0 ? 'eager' : 'lazy'}
                className={cn('aspect-[16/9] w-full rounded-2xl object-cover', s.position)} />
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
      <div className={cn('absolute inset-x-0 flex justify-center gap-1.5', dotsAtTop ? 'top-2' : 'bottom-2')}>
        {SLIDES.map((s, i) => (
          <button key={s.src} type="button" aria-label={`Show photo ${i + 1}`} aria-current={index === i ? 'true' : undefined}
            onClick={() => { setTouched(true); api?.scrollTo(i); }}
            className="flex h-6 items-center px-0.5">
            <span className={cn('block h-1.5 rounded-full bg-white shadow transition-all', index === i ? 'w-6' : 'w-1.5 opacity-60')} />
          </button>
        ))}
      </div>
    </div>
  );
}
