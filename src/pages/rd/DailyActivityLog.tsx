import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ClipboardList, Copy, Download, FileText, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { safeUUID } from '@/lib/safeUUID';
import { dailyActivitiesKey, draftWeeklyReport, kampalaToday, readActivities, shiftWeek, weekDays, weekStart, type DailyActivity } from './dailyActivities';

type Project = { id: string; name: string };
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function DailyActivityLog({ userId, projects, author }: { userId: string; projects: Project[]; author?: string }) {
  const today = kampalaToday();
  const [items, setItems] = useState<DailyActivity[]>(() => { try { return readActivities(localStorage.getItem(dailyActivitiesKey(userId))); } catch { return []; } });
  const [date, setDate] = useState(today);
  const [project, setProject] = useState('');
  const [text, setText] = useState('');
  const [week, setWeek] = useState(weekStart(today));
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');

  const persist = (next: DailyActivity[]) => {
    try { localStorage.setItem(dailyActivitiesKey(userId), JSON.stringify(next)); setItems(next); setError(''); }
    catch { setError('Could not save on this device. Please try again.'); }
  };
  const add = () => {
    if (!text.trim()) { setError('Describe what you did.'); return; }
    if (!date) { setError('Pick a date.'); return; }
    persist([...items, { id: safeUUID(), date, project, text: text.trim(), createdAt: new Date().toISOString() }]);
    setText(''); setWeek(weekStart(date));
  };
  const days = weekDays(week);
  const byDay = useMemo(() => days.map((d) => ({ d, list: items.filter((a) => a.date === d).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) })), [items, week]);
  const count = byDay.reduce((n, x) => n + x.list.length, 0);

  const downloadPdf = async (body: string) => {
    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(body, 186) as string[];
    let y = 16;
    for (const l of lines) { if (y > 282) { doc.addPage(); y = 16; } doc.text(l, 12, y); y += 5; }
    doc.save(`rd-weekly-report-${week}.pdf`);
  };

  return (
    <section className="space-y-4 border-y border-border py-5" aria-labelledby="daily-activities-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="daily-activities-title" className="flex items-center gap-2 text-lg font-semibold"><ClipboardList className="h-5 w-5 text-primary" />My daily activities</h2>
          <p className="text-sm text-muted-foreground">Record what you do each day, then draft your weekly report from it.</p>
        </div>
        <Button onClick={() => setDraft(draftWeeklyReport(items, week, author))} className="gap-2"><FileText className="h-4 w-4" />Draft weekly report</Button>
      </div>

      <div className="grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-[150px_180px_1fr_auto]">
        <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} aria-label="Activity date" />
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className="h-10 rounded-md border border-input bg-background px-3 text-sm">
          <option value="">General / no project</option>
          {projects.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="What did you do?" aria-label="Activity" />
        <Button onClick={add} className="gap-1"><Plus className="h-4 w-4" />Add</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="icon" onClick={() => setWeek(shiftWeek(week, -1))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button>
        <p className="text-sm font-medium">Week {dayLabel(days[0])} – {dayLabel(days[6])} · {count} recorded</p>
        <Button variant="outline" size="icon" onClick={() => setWeek(shiftWeek(week, 1))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {byDay.map(({ d, list }) => (
          <div key={d} className={`rounded-lg border p-3 ${d === today ? 'border-primary' : 'border-border'} bg-card`}>
            <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{dayLabel(d)}</p>
            {list.length === 0 ? <p className="text-xs text-muted-foreground">Nothing recorded</p> : (
              <ul className="space-y-1.5">
                {list.map((a) => (
                  <li key={a.id} className="flex items-start gap-1 text-sm">
                    <span className="flex-1 break-words">{a.project && <span className="font-medium text-primary">{a.project}: </span>}{a.text}</span>
                    <button onClick={() => persist(items.filter((x) => x.id !== a.id))} aria-label="Remove activity" className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Weekly report draft</DialogTitle>
            <DialogDescription>Built from your recorded activities. Edit it, then copy or download.</DialogDescription>
          </DialogHeader>
          <Textarea value={draft ?? ''} onChange={(e) => setDraft(e.target.value)} className="min-h-[360px] font-mono text-xs" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" className="gap-1" onClick={() => navigator.clipboard?.writeText(draft ?? '')}><Copy className="h-4 w-4" />Copy</Button>
            <Button className="gap-1" onClick={() => downloadPdf(draft ?? '')}><Download className="h-4 w-4" />Download PDF</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
