import { useMemo, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useAgentCapacityMap, DAILY_ELIGIBILITY_THRESHOLD } from '@/hooks/useAgentCapacityMap';
import { formatUGX } from '@/lib/rentCalculations';
import { TrendingUp, TrendingDown, Minus, Layers, Target, CheckCircle2, Lock, Loader2, ChevronRight, Share2, Send, Download, ImageDown } from 'lucide-react';
import { AgentCollectionsDrilldownDialog } from './AgentCollectionsDrilldownDialog';
import { AgentCapacityShareCard } from './AgentCapacityShareCard';
import { deriveAgentBadges, BADGE_CLASS } from '@/lib/agentBadges';
import { hapticTap } from '@/lib/haptics';
import { toPng } from 'html-to-image';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

/**
 * Plain-English breakdown panel shown directly under "My Rent-Request Capacity".
 * Answers the three questions agents ask before allocating:
 *   1. How much have I collected today vs my target?
 *   2. How does that compare to yesterday?
 *   3. How many more allocations (slots) can I still make?
 * Ends with a clear can / can't allocate verdict and the reason.
 */
export function AgentCapacityBreakdownPanel() {
  const { user } = useAuth();
  const ids = useMemo(() => (user?.id ? [user.id] : []), [user?.id]);
  const { data, isLoading } = useAgentCapacityMap(ids);
  const cap = user?.id ? data?.get(user.id) : undefined;
  const [drilldownOpen, setDrilldownOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const previewCardRef = useRef<HTMLDivElement>(null);

  if (!user?.id) return null;

  if (isLoading && !cap) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4 flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading capacity breakdown…</span>
      </div>
    );
  }
  if (!cap) return null;

  const todayPct = cap.expected_daily > 0
    ? Math.min(100, Math.round((cap.paid_today / cap.expected_daily) * 100))
    : 0;
  const todayBar = todayPct >= 50 ? 'bg-emerald-500' : todayPct >= 20 ? 'bg-amber-500' : 'bg-destructive';
  const remainingUGX = Math.max(0, cap.expected_daily - cap.paid_today);

  // Yesterday comparison
  const diff = cap.paid_today - cap.paid_yesterday;
  const trendTone = diff > 0 ? 'text-emerald-700' : diff < 0 ? 'text-destructive' : 'text-muted-foreground';
  const TrendIcon = diff > 0 ? TrendingUp : diff < 0 ? TrendingDown : Minus;
  const trendLabel = diff > 0
    ? `${formatUGX(Math.abs(diff))} more than yesterday`
    : diff < 0
      ? `${formatUGX(Math.abs(diff))} less than yesterday`
      : 'Same as yesterday';

  // Remaining slots = how many more per-tenant allocations the headroom allows
  const canPost = cap.can_post_rent_today;
  const remainingSlots = canPost && cap.per_tenant_max > 0
    ? Math.floor(cap.headroom / cap.per_tenant_max)
    : 0;

  const threshold = Math.round(DAILY_ELIGIBILITY_THRESHOLD * 100);
  const unlockNeeded = Math.max(0, Math.round(cap.expected_daily * DAILY_ELIGIBILITY_THRESHOLD) - cap.paid_today);

  // Honour badges derived live from the capacity snapshot (no extra queries).
  const badges = deriveAgentBadges(cap);

  const agentName = (user.user_metadata as any)?.full_name
    || (user.user_metadata as any)?.name
    || user.email?.split('@')[0]
    || 'Agent';
  const dateLabel = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala',
  });

  const openPreview = () => {
    hapticTap();
    setPreviewOpen(true);
  };

  const generatePng = async (pixelRatio = 2) => {
    if (!shareCardRef.current) throw new Error('No card ref');
    return toPng(shareCardRef.current, {
      pixelRatio,
      cacheBust: true,
      skipFonts: true,
    });
  };

  const downloadPng = async (pixelRatio = 2) => {
    if (!shareCardRef.current || sharing) return;
    setSharing(true);
    try {
      const dataUrl = await generatePng(pixelRatio);
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `welile-capacity-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success(pixelRatio > 2 ? 'HD image downloaded' : 'Image downloaded');
    } catch (err) {
      toast.error('Could not generate the image. Please try again.');
    } finally {
      setSharing(false);
      setPreviewOpen(false);
    }
  };

  const doShare = async () => {
    if (!shareCardRef.current || sharing) return;
    setSharing(true);
    try {
      const dataUrl = await generatePng(2);
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const file = new File([blob], `welile-capacity-${Date.now()}.png`, { type: 'image/png' });
      const shareText = `My Welile rent-request capacity today: ${formatUGX(cap.paid_today)} of ${formatUGX(cap.expected_daily)} collected.`;

      const canShareFiles = typeof navigator !== 'undefined'
        && !!navigator.canShare
        && navigator.canShare({ files: [file] });

      if (canShareFiles) {
        await navigator.share({ files: [file], text: shareText, title: 'Welile capacity' });
      } else {
        // Fallback: download the image, then open WhatsApp with the caption
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank');
        toast.success('Image saved — attach it to your WhatsApp message');
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        toast.error('Could not generate the image. Please try again.');
      }
    } finally {
      setSharing(false);
      setPreviewOpen(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" />
          <h4 className="text-sm font-bold text-foreground">Why you can / can&apos;t allocate</h4>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { hapticTap(); downloadPng(2); }}
            disabled={sharing}
            className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-bold text-foreground hover:bg-muted transition-colors disabled:opacity-60"
          >
            {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Download
          </button>
          <button
            type="button"
            onClick={openPreview}
            disabled={sharing}
            className="flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 transition-colors disabled:opacity-60"
          >
            {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
            Share
          </button>
        </div>
      </div>

      {/* Honour badges — esteem big books + daily collection */}
      <div className="flex flex-wrap gap-2">
        {badges.map((b) => (
          <span
            key={b.id}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${BADGE_CLASS[b.tone]}`}
          >
            <span className="text-sm leading-none">{b.icon}</span>
            {b.label}
          </span>
        ))}
      </div>

      {/* 1. Collected today vs target */}
      <button
        type="button"
        onClick={() => { hapticTap(); setDrilldownOpen(true); }}
        className="w-full text-left rounded-xl border border-border bg-background/70 p-3 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center justify-between gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Target className="h-4 w-4 text-primary" />
            Collected today vs target
          </span>
          <span className="flex items-center gap-0.5 text-primary normal-case tracking-normal font-semibold">
            View tenants <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </div>
        <div className="mt-1 text-base font-extrabold tabular-nums text-foreground">
          {formatUGX(cap.paid_today)}
          <span className="text-muted-foreground font-semibold"> / {formatUGX(cap.expected_daily)}</span>
        </div>
        <div className="mt-1.5 h-2.5 w-full rounded-full bg-muted overflow-hidden">
          <div className={`h-full ${todayBar} transition-all`} style={{ width: `${todayPct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {todayPct}% of today&apos;s target
          {remainingUGX > 0 && <> · <strong className="text-foreground">{formatUGX(remainingUGX)}</strong> still to go</>}
        </p>
      </button>

      {/* 2. Yesterday comparison + 3. Remaining slots */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => { hapticTap(); setDrilldownOpen(true); }}
          className="w-full text-left rounded-xl border border-border bg-background/70 p-3 hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wide text-muted-foreground">
            <span>Vs yesterday</span>
            <ChevronRight className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="mt-1 text-base font-extrabold tabular-nums text-foreground">
            {formatUGX(cap.paid_yesterday)}
          </div>
          <div className={`mt-1 flex items-center gap-1.5 text-xs font-semibold ${trendTone}`}>
            <TrendIcon className="h-4 w-4 shrink-0" />
            <span>{trendLabel}</span>
          </div>
        </button>
        <div className="rounded-xl border border-border bg-background/70 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Remaining slots</div>
          <div className="mt-1 text-base font-extrabold tabular-nums text-foreground">
            {remainingSlots}
            <span className="text-muted-foreground font-semibold"> {remainingSlots === 1 ? 'allocation' : 'allocations'}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {canPost
              ? <>Up to {formatUGX(cap.per_tenant_max)} per tenant · {formatUGX(cap.headroom)} headroom left</>
              : <>Unlock allocations first to use your headroom</>}
          </p>
        </div>
      </div>

      {/* Verdict */}
      <div
        className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold ${
          canPost ? 'bg-emerald-500/10 text-emerald-700' : 'bg-destructive/10 text-destructive'
        }`}
      >
        {canPost ? (
          <>
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              You can allocate today — you have met the {threshold}% daily target and have{' '}
              {remainingSlots > 0 ? `${remainingSlots} ${remainingSlots === 1 ? 'slot' : 'slots'} of` : ''} headroom available.
            </span>
          </>
        ) : (
          <>
            <Lock className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              You can&apos;t allocate yet — collect{' '}
              <strong>{formatUGX(unlockNeeded)}</strong> more today to reach the {threshold}% daily target and unlock new allocations.
            </span>
          </>
        )}
      </div>

      <AgentCollectionsDrilldownDialog
        open={drilldownOpen}
        onOpenChange={setDrilldownOpen}
        agentId={user.id}
        expectedDaily={cap.expected_daily}
        headroom={cap.headroom}
        perTenantMax={cap.per_tenant_max}
      />

      <AgentCapacityShareCard
        ref={shareCardRef}
        agentName={agentName}
        paidToday={cap.paid_today}
        expectedDaily={cap.expected_daily}
        paidYesterday={cap.paid_yesterday}
        perTenantMax={cap.per_tenant_max}
        headroom={cap.headroom}
        remainingSlots={remainingSlots}
        canPost={canPost}
        dateLabel={dateLabel}
        badges={badges}
        tenantCount={cap.active_tenant_count}
      />

      {/* Preview before sharing */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-sm p-0 overflow-hidden">
          <DialogHeader className="p-5 pb-0 text-left">
            <DialogTitle>Preview your share card</DialogTitle>
            <DialogDescription>
              Make sure everything looks right before sending to WhatsApp.
            </DialogDescription>
          </DialogHeader>

          <div className="px-5 pb-5 space-y-4">
            <div className="rounded-xl overflow-hidden border border-border shadow-sm">
              <AgentCapacityShareCard
                ref={previewCardRef}
                preview
                agentName={agentName}
                paidToday={cap.paid_today}
                expectedDaily={cap.expected_daily}
                paidYesterday={cap.paid_yesterday}
                perTenantMax={cap.per_tenant_max}
                headroom={cap.headroom}
                remainingSlots={remainingSlots}
                canPost={canPost}
                dateLabel={dateLabel}
                badges={badges}
                tenantCount={cap.active_tenant_count}
              />
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={doShare}
                disabled={sharing}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-700 transition-colors disabled:opacity-60"
              >
                {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {sharing ? 'Generating…' : 'Send to WhatsApp'}
              </button>
              <button
                type="button"
                onClick={() => downloadPng(2)}
                disabled={sharing}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-sm font-bold text-foreground hover:bg-muted transition-colors disabled:opacity-60"
              >
                {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Download PNG
              </button>
              <button
                type="button"
                onClick={() => downloadPng(4)}
                disabled={sharing}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-sm font-bold text-foreground hover:bg-muted transition-colors disabled:opacity-60"
              >
                {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageDown className="h-4 w-4" />}
                Download HD PNG
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AgentCapacityBreakdownPanel;