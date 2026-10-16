import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { useCommunicationAcknowledgement, useCommunicationInbox, readCommunication } from '@/hooks/useCrmCommunications';
import { communicationDashboardRole, type Communication } from '@/lib/crmCommunications';
import { CommunicationDialog, communicationIcons } from './CommunicationDialog';
import { OPEN_COMMUNICATION_EVENT } from './CommunicationsBellSection';

/** Optional announcements yield to any existing modal without changing mandatory gates. */
export default function CommunicationGate() {
  const { user, role, loading, rolesResolved, roles } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const dashboardRole = communicationDashboardRole(location.pathname, role);
  const eligible = !!user && !loading && rolesResolved && !!dashboardRole && roles.includes(dashboardRole);
  const query = useCommunicationInbox(dashboardRole, eligible);
  const acknowledge = useCommunicationAcknowledgement(dashboardRole);
  const [active, setActive] = useState<Communication | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [blocked, setBlocked] = useState(true);
  const [snoozed, setSnoozed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const scope = `${user?.id ?? ''}:${dashboardRole ?? ''}:${location.pathname}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const firstOpen = useRef(false);
  useEffect(() => {
    setActive(null); setListOpen(false); setOpening(false); setError(null); setSnoozed(new Set()); firstOpen.current = false;
  }, [scope]);
  useEffect(() => {
    const check = () => setBlocked(Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some(el => el.getAttribute('data-state') !== 'closed' && el.getAttribute('data-communication-dialog') !== 'true'));
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'role'] });
    check(); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!blocked || !active) return;
    setActive(null);
  }, [blocked, active]);
  async function openMessage(row: Communication) {
    if (!dashboardRole || opening) return;
    const captured = scopeRef.current;
    setOpening(true); setError(null);
    try {
      const fresh = await readCommunication(dashboardRole, row.id);
      if (scopeRef.current !== captured) return;
      if (!fresh) { setError('This communication is no longer available.'); void query.refetch(); return; }
      // Do not race a mandatory gate that appeared during the read.
      const otherModal = document.querySelector('[role="dialog"]:not([data-communication-dialog="true"]),[role="alertdialog"]');
      if (otherModal) return;
      setActive(fresh);
    } catch (e) { if (scopeRef.current === captured) { setError(e instanceof Error ? e.message : 'Unable to open communication.'); setSnoozed(old => new Set([...old, row.id])); } }
    finally { if (scopeRef.current === captured) setOpening(false); }
  }
  useEffect(() => {
    if (!eligible || blocked || active || listOpen || opening || !query.data) return;
    const next = query.data.find(row => !row.acknowledged_at && !snoozed.has(row.id));
    if (!next) return;
    // Let all lazily mounted identity/security gates settle first.
    const timer = window.setTimeout(() => {
      firstOpen.current = true;
      void openMessage(next);
    }, firstOpen.current ? 800 : 5000);
    return () => clearTimeout(timer);
  }, [eligible, blocked, active, listOpen, opening, query.data, snoozed, scope]);
  useEffect(() => {
    if (!active) return;
    const captured = scopeRef.current;
    const timer = setTimeout(() => { if (captured === scopeRef.current) { setActive(null); void query.refetch(); } }, Math.min(2147483647, Math.max(0, new Date(active.expires_at).getTime() - Date.now())));
    const refresh = () => { if (document.visibilityState === 'visible' && dashboardRole) void readCommunication(dashboardRole, active.id).then(fresh => { if (captured === scopeRef.current) setActive(fresh); }).catch(() => { if (captured === scopeRef.current) setActive(null); }); };
    document.addEventListener('visibilitychange', refresh);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [active?.id, dashboardRole]);
  useEffect(() => { if (active && query.data && !query.data.some(row => row.id === active.id)) setActive(null); }, [query.data]);
  const openRef = useRef(openMessage); openRef.current = openMessage;
  useEffect(() => {
    const handler = (e: Event) => { const row = (e as CustomEvent<Communication>).detail; if (row) void openRef.current(row); };
    window.addEventListener(OPEN_COMMUNICATION_EVENT, handler);
    return () => window.removeEventListener(OPEN_COMMUNICATION_EVENT, handler);
  }, []);
  if (!eligible) return null;

  const close = () => { if (active) setSnoozed(old => new Set([...old, active.id])); setActive(null); setError(null); };
  async function confirm() {
    if (!active) return;
    const captured = scopeRef.current;
    try { await acknowledge.mutateAsync(active.id); if (captured === scopeRef.current) close(); }
    catch (e) { if (captured === scopeRef.current) setError(e instanceof Error ? e.message : 'Unable to acknowledge.'); }
  }
  async function openDestination() {
    if (!active || !dashboardRole || !active.link_path) return;
    const captured = scopeRef.current;
    try {
      const fresh = await readCommunication(dashboardRole, active.id);
      if (scopeRef.current !== captured) return;
      if (!fresh?.link_path) { close(); void query.refetch(); return; }
      close(); navigate(fresh.link_path);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to open destination.'); }
  }
  return <>
    <Dialog open={listOpen && !blocked} onOpenChange={setListOpen}><DialogContent stable className="w-[calc(100%-2rem)] rounded-lg" data-communication-dialog="true"><DialogHeader><DialogTitle className="pr-10 tracking-normal">Communications</DialogTitle><DialogDescription>Platform messages</DialogDescription></DialogHeader><Button variant="ghost" size="sm" onClick={() => void query.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>{query.isLoading && <p role="status">Loading…</p>}{(error || query.error) && <p role="alert" className="text-destructive text-sm">{error || query.error?.message}</p>}<div className="divide-y divide-border">{query.data?.map(row => { const Icon = communicationIcons[row.communication_type]; return <Button key={row.id} variant="ghost" className="h-auto w-full py-4 justify-start text-left whitespace-normal" onClick={() => { setListOpen(false); window.setTimeout(() => void openMessage(row), 200); }}><Icon className="h-5 w-5 shrink-0 mr-3 text-primary" /><span className="min-w-0 break-words">{row.title}<span className="block text-xs text-muted-foreground">{row.acknowledged_at ? 'Acknowledged' : 'Unread'}</span></span></Button>; })}{!query.isLoading && !query.error && !query.data?.length && <p className="py-6 text-muted-foreground text-center">No active communications.</p>}</div></DialogContent></Dialog>
    <CommunicationDialog communication={active} open={!!active && !blocked} onClose={close} onAcknowledge={() => void confirm()} onNavigate={() => void openDestination()} pending={acknowledge.isPending} error={error} />
  </>;
}
