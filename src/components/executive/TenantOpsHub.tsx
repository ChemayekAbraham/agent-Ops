import { useState, useEffect, lazy, Suspense } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Sparkles, History, MapPin, Home, BarChart3, FileText, Loader2, ArrowLeft, Layers } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TenantOpsDashboardV2 } from './TenantOpsDashboardV2';
import { TenantOpsGeoCommandCenter } from './tenant-ops/TenantOpsGeoCommandCenter';
import { TenantOpsClassicShell } from './tenant-ops/TenantOpsClassicShell';
import { AgentInactiveAlertBanner } from '@/components/ops/AgentInactiveAlertBanner';
import { BehaviorDrawer } from '@/components/ops/BehaviorDrawer';
import { TenantPhoneDuplicatePanel } from '@/components/ops/TenantPhoneDuplicatePanel';
import { WelileHomesAdminPanel } from '@/components/ops/WelileHomesAdminPanel';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspaceEnabled } from '@/hooks/tenantOpsWorkspace/useWorkspaceEnabled';

// Additive Rule-8 exception (docs/TOPS_BUILD_LOG.md, 2026-09-28): the new
// Tenant Ops Workspace mounted as a fourth, gated mode alongside the three
// existing ones. Lazy — same reason TenantOpsHub itself is lazy-loaded one
// level up in ExecutiveHub.tsx — so a user who never opens this mode never
// pays for its bundle.
const LazyWorkspaceShell = lazy(() => import('@/components/tenant-ops-workspace/WorkspaceShell'));

const STORAGE_KEY = 'tenant-ops-view-mode';

// Same five roles TenantOpsWorkspacePage.tsx already gates the standalone
// /tenant-ops/workspace route on.
const WORKSPACE_ROLES = ['tenant_ops', 'operations', 'coo', 'ceo', 'super_admin'];

type Mode = 'v2' | 'intel' | 'classic' | 'workspace';


export function TenantOpsHub() {
  const [mode, setMode] = useState<Mode>('classic');
  const [opsUserId, setOpsUserId] = useState<string | null>(null);
  const [behaviorTenantId, setBehaviorTenantId] = useState<string | null>(null);
  const [welileHomesOpen, setWelileHomesOpen] = useState(false);
  const [docxBusy, setDocxBusy] = useState(false);
  const [duplicatesHubOpen, setDuplicatesHubOpen] = useState(false);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // Gated on BOTH the kill switch and the same role list the standalone
  // /tenant-ops/workspace route already uses — reusing useWorkspaceEnabled()
  // rather than a second inline RPC call. `data`/`roles` are undefined while
  // still loading, so canShowWorkspace stays false (never a false positive)
  // until both have actually resolved.
  const { roles } = useAuth();
  const { data: workspaceFlagOn } = useWorkspaceEnabled();
  const canShowWorkspace = workspaceFlagOn === true && (roles ?? []).some((r) => WORKSPACE_ROLES.includes(r as string));

  // URL wins over the stored preference so deep links land on the right mode.
  // 'workspace' is only ever accepted once canShowWorkspace has actually
  // resolved true — re-running this effect as that resolves (rather than
  // gating it out of the dependency array) is what lets a direct
  // ?mode=workspace deep link still land correctly once the check catches up,
  // instead of only working on a page that happens to load fast.
  useEffect(() => {
    const fromUrl = params.get('mode');
    const validModes: Mode[] = canShowWorkspace ? ['classic', 'v2', 'intel', 'workspace'] : ['classic', 'v2', 'intel'];
    if (fromUrl && (validModes as string[]).includes(fromUrl)) {
      setMode(fromUrl as Mode);
      return;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (validModes as string[]).includes(saved)) setMode(saved as Mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('mode'), canShowWorkspace]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setOpsUserId(data.user?.id ?? null));
  }, []);

  const setAndSave = (m: Mode) => {
    setMode(m);
    localStorage.setItem(STORAGE_KEY, m);
    const next = new URLSearchParams(params);
    next.set('mode', m);
    next.delete('view');
    setParams(next);
  };


  const generateWordReport = async () => {
    setDocxBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-tenant-ops-docx', { body: {} });
      if (error) throw error;
      const res = data as { ok?: boolean; error?: string; download_url?: string; filename?: string };
      if (!res?.ok || !res.download_url) throw new Error(res?.error || 'Report generation failed');
      const a = document.createElement('a');
      a.href = res.download_url;
      a.download = res.filename || 'welile-tenant-operations-report.docx';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success('Tenant Operations report ready', { description: res.filename });
    } catch (e) {
      toast.error('Could not generate report', { description: (e as Error).message });
    } finally {
      setDocxBusy(false);
    }
  };

  if (duplicatesHubOpen) {
    return (
      <div className="space-y-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setDuplicatesHubOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          className="gap-1.5 -ml-1"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Overview
        </Button>
        <TenantPhoneDuplicatePanel variant="full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AgentInactiveAlertBanner opsUserId={opsUserId} onOpenBehavior={setBehaviorTenantId} />

      {mode !== 'classic' && mode !== 'workspace' && (
        <TenantPhoneDuplicatePanel
          variant="summary"
          onOpenHub={() => { setDuplicatesHubOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
        />
      )}


      <div className="space-y-2">
        {/* Workspace switcher — segmented, full-width on mobile, inline on desktop */}
        <div
          role="tablist"
          aria-label="Tenant Operations workspace"
          className={`grid gap-1 rounded-lg border bg-muted/40 p-1 sm:flex sm:w-auto sm:justify-end sm:border-0 sm:bg-transparent sm:p-0 sm:gap-2 ${canShowWorkspace ? 'grid-cols-4' : 'grid-cols-3'}`}
        >
          {([
            { key: 'v2' as Mode, label: 'New', icon: Sparkles },
            { key: 'intel' as Mode, label: 'Operations Intelligence', short: 'Intelligence', icon: BarChart3 },
            { key: 'classic' as Mode, label: 'Classic', icon: History },
            ...(canShowWorkspace ? [{ key: 'workspace' as Mode, label: 'Workspace', icon: Layers }] : []),
          ]).map(({ key, label, short, icon: Icon }) => (
            <Button
              key={key}
              role="tab"
              aria-selected={mode === key}
              variant={mode === key ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setAndSave(key)}
              className="w-full sm:w-auto flex-col gap-0.5 h-auto py-1.5 px-1 sm:flex-row sm:gap-1.5 sm:py-2 sm:px-3 sm:h-9"
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="text-[10px] leading-tight text-center sm:text-xs sm:leading-none">
                <span className="sm:hidden">{short ?? label}</span>
                <span className="hidden sm:inline">{label}</span>
              </span>
            </Button>
          ))}
        </div>

        {/* Secondary tools — in Classic these live in the sidebar instead; Workspace has its own complete nav/shell, same reason */}
        {mode !== 'classic' && mode !== 'workspace' && (
          <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center sm:justify-start">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/executive-hub?tab=locations')}
              className="gap-1.5 w-full sm:w-auto min-w-0"
            >
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-[11px] sm:text-xs">Locations</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void generateWordReport()}
              disabled={docxBusy}
              className="gap-1.5 w-full sm:w-auto min-w-0"
            >
              {docxBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate text-[11px] sm:text-xs">Word Report</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWelileHomesOpen(true)}
              className="gap-1.5 w-full sm:w-auto min-w-0"
            >
              <Home className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-[11px] sm:text-xs">Welile Homes</span>
            </Button>
          </div>
        )}
      </div>
      {mode === 'v2' ? (
        <TenantOpsDashboardV2 />
      ) : mode === 'intel' ? (
        <TenantOpsGeoCommandCenter />
      ) : mode === 'workspace' && canShowWorkspace ? (
        <Suspense fallback={<div className="animate-pulse text-sm text-muted-foreground">Loading…</div>}>
          <LazyWorkspaceShell embedded />
        </Suspense>
      ) : (
        <TenantOpsClassicShell
          onOpenLocations={() => navigate('/executive-hub?tab=locations')}
          onOpenWelileHomes={() => setWelileHomesOpen(true)}
          onGenerateWordReport={() => void generateWordReport()}
        />
      )}


      <BehaviorDrawer
        tenantId={behaviorTenantId}
        onOpenChange={(open) => { if (!open) setBehaviorTenantId(null); }}
      />

      <Sheet open={welileHomesOpen} onOpenChange={setWelileHomesOpen}>
        <SheetContent side="bottom" className="h-[92vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Home className="h-5 w-5 text-primary" /> Welile Homes — Agent-Managed Tenants</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <WelileHomesAdminPanel />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
