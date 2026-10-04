import { cn } from '@/lib/utils';
import mtnLogo from '@/assets/mtn-logo.jpeg.asset.json';
import airtelLogo from '@/assets/airtel-logo.jpeg.asset.json';
import equityLogo from '@/assets/equity-logo.jpeg.asset.json';

interface PaymentMethodIconsProps {
  className?: string;
  iconClassName?: string;
}

const METHODS = [
  { key: 'mtn', label: 'MTN', src: mtnLogo.url, alt: 'MTN Mobile Money' },
  { key: 'airtel', label: 'Airtel', src: airtelLogo.url, alt: 'Airtel Money' },
  { key: 'equity', label: 'Equity', src: equityLogo.url, alt: 'Equity Bank' },
];

export function PaymentMethodIcons({ className, iconClassName }: PaymentMethodIconsProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {METHODS.map(({ key, label, src, alt }) => (
        <div
          key={key}
          className="group relative flex flex-col items-center gap-1"
          title={label}
        >
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background shadow-sm',
              iconClassName,
            )}
          >
            <img
              src={src}
              alt={alt}
              loading="lazy"
              className="h-full w-full object-contain"
            />
          </span>
          <span className="text-[9px] font-medium text-muted-foreground leading-none">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}
