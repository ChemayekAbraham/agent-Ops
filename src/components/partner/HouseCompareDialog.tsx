import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDynamic } from '@/lib/currencyFormat';
import { Home, MapPin, ShieldCheck, Wallet, X } from 'lucide-react';
import { houseTitleLine, type SupportableHouse } from './SelfSupportHousesSection';

const MONTHLY_ROI_RATE = 15;

interface HouseCompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  houses: SupportableHouse[];
  /** Float left to fund after current picks — drives the funding status row. */
  remaining: number;
  busy: boolean;
  onFundHouse: (house: SupportableHouse) => void;
  onRemove: (houseId: string) => void;
}

const fundingStatus = (house: SupportableHouse, remaining: number) => {
  const rent = Number(house.monthly_rent || 0);
  if (rent <= remaining) return { ready: true, label: 'Ready to fund now' };
  return {
    ready: false,
    label: `Needs a top-up of ${formatDynamic(Math.max(0, rent - remaining))}`,
  };
};

/**
 * Side-by-side comparison of picked empty houses: photo, rent, expected
 * Returns, location, rooms and funding status. Read-only — funding still goes
 * through the normal pick flow.
 */
export function HouseCompareDialog({
  open,
  onOpenChange,
  houses,
  remaining,
  busy,
  onFundHouse,
  onRemove,
}: HouseCompareDialogProps) {
  const rows: {
    label: string;
    render: (h: SupportableHouse) => React.ReactNode;
    emphasize?: (h: SupportableHouse) => boolean;
  }[] = [
    {
      label: 'Monthly rent',
      render: (h) => <span className="font-black">{formatDynamic(h.monthly_rent)}</span>,
    },
    {
      label: `You earn / month (${MONTHLY_ROI_RATE}%)`,
      render: (h) => (
        <span className="font-black text-primary">
          {formatDynamic(Number(h.partner_monthly_return ?? h.monthly_rent * (MONTHLY_ROI_RATE / 100)))}
        </span>
      ),
    },
    {
      label: 'You earn / year',
      render: (h) => formatDynamic(Number(h.partner_annual_return ?? h.monthly_rent * (MONTHLY_ROI_RATE / 100) * 12)),
    },
    {
      label: 'Location',
      render: (h) =>
        [h.village, h.sub_county, h.district].filter(Boolean).join(', ') || h.region || 'Location on file',
    },
    {
      label: 'House type',
      render: (h) => h.house_category || 'Rental home',
    },
    {
      label: 'Rooms',
      render: (h) => (h.number_of_rooms ? String(h.number_of_rooms) : '—'),
    },
    {
      label: 'Distance from you',
      render: (h) =>
        typeof h.distance_km === 'number' && Number.isFinite(h.distance_km)
          ? `${h.distance_km.toFixed(1)} km`
          : '—',
    },
    {
      label: 'Funding status',
      render: (h) => {
        const status = fundingStatus(h, remaining);
        return (
          <Badge
            variant={status.ready ? 'default' : 'secondary'}
            className="rounded-full text-[10px] font-bold"
          >
            {status.label}
          </Badge>
        );
      },
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 sm:px-5">
          <DialogTitle className="text-base font-black">
            Compare {houses.length} {houses.length === 1 ? 'house' : 'houses'}
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-x-auto px-4 pb-4 sm:px-5 sm:pb-5">
          <table className="w-full min-w-[560px] border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="w-28 align-bottom pb-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" />
                {houses.map((h) => {
                  const image = (h.image_urls ?? []).filter(Boolean)[0] ?? h.image_url;
                  return (
                    <th key={h.house_id} className="min-w-[160px] align-bottom pb-2 pl-3 text-left">
                      <div className="relative">
                        {image ? (
                          <img
                            src={image}
                            alt={houseTitleLine(h)}
                            loading="lazy"
                            decoding="async"
                            className="aspect-[4/3] w-full rounded-xl object-cover"
                          />
                        ) : (
                          <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl bg-muted">
                            <Home className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => onRemove(h.house_id)}
                          aria-label={`Remove ${houseTitleLine(h)} from comparison`}
                          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-xs font-bold leading-tight">
                        {houseTitleLine(h)}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <MapPin className="h-3 w-3 flex-none" aria-hidden />
                        <span className="truncate">{h.district || 'Uganda'}</span>
                      </p>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={row.label}>
                  <th
                    scope="row"
                    className={`border-border py-2 pr-2 text-left text-[11px] font-semibold text-muted-foreground ${rowIndex > 0 ? 'border-t' : ''}`}
                  >
                    {row.label}
                  </th>
                  {houses.map((h) => (
                    <td
                      key={h.house_id}
                      className={`border-border py-2 pl-3 text-xs text-foreground ${rowIndex > 0 ? 'border-t' : ''}`}
                    >
                      {row.render(h)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th className="border-t border-border py-2 pr-2" />
                {houses.map((h) => {
                  const status = fundingStatus(h, remaining);
                  return (
                    <td key={h.house_id} className="border-t border-border py-3 pl-3">
                      <Button
                        size="sm"
                        variant={status.ready ? 'default' : 'outline'}
                        disabled={busy}
                        onClick={() => onFundHouse(h)}
                        aria-label={`${status.ready ? 'Fund' : 'Pick'} ${houseTitleLine(h)}`}
                        className="h-9 w-full rounded-lg text-[11px] font-bold"
                      >
                        {status.ready ? (
                          <ShieldCheck className="mr-1 h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Wallet className="mr-1 h-3.5 w-3.5" aria-hidden />
                        )}
                        {status.ready ? 'Fund this house' : 'Pick & top up'}
                      </Button>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            You earn {MONTHLY_ROI_RATE}% per month of the rent amount you contribute. Welile places
            a tenant and collects the rent for you.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
