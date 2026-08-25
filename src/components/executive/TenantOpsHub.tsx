import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Sparkles, History, MapPin, Home, BarChart3, FileText, Loader2, ArrowLeft } from 'lucide-react';
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

const STORAGE_KEY = 'tenant-ops-view-mode';

type Mode = 'v2' | 'intel' | 'classic';


export function TenantOpsHub() {
  const [mode, setMode] = useState<Mode>('v2');
  const [opsUserId, setOpsUserId] = useState<string | null>(null);
  const [behaviorTenantId, setBehaviorTenantId] = useState<string | null>(null);
  const [welileHomesOpen, setWelileHomesOpen] = useState(false);
  const [docxBusy, setDocxBusy] = useState(false);
  const [duplicatesHubOpen, setDuplicatesHubOpen] = useState(false);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // URL wins over the stored preference so deep links land on the right mode.
  useEffect(() => {
    const fromUrl = params.get('mode');
    if (fromUrl === 'classic' || fromUrl === 'v2' || fromUrl === 'intel') {
      setMode(fromUrl as Mode);
      return;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'classic' || saved === 'v2' || saved === 'intel') setMode(saved as Mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('mode')]);

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

      {mode !== 'classic' && (
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
          className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/40 p-1 sm:flex sm:w-auto sm:justify-end sm:border-0 sm:bg-transparent sm:p-0 sm:gap-2"
        >
          {([
            { key: 'v2' as Mode, label: 'New', icon: Sparkles },
            { key: 'intel' as Mode, label: 'Operations Intelligence', short: 'Intelligence', icon: BarChart3 },
            { key: 'classic' as Mode, label: 'Classic', icon: History },
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

        {/* Secondary tools */}
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
      </div>
      {mode === 'v2' ? <TenantOpsDashboardV2 /> : mode === 'intel' ? <TenantOpsGeoCommandCenter /> : <TenantOpsDashboard />}

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
