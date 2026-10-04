import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Calendar as CalendarIcon, Bookmark, Download, X, Trash2, AlertCircle,
  Share2, Globe, Lock, Link as LinkIcon, Loader2,
} from 'lucide-react';
import { format, startOfWeek, startOfMonth, subMonths, endOfMonth, differenceInCalendarDays } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { cn } from '@/lib/utils';
import {
  type TenantOpsFilters, type TimeWindowKey, type RentBandKey,
  type LinkBandKey, type PhotosBandKey, type LeafSortKey,
  type OutstandingKey, type VerificationKey, type FundingSourceKey,
  RENT_BANDS, DEFAULT_FILTERS, isFiltersActive,
} from '@/lib/tenantOpsFilters';
import {
  listPresets, createPreset, deletePresetRemote, setPresetVisibility,
  buildShareUrl, type TenantOpsPresetRemote, type PresetVisibility,
} from '@/lib/tenantOpsPresets';
import { toast } from 'sonner';

interface Props {
  filters: TenantOpsFilters;
  onChange: (f: TenantOpsFilters) => void;
  resultCount?: number;
  totalCount?: number;
  onExportCSV?: () => void;
  onExportPDF?: () => void;
  exportDisabled?: boolean;
}

const TIME_CHIPS: { key: TimeWindowKey; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: '24h', label: 'Last 24h' },
  { key: '7d',  label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
];

const LINK_CHIPS: { key: LinkBandKey; label: string }[] = [
  { key: 'any',     label: 'All' },
  { key: 'linked',  label: 'Has landlord' },
  { key: 'pending', label: 'Missing landlord' },
];

const PHOTOS_CHIPS: { key: PhotosBandKey; label: string }[] = [
  { key: 'any',     label: 'Any photos' },
  { key: 'with',    label: 'With photos' },
  { key: 'without', label: 'No photos' },
];

const OUTSTANDING_CHIPS: { key: OutstandingKey; label: string }[] = [
  { key: 'any',       label: 'Any balance' },
  { key: 'paid_up',   label: 'Paid up' },
  { key: 'partial',   label: 'Partial' },
  { key: 'overdue',   label: 'Overdue' },
  { key: 'defaulted', label: 'Defaulted' },
];

const VERIFICATION_CHIPS: { key: VerificationKey; label: string }[] = [
  { key: 'any',      label: 'Any AI-ID' },
  { key: 'verified', label: 'AI-ID verified' },
  { key: 'pending',  label: 'Pending' },
  { key: 'missing',  label: 'Missing ID' },
];

const FUNDING_CHIPS: { key: FundingSourceKey; label: string }[] = [
  { key: 'any',       label: 'Any source' },
  { key: 'supporter', label: 'Supporter' },
  { key: 'platform',  label: 'Platform' },
];

const SORT_OPTIONS: { key: LeafSortKey; label: string }[] = [
  { key: 'name_asc',          label: 'Name A→Z' },
  { key: 'rent_desc',         label: 'Rent (high→low)' },
  { key: 'rent_asc',          label: 'Rent (low→high)' },
  { key: 'funded_desc',       label: 'Most recently funded' },
  { key: 'funded_amount_desc',label: 'Largest funded amount' },
];

export function TenantOpsFilterBar({
  filters, onChange, resultCount, totalCount, onExportCSV, onExportPDF, exportDisabled,
}: Props) {
  const [presets, setPresets] = useState<TenantOpsPresetRemote[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetVis, setPresetVis] = useState<PresetVisibility>('private');
  const [saving, setSaving] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);

  const refreshPresets = async () => {
    setPresetsLoading(true);
    try { setPresets(await listPresets()); }
    catch (e: any) { toast.error(e?.message ?? 'Failed to load presets'); }
    finally { setPresetsLoading(false); }
  };
  useEffect(() => { if (presetsOpen) void refreshPresets(); }, [presetsOpen]);

  const handleSavePreset = async () => {
    if (!presetName.trim()) return;
    setSaving(true);
    try {
      const created = await createPreset({
        name: presetName, filters, visibility: presetVis,
      });
      setPresets((p) => [created, ...p.filter((x) => x.id !== created.id)]);
      setPresetName('');
      if (created.share_slug) {
        const url = buildShareUrl(created.share_slug);
        await navigator.clipboard.writeText(url).catch(() => {});
        toast.success('Shared preset saved — link copied');
      } else {
        toast.success('Preset saved');
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to save preset');
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePresetRemote(id);
      setPresets((p) => p.filter((x) => x.id !== id));
    } catch (e: any) { toast.error(e?.message ?? 'Failed to delete'); }
  };

  const handleShareToggle = async (p: TenantOpsPresetRemote) => {
    try {
      const next = await setPresetVisibility(
        p.id, p.visibility === 'shared' ? 'private' : 'shared',
      );
      setPresets((rows) => rows.map((r) => (r.id === next.id ? next : r)));
      if (next.share_slug) {
        await navigator.clipboard.writeText(buildShareUrl(next.share_slug)).catch(() => {});
        toast.success('Link copied — anyone with the link can load this preset');
      } else {
        toast.success('Preset is now private');
      }
    } catch (e: any) { toast.error(e?.message ?? 'Failed to update sharing'); }
  };

  const handleCopyLink = async (p: TenantOpsPresetRemote) => {
    if (!p.share_slug) return;
    try {
      await navigator.clipboard.writeText(buildShareUrl(p.share_slug));
      toast.success('Share link copied');
    } catch { toast.error('Could not copy link'); }
  };

  const patch = (p: Partial<TenantOpsFilters>) => onChange({ ...filters, ...p });
  const active = isFiltersActive(filters);

  const customFrom  = filters.customFrom ? new Date(filters.customFrom) : undefined;
  const customUntil = filters.customUntil ? new Date(filters.customUntil) : undefined;

  // Draft range while the popover is open (only commits on Apply).
  const [draft, setDraft] = useState<DateRange | undefined>(
    customFrom || customUntil
      ? { from: customFrom, to: customUntil ? new Date(customUntil.getTime() - 24 * 60 * 60 * 1000) : undefined }
      : undefined,
  );

  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const draftError =
    draft?.from && draft?.to && draft.to < draft.from
      ? 'End date must be on or after the start date.'
      : draft?.from && draft.from > today
      ? 'Start date cannot be in the future.'
      : null;

  const draftDays =
    draft?.from && draft?.to ? differenceInCalendarDays(draft.to, draft.from) + 1 : 0;

  const applyDraft = () => {
    if (!draft?.from || draftError) return;
    const to = draft.to ?? draft.from;
    patch({
      timeWindow: 'custom',
      customFrom: draft.from.toISOString(),
      // exclusive upper bound: add 1 day so the end day is fully included.
      customUntil: new Date(to.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
    setPopoverOpen(false);
  };

  const clearDraft = () => {
    setDraft(undefined);
    patch({ timeWindow: 'all', customFrom: null, customUntil: null });
  };

  const quickPick = (kind: 'this_week' | 'this_month' | 'last_month' | 'last_7' | 'last_30') => {
    const now = new Date();
    let from: Date; let to: Date;
    switch (kind) {
      case 'this_week':  from = startOfWeek(now, { weekStartsOn: 1 }); to = now; break;
      case 'this_month': from = startOfMonth(now); to = now; break;
      case 'last_month': from = startOfMonth(subMonths(now, 1)); to = endOfMonth(subMonths(now, 1)); break;
      case 'last_7':     from = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000); to = now; break;
      case 'last_30':    from = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000); to = now; break;
    }
    setDraft({ from, to });
  };

  const customLabel =
    filters.timeWindow === 'custom' && (customFrom || customUntil)
      ? `${customFrom ? format(customFrom, 'MMM d') : '…'} – ${
          customUntil ? format(new Date(customUntil.getTime() - 24 * 60 * 60 * 1000), 'MMM d') : '…'
        }`
      : 'Custom range';

  return (
    <Card className="p-2.5 space-y-2 bg-muted/20">
      {/* Time window row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1">
          Landlord funded
        </span>
        {TIME_CHIPS.map((c) => (
          <Button
            key={c.key}
            size="sm"
            variant={filters.timeWindow === c.key ? 'default' : 'outline'}
            className="h-7 px-2.5 text-[11px]"
            onClick={() => patch({ timeWindow: c.key, customFrom: null, customUntil: null })}
          >
            {c.label}
          </Button>
        ))}
        <Popover
          open={popoverOpen}
          onOpenChange={(o) => {
            setPopoverOpen(o);
            if (o) {
              setDraft(
                customFrom || customUntil
                  ? {
                      from: customFrom,
                      to: customUntil
                        ? new Date(customUntil.getTime() - 24 * 60 * 60 * 1000)
                        : undefined,
                    }
                  : undefined,
              );
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant={filters.timeWindow === 'custom' ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[11px] gap-1"
            >
              <CalendarIcon className="h-3 w-3" />
              {customLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <div className="p-3 space-y-3 w-[320px]">
              <div>
                <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">
                  Pick funded date range
                </p>
                <div className="flex flex-wrap gap-1">
                  {[
                    { k: 'last_7'    as const, l: 'Last 7d' },
                    { k: 'last_30'   as const, l: 'Last 30d' },
                    { k: 'this_week' as const, l: 'This week' },
                    { k: 'this_month'as const, l: 'This month' },
                    { k: 'last_month'as const, l: 'Last month' },
                  ].map((q) => (
                    <Button
                      key={q.k}
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => quickPick(q.k)}
                    >
                      {q.l}
                    </Button>
                  ))}
                </div>
              </div>
              <Calendar
                mode="range"
                selected={draft}
                onSelect={setDraft}
                numberOfMonths={1}
                disabled={{ after: new Date() }}
                defaultMonth={draft?.from ?? customFrom ?? new Date()}
                className={cn('p-0 pointer-events-auto')}
              />
              <div className="rounded-md border bg-muted/30 px-2 py-1.5 text-[11px]">
                {draftError ? (
                  <span className="flex items-center gap-1 text-destructive">
                    <AlertCircle className="h-3 w-3" /> {draftError}
                  </span>
                ) : draft?.from ? (
                  <span className="text-foreground">
                    <span className="font-medium">
                      {format(draft.from, 'MMM d, yyyy')}
                    </span>
                    {draft.to && draft.to.getTime() !== draft.from.getTime() && (
                      <>
                        {' → '}
                        <span className="font-medium">{format(draft.to, 'MMM d, yyyy')}</span>
                        <span className="text-muted-foreground"> · {draftDays} day{draftDays === 1 ? '' : 's'}</span>
                      </>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Tap the start day, then the end day — or use a shortcut above.
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-muted-foreground"
                  onClick={clearDraft}
                >
                  Clear
                </Button>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setPopoverOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 px-3 text-[11px]"
                    onClick={applyDraft}
                    disabled={!draft?.from || !!draftError}
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Rent + link + photos + sort row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1">
          Rent
        </span>
        {RENT_BANDS.map((b) => (
          <Button
            key={b.key}
            size="sm"
            variant={filters.rentBand === b.key ? 'default' : 'outline'}
            className="h-7 px-2 text-[11px]"
            onClick={() => patch({ rentBand: b.key as RentBandKey })}
          >
            {b.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {LINK_CHIPS.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant={filters.linkBand === c.key ? 'default' : 'outline'}
              className="h-7 px-2 text-[11px]"
              onClick={() => patch({ linkBand: c.key })}
            >
              {c.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PHOTOS_CHIPS.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant={filters.photosBand === c.key ? 'default' : 'outline'}
              className="h-7 px-2 text-[11px]"
              onClick={() => patch({ photosBand: c.key })}
            >
              {c.label}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Select value={filters.sort} onValueChange={(v) => patch({ sort: v as LeafSortKey })}>
            <SelectTrigger className="h-7 w-[180px] text-[11px]">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((s) => (
                <SelectItem key={s.key} value={s.key} className="text-xs">{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Status / presets / export row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5 basis-full">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1">
            Balance
          </span>
          {OUTSTANDING_CHIPS.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant={filters.outstanding === c.key ? 'default' : 'outline'}
              className="h-7 px-2 text-[11px]"
              onClick={() => patch({ outstanding: c.key })}
            >
              {c.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 basis-full">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1">
            Verification
          </span>
          {VERIFICATION_CHIPS.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant={filters.verification === c.key ? 'default' : 'outline'}
              className="h-7 px-2 text-[11px]"
              onClick={() => patch({ verification: c.key })}
            >
              {c.label}
            </Button>
          ))}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ml-2 mr-1">
            Source
          </span>
          {FUNDING_CHIPS.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant={filters.fundingSource === c.key ? 'default' : 'outline'}
              className="h-7 px-2 text-[11px]"
              onClick={() => patch({ fundingSource: c.key })}
            >
              {c.label}
            </Button>
          ))}
        </div>
        {active && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px] gap-1 text-muted-foreground"
            onClick={() => onChange({ ...DEFAULT_FILTERS })}
          >
            <X className="h-3 w-3" /> Clear filters
          </Button>
        )}
        {typeof resultCount === 'number' && typeof totalCount === 'number' && (
          <Badge variant="secondary" className="text-[10px]">
            {resultCount.toLocaleString()} of {totalCount.toLocaleString()} tenants
          </Badge>
        )}

        <Popover open={presetsOpen} onOpenChange={setPresetsOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] gap-1">
              <Bookmark className="h-3 w-3" /> Presets {presets.length > 0 && `(${presets.length})`}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[320px] p-2 space-y-2" align="end">
            {active ? (
              <div className="space-y-1.5 border-b pb-2">
                <div className="flex items-center gap-1">
                  <Input
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="Name this view…"
                    className="h-7 text-xs"
                    maxLength={60}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-[11px]"
                    disabled={!presetName.trim() || saving}
                    onClick={handleSavePreset}
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={presetVis === 'private' ? 'default' : 'outline'}
                    className="h-6 px-2 text-[10px] gap-1 flex-1"
                    onClick={() => setPresetVis('private')}
                  >
                    <Lock className="h-3 w-3" /> Private
                  </Button>
                  <Button
                    size="sm"
                    variant={presetVis === 'shared' ? 'default' : 'outline'}
                    className="h-6 px-2 text-[10px] gap-1 flex-1"
                    onClick={() => setPresetVis('shared')}
                  >
                    <Globe className="h-3 w-3" /> Shared link
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {presetVis === 'shared'
                    ? 'A copyable share link will be created. Anyone with the link can load this view.'
                    : 'Only you will see this preset.'}
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground py-1 text-center">
                Apply filters above to save a new preset.
              </p>
            )}
            {presetsLoading ? (
              <div className="flex items-center justify-center py-3 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : presets.length === 0 ? (
              <p className="text-[11px] text-muted-foreground py-2 text-center">
                No saved presets yet.
              </p>
            ) : (
              <div className="space-y-0.5 max-h-72 overflow-y-auto">
                {presets.map((p) => (
                  <div key={p.id} className="flex items-center gap-1 group">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 flex-1 justify-start text-xs gap-1.5 min-w-0"
                      onClick={() => { onChange(p.filters); setPresetsOpen(false); }}
                      title="Load this preset"
                    >
                      {p.visibility === 'shared'
                        ? <Globe className="h-3 w-3 text-primary shrink-0" />
                        : <Lock className="h-3 w-3 text-muted-foreground shrink-0" />}
                      <span className="truncate">{p.name}</span>
                      {!p.is_mine && (
                        <Badge variant="secondary" className="text-[9px] h-4 px-1 shrink-0">
                          shared
                        </Badge>
                      )}
                    </Button>
                    {p.share_slug && (
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() => handleCopyLink(p)}
                        aria-label="Copy share link" title="Copy share link"
                      >
                        <LinkIcon className="h-3 w-3 text-muted-foreground" />
                      </Button>
                    )}
                    {p.is_mine && (
                      <>
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          onClick={() => handleShareToggle(p)}
                          aria-label="Toggle sharing"
                          title={p.visibility === 'shared' ? 'Make private' : 'Share with a link'}
                        >
                          <Share2 className={cn('h-3 w-3', p.visibility === 'shared' ? 'text-primary' : 'text-muted-foreground')} />
                        </Button>
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          onClick={() => handleDelete(p.id)}
                          aria-label="Delete preset"
                        >
                          <Trash2 className="h-3 w-3 text-muted-foreground" />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>

        {onExportCSV && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] gap-1"
            onClick={onExportCSV}
            disabled={exportDisabled}
            title="Export filtered tenants to CSV"
          >
            <Download className="h-3 w-3" /> Export CSV
          </Button>
        )}
        {onExportPDF && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] gap-1"
            onClick={onExportPDF}
            disabled={exportDisabled}
            title="Export filtered tenants to PDF"
          >
            <Download className="h-3 w-3" /> Export PDF
          </Button>
        )}
      </div>
    </Card>
  );
}