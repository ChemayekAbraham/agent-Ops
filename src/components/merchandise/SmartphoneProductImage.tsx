import { Smartphone } from 'lucide-react';
import { StorageImage } from '@/components/ui/StorageImage';
import { cn } from '@/lib/utils';

interface Props {
  imageUrl?: string | null;
  brand: string;
  model?: string | null;
  ios?: boolean;
  /** 'lg' for product cards (shows the brand on the placeholder), 'sm' for thumbnails. */
  size?: 'sm' | 'lg';
  className?: string;
}

/**
 * Product photo for a smartphone catalog model. Agent Ops uploads the photo in the
 * catalog; until then a branded placeholder keeps the card layout intact.
 */
export function SmartphoneProductImage({ imageUrl, brand, model, ios, size = 'lg', className }: Props) {
  const placeholder = (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br',
        ios
          ? 'from-slate-100 to-slate-200 text-slate-500 dark:from-slate-800 dark:to-slate-900 dark:text-slate-400'
          : 'from-violet-100 to-violet-200/70 text-violet-500 dark:from-violet-950 dark:to-violet-900 dark:text-violet-300',
      )}
    >
      <Smartphone className={size === 'lg' ? 'h-10 w-10' : 'h-5 w-5'} strokeWidth={1.5} />
      {size === 'lg' && (
        <span className="px-2 text-center text-[10px] font-semibold uppercase tracking-wider line-clamp-1">
          {brand}
        </span>
      )}
    </div>
  );

  return (
    <div className={cn('relative overflow-hidden bg-muted/40', className)}>
      {imageUrl ? (
        <StorageImage
          src={imageUrl}
          alt={[brand, model].filter(Boolean).join(' ')}
          expandable={false}
          loading="lazy"
          fallback={placeholder}
          className={cn('h-full w-full object-contain', size === 'lg' ? 'p-3' : 'p-1')}
        />
      ) : (
        placeholder
      )}
    </div>
  );
}
