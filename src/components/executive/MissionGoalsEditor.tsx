import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Target, Plus, X, Save, Loader2, Info, RotateCcw } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  MISSION_EDITABLE_DASHBOARDS,
  buildMonthOptions,
  monthKey,
  monthLabel,
  missionDashboardLabel,
  MISSION_FONTS,
  MISSION_DEFAULT_FONT,
  missionFontStack,
  nextMonthKey,
} from '@/lib/dashboardMissions';
import { MissionBanner } from '@/components/mission/MissionBanner';
import { MissionBannerPreview } from '@/components/mission/MissionBannerPreview';
import { MissionsHistoryList } from '@/components/executive/MissionsHistoryList';
import { MissionPublishAuditLog } from '@/components/executive/MissionPublishAuditLog';

export function MissionGoalsEditor() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const monthOptions = buildMonthOptions();

  const [dashboardRole, setDashboardRole] = useState<string>(MISSION_EDITABLE_DASHBOARDS[0].key);
  const [period, setPeriod] = useState<string>(monthKey());
  const [mission, setMission] = useState('');
  const [goals, setGoals] = useState<string[]>(['']);
  const [fontFamily, setFontFamily] = useState<string>(MISSION_DEFAULT_FONT);
  const [postedByName, setPostedByName] = useState('');
  const [saving, setSaving] = useState(false);
  const [responsivePreview, setResponsivePreview] = useState(false);
  const [isDraft, setIsDraft] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  // Load existing mission for the selected dashboard + month
  const { data: existing, isFetching } = useQuery({
    queryKey: ['mission-editor', dashboardRole, period],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dashboard_missions')
        .select('*')
        .eq('dashboard_role', dashboardRole)
        .eq('period_month', period)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    staleTime: 0,
  });

  // The two most recent publish-log snapshots for this dashboard + period. The
  // newest is the live version; the one before it is what a rollback restores.
  const { data: auditHistory } = useQuery({
    queryKey: ['mission-rollback', dashboardRole, period],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('mission_publish_audit')
        .select('*')
        .eq('dashboard_role', dashboardRole)
        .eq('period_month', period)
        .order('published_at', { ascending: false })
        .limit(2);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 0,
  });

  const previousVersion = (auditHistory && auditHistory.length > 1) ? auditHistory[1] : null;

  useEffect(() => {
    if (existing) {
      setMission(existing.mission || '');
      const g = Array.isArray(existing.goals) ? (existing.goals as unknown[]).filter((x) => typeof x === 'string') as string[] : [];
      setGoals(g.length ? g : ['']);
      setFontFamily((existing as any).font_family || MISSION_DEFAULT_FONT);
      setPostedByName((existing as any).posted_by_name || '');
      setIsDraft(false);
    } else {
      setMission('');
      setGoals(['']);
      setFontFamily(MISSION_DEFAULT_FONT);
      setPostedByName('');
    }
  }, [existing, dashboardRole, period]);

  const setGoal = (i: number, v: string) => setGoals((p) => p.map((g, idx) => (idx === i ? v : g)));
  const addGoal = () => setGoals((p) => [...p, '']);
  const removeGoal = (i: number) => setGoals((p) => (p.length === 1 ? [''] : p.filter((_, idx) => idx !== i)));

  const startNewMission = () => {
    const next = nextMonthKey();
    setPeriod(next);
    setMission('');
    setGoals(['']);
    setFontFamily(MISSION_DEFAULT_FONT);
    setIsDraft(true);
    toast.success(`New mission draft started for ${monthLabel(next)} — edit and publish when ready.`);
  };

  const cleanGoals = goals.map((g) => g.trim()).filter(Boolean);

  // Build a field-by-field diff between the saved record and what will be published.
  const existingGoals: string[] = Array.isArray(existing?.goals)
    ? ((existing!.goals as unknown[]).filter((x) => typeof x === 'string' && (x as string).trim()) as string[])
    : [];
  const fontLabel = (key: string | null | undefined) =>
    MISSION_FONTS.find((f) => f.key === (key || MISSION_DEFAULT_FONT))?.label ?? (key || MISSION_DEFAULT_FONT);
  const publishDiff = [
    {
      label: 'Mission statement',
      before: existing ? (existing.mission || '—') : '—',
      after: mission.trim() || '—',
      changed: (existing?.mission || '') !== (mission.trim() || ''),
    },
    {
      label: 'Font',
      before: existing ? fontLabel((existing as any).font_family) : '—',
      after: fontLabel(fontFamily),
      changed: ((existing as any)?.font_family || MISSION_DEFAULT_FONT) !== (fontFamily || MISSION_DEFAULT_FONT),
    },
    {
      label: 'Posted by',
      before: existing ? ((existing as any).posted_by_name || '—') : '—',
      after: postedByName.trim() || '—',
      changed: (((existing as any)?.posted_by_name) || '') !== (postedByName.trim() || ''),
    },
    {
      label: 'Goals',
      before: existing && existingGoals.length ? existingGoals.join(' • ') : '—',
      after: cleanGoals.length ? cleanGoals.join(' • ') : '—',
      changed: JSON.stringify(existingGoals) !== JSON.stringify(cleanGoals),
    },
  ];
  const changedCount = publishDiff.filter((d) => d.changed).length;

  const requestPublish = () => {
    if (!mission.trim() && cleanGoals.length === 0) {
      toast.error('Write a mission statement or at least one goal.');
      return;
    }
    if (!postedByName.trim()) {
      toast.error('Enter your name so it can be shown as "Posted by" on the mission.');
      return;
    }
    setConfirmOpen(true);
  };

  const handleSave = async () => {
    setConfirmOpen(false);
    setSaving(true);
    try {
      const { data: saved, error } = await supabase
        .from('dashboard_missions')
        .upsert(
          {
            dashboard_role: dashboardRole,
            period_month: period,
            mission: mission.trim() || null,
            goals: cleanGoals,
            font_family: fontFamily,
            posted_by_name: postedByName.trim() || null,
            is_active: true,
            created_by: user?.id ?? null,
          },
          { onConflict: 'dashboard_role,period_month' },
        )
        .select('id')
        .single();
      if (error) throw error;

      // Record a publish audit entry (when + who + "Posted by" name).
      const { error: auditError } = await supabase.from('mission_publish_audit').insert({
        mission_id: saved?.id ?? null,
        dashboard_role: dashboardRole,
        period_month: period,
        mission: mission.trim() || null,
        goals_count: cleanGoals.length,
        goals: cleanGoals,
        font_family: fontFamily,
        posted_by_name: postedByName.trim() || null,
        published_by: user?.id ?? null,
      });
      if (auditError) console.error('Failed to record mission publish audit', auditError);

      toast.success(`Mission published for ${missionDashboardLabel(dashboardRole)} — ${monthLabel(period)}`);
      setIsDraft(false);
      queryClient.invalidateQueries({ queryKey: ['mission-editor'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-mission'] });
      queryClient.invalidateQueries({ queryKey: ['missions-history'] });
      queryClient.invalidateQueries({ queryKey: ['mission-publish-audit'] });
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save mission');
    } finally {
      setSaving(false);
    }
  };

  const handleRollback = async () => {
    if (!previousVersion) return;
    setRollbackOpen(false);
    setRollingBack(true);
    try {
      const prevGoals: string[] = Array.isArray((previousVersion as any).goals)
        ? ((previousVersion as any).goals as unknown[]).filter((x) => typeof x === 'string' && (x as string).trim()) as string[]
        : [];
      const prevMission = (previousVersion as any).mission || null;
      const prevFont = (previousVersion as any).font_family || MISSION_DEFAULT_FONT;
      const prevPostedBy = (previousVersion as any).posted_by_name || null;

      const { data: saved, error } = await supabase
        .from('dashboard_missions')
        .upsert(
          {
            dashboard_role: dashboardRole,
            period_month: period,
            mission: prevMission,
            goals: prevGoals,
            font_family: prevFont,
            posted_by_name: prevPostedBy,
            is_active: true,
            created_by: user?.id ?? null,
          },
          { onConflict: 'dashboard_role,period_month' },
        )
        .select('id')
        .single();
      if (error) throw error;

      // Log the rollback as a new publish entry so history stays consistent.
      const { error: auditError } = await supabase.from('mission_publish_audit').insert({
        mission_id: saved?.id ?? null,
        dashboard_role: dashboardRole,
        period_month: period,
        mission: prevMission,
        goals_count: prevGoals.length,
        goals: prevGoals,
        font_family: prevFont,
        posted_by_name: prevPostedBy,
        published_by: user?.id ?? null,
      });
      if (auditError) console.error('Failed to record rollback audit', auditError);

      // Reflect restored values in the form.
      setMission(prevMission || '');
      setGoals(prevGoals.length ? prevGoals : ['']);
      setFontFamily(prevFont);
      setPostedByName(prevPostedBy || '');
      setIsDraft(false);

      toast.success(`Reverted ${missionDashboardLabel(dashboardRole)} — ${monthLabel(period)} to the previous version.`);
      queryClient.invalidateQueries({ queryKey: ['mission-editor'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-mission'] });
      queryClient.invalidateQueries({ queryKey: ['missions-history'] });
      queryClient.invalidateQueries({ queryKey: ['mission-publish-audit'] });
      queryClient.invalidateQueries({ queryKey: ['mission-rollback'] });
    } catch (e: any) {
      toast.error(e?.message || 'Failed to roll back mission');
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <MissionsHistoryList
        onSelect={(role, p) => {
          setDashboardRole(role);
          setPeriod(p);
        }}
        activeRole={dashboardRole}
        activePeriod={period}
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              Monthly Mission & Goals
            </CardTitle>
            <Button
              type="button"
              onClick={startNewMission}
              className="gap-2 shadow-sm"
            >
              <Plus className="h-4 w-4" /> New mission
            </Button>
          </div>
          <CardDescription>
            Write the mission and goals for each dashboard, each month. They appear prominently at
            the top of that dashboard for every operator and executive. Use “Company-wide” to set a
            default mission shown anywhere a specific one isn’t set.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label>Dashboard</Label>
                {isDraft && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600">Draft</span>
                )}
              </div>
              <Select value={dashboardRole} onValueChange={setDashboardRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MISSION_EDITABLE_DASHBOARDS.map((d) => (
                    <SelectItem key={d.key} value={d.key}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Month</Label>
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {monthOptions.map((m) => (
                    <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Mission statement</Label>
            <Textarea
              value={mission}
              onChange={(e) => setMission(e.target.value)}
              placeholder="e.g. This month we relentlessly grow verified tenant placements while protecting solvency."
              className="min-h-[90px]"
              disabled={isFetching}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Mission font</Label>
            <Select value={fontFamily} onValueChange={setFontFamily}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MISSION_FONTS.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    <span style={{ fontFamily: f.stack }}>{f.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Choose the font the mission statement is displayed in across dashboards.</p>
          </div>

          <div className="space-y-1.5">
            <Label>Your name (shown as “Posted by”)</Label>
            <Input
              value={postedByName}
              onChange={(e) => setPostedByName(e.target.value)}
              placeholder="e.g. Jane Doe, CEO"
              disabled={isFetching}
            />
            <p className="text-xs text-muted-foreground">Displayed at the bottom of the mission banner on the dashboard.</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Goals</Label>
              <Button type="button" size="sm" variant="outline" onClick={addGoal} className="gap-1">
                <Plus className="h-3.5 w-3.5" /> Add goal
              </Button>
            </div>
            {goals.map((g, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={g}
                  onChange={(e) => setGoal(i, e.target.value)}
                  placeholder={`Goal ${i + 1}`}
                  disabled={isFetching}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground"
                  onClick={() => removeGoal(i)}
                  aria-label="Remove goal"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={requestPublish} disabled={saving || isFetching || rollingBack} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {existing ? 'Update mission' : 'Publish mission'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRollbackOpen(true)}
              disabled={!previousVersion || saving || rollingBack || isFetching}
              className="gap-2"
              title={previousVersion ? 'Revert to the previously published version' : 'No previous version to revert to'}
            >
              {rollingBack ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Revert to previous
            </Button>
          </div>
          {!previousVersion && (
            <p className="text-xs text-muted-foreground">
              Rollback becomes available once this dashboard has at least two published versions for {monthLabel(period)}.
            </p>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              {existing ? 'Confirm mission update' : 'Confirm publish'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Review the summary below. Once you confirm, this mission goes live on the{' '}
              <strong>{missionDashboardLabel(dashboardRole)}</strong> dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Month</span>
              <span className="font-semibold text-foreground">{monthLabel(period)}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Dashboard</span>
              <span className="font-semibold text-foreground">{missionDashboardLabel(dashboardRole)}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Posted by</span>
              <span className="font-semibold text-foreground">{postedByName.trim() || '—'}</span>
            </div>
            {mission.trim() && (
              <div className="space-y-1">
                <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Mission</span>
                <p className="leading-relaxed text-foreground" style={{ fontFamily: missionFontStack(fontFamily) }}>
                  {mission.trim()}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Key targets ({cleanGoals.length})
              </span>
              {cleanGoals.length ? (
                <ul className="grid gap-1">
                  {cleanGoals.map((g, i) => (
                    <li key={i} className="flex gap-2 text-foreground/90">
                      <span className="font-bold text-primary">{i + 1}.</span> {g}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No goals added.</p>
              )}
            </div>
          </div>

          <div className="space-y-2 rounded-lg border bg-background p-4 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Changes ({changedCount})
              </span>
              <span className="text-[11px] font-medium text-muted-foreground">
                {existing ? 'Updating existing mission' : 'New mission'}
              </span>
            </div>
            {changedCount === 0 ? (
              <p className="text-muted-foreground">No field changes — publishing will re-confirm the current values.</p>
            ) : (
              <ul className="space-y-2.5">
                {publishDiff.filter((d) => d.changed).map((d) => (
                  <li key={d.label} className="space-y-1">
                    <span className="text-xs font-bold uppercase tracking-wide text-foreground">{d.label}</span>
                    <div className="grid gap-1 sm:grid-cols-2">
                      <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5">
                        <span className="block text-[10px] font-bold uppercase tracking-wide text-rose-600">Before</span>
                        <span className="block whitespace-pre-wrap break-words text-rose-700 dark:text-rose-400 line-through decoration-rose-500/40">
                          {d.before}
                        </span>
                      </div>
                      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5">
                        <span className="block text-[10px] font-bold uppercase tracking-wide text-emerald-600">After</span>
                        <span className="block whitespace-pre-wrap break-words font-medium text-emerald-700 dark:text-emerald-400">
                          {d.after}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-amber-700 dark:text-amber-400">
              Publishing updates <strong>only the {missionDashboardLabel(dashboardRole)} dashboard</strong> for{' '}
              <strong>{monthLabel(period)}</strong>. No other dashboard or month is affected — each dashboard keeps its
              own separate mission.
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Back to edit</AlertDialogCancel>
            <AlertDialogAction onClick={handleSave} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {existing ? 'Confirm update' : 'Confirm & publish'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rollbackOpen} onOpenChange={setRollbackOpen}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-primary" />
              Revert to previous version
            </AlertDialogTitle>
            <AlertDialogDescription>
              This restores the previously published mission for{' '}
              <strong>{missionDashboardLabel(dashboardRole)}</strong> — <strong>{monthLabel(period)}</strong>. Only this
              dashboard and period are affected.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {previousVersion && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Published</span>
                <span className="font-semibold text-foreground">
                  {new Date((previousVersion as any).published_at).toLocaleString()}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Posted by</span>
                <span className="font-semibold text-foreground">{(previousVersion as any).posted_by_name || '—'}</span>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Mission</span>
                <p className="leading-relaxed text-foreground">{(previousVersion as any).mission || '—'}</p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Goals</span>
                <span className="font-semibold text-foreground">{(previousVersion as any).goals_count ?? 0}</span>
              </div>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollingBack}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRollback} disabled={rollingBack} className="gap-2">
              {rollingBack ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Confirm rollback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Live preview</p>
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
            <Switch checked={responsivePreview} onCheckedChange={setResponsivePreview} />
            Responsive preview (font sizes &amp; breakpoints)
          </label>
        </div>
        {responsivePreview ? (
          <MissionBannerPreview
            dashboardRole={dashboardRole}
            persistKey={`${dashboardRole}:${period}`}
            missionOverride={{
              mission: mission.trim() || null,
              goals: goals.map((g) => g.trim()).filter(Boolean),
              font_family: fontFamily,
              period_month: period,
              posted_by_name: postedByName.trim() || null,
            }}
          />
        ) : (mission.trim() || goals.some((g) => g.trim())) ? (
          <section className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-4 sm:p-5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-primary-foreground">
                <Target className="h-3 w-3" /> Mission this month
              </span>
              <span className="text-[11px] font-semibold text-muted-foreground">{monthLabel(period)}</span>
            </div>
            {mission.trim() && (
              <p
                className="mt-3 text-sm sm:text-base font-semibold leading-relaxed text-foreground"
                style={{ fontFamily: missionFontStack(fontFamily) }}
              >
                {mission}
              </p>
            )}
            {goals.some((g) => g.trim()) && (
              <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {goals.filter((g) => g.trim()).map((g, i) => (
                  <li key={i} className="text-xs sm:text-sm text-foreground/90">• {g}</li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <MissionBanner dashboardRole={dashboardRole} />
        )}
      </div>

      <MissionPublishAuditLog />
    </div>
  );
}