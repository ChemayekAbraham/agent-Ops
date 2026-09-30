import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';

interface SurveyRow {
  id: string;
  code: string;
  kind: 'statutory_consent' | 'reinvestment_pledge';
  title: string;
  active: boolean;
}

interface ResultRow {
  user_id: string;
  full_name: string | null;
  staff_ref: string | null;
  department: string | null;
  response: string | null;
  percentage: number | null;
  payout_mode: string | null;
  tin: string | null;
  nssf_number: string | null;
  no_tin: boolean;
  responded_at: string | null;
  cycle_start: string | null;
}

function answerLabel(r: ResultRow): string {
  if (!r.response) return 'No answer yet';
  if (r.response === 'accept') return 'Accepted';
  if (r.response === 'decline') return 'Declined';
  if (r.response === 'pledge') {
    const mode = r.payout_mode === 'monthly_compounding'
      ? ' · compounding'
      : r.payout_mode === 'monthly_payout'
        ? ' · monthly returns'
        : '';
    return `${r.percentage ?? 0}%${mode}`;
  }
  return r.response;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function StaffSurveyResults() {
  const [surveys, setSurveys] = useState<SurveyRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data, error: err } = await supabase
        .from('staff_surveys' as never)
        .select('id, code, kind, title, active')
        .order('created_at', { ascending: true });
      if (err) { setError(err.message); setLoading(false); return; }
      const list = (data ?? []) as unknown as SurveyRow[];
      setSurveys(list);
      setSelectedId(list[0]?.id ?? null);
      if (list.length === 0) setLoading(false);
    })();
  }, []);

  const loadResults = useCallback(async (surveyId: string) => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('staff_survey_results' as never, {
      _survey_id: surveyId,
    } as never);
    setLoading(false);
    if (err) { setError(err.message); setRows([]); return; }
    setRows(((data ?? []) as unknown) as ResultRow[]);
  }, []);

  useEffect(() => {
    if (selectedId) void loadResults(selectedId);
  }, [selectedId, loadResults]);

  const survey = surveys.find((s) => s.id === selectedId) ?? null;
  const isStatutory = survey?.kind === 'statutory_consent';

  const summary = useMemo(() => {
    const total = rows.length;
    const answered = rows.filter((r) => r.response).length;
    const accepted = rows.filter((r) => r.response === 'accept').length;
    const declined = rows.filter((r) => r.response === 'decline').length;
    const pledged = rows.filter((r) => r.response === 'pledge');
    const withTin = rows.filter((r) => r.tin).length;
    const avgPct = pledged.length
      ? Math.round(pledged.reduce((s, r) => s + (r.percentage ?? 0), 0) / pledged.length)
      : 0;
    return { total, answered, accepted, declined, pledgedCount: pledged.length, withTin, avgPct };
  }, [rows]);

  const resetAnswer = async (r: ResultRow) => {
    if (!survey || !r.response) return;
    const who = r.full_name ?? 'this person';
    if (!window.confirm(`Clear ${who}'s answer for this cycle? They will be asked again.`)) return;
    const { error: err } = await supabase.rpc('staff_survey_reset_answer' as never, {
      _survey_id: survey.id,
      _user_id: r.user_id,
    } as never);
    if (err) { setError(err.message); return; }
    if (selectedId) void loadResults(selectedId);
  };

  const downloadCsv = () => {
    if (!survey) return;
    const header = ['Cycle', 'Staff ref', 'Name', 'Department', 'Answer', 'Percentage', 'Return option', 'TIN', 'No TIN yet', 'NSSF number', 'Answered on'];
    const lines = rows.map((r) =>
      [r.cycle_start, r.staff_ref, r.full_name, r.department, answerLabel(r), r.percentage, r.payout_mode, r.tin, r.no_tin ? 'yes' : '', r.nssf_number, r.responded_at ? new Date(r.responded_at).toLocaleString('en-GB') : '']
        .map(csvCell)
        .join(','),
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${survey.code}-${rows[0]?.cycle_start ?? 'current'}-responses.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Staff surveys</h1>
        <p className="text-sm text-muted-foreground">
          Answers from everyone with an active employee account, for the monthly cycle that
          opened on{' '}
          {rows[0]?.cycle_start
            ? new Date(rows[0].cycle_start).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
            : 'the 26th'}
          . A new cycle opens on the 26th of every month.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {surveys.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant={s.id === selectedId ? 'default' : 'outline'}
            onClick={() => setSelectedId(s.id)}
          >
            {s.title}
          </Button>
        ))}
      </div>

      {survey && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Answered</p><p className="text-2xl font-semibold">{summary.answered} of {summary.total}</p></CardContent></Card>
          {isStatutory ? (
            <>
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Accepted</p><p className="text-2xl font-semibold text-emerald-600">{summary.accepted}</p></CardContent></Card>
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Declined</p><p className="text-2xl font-semibold text-destructive">{summary.declined}</p></CardContent></Card>
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">TIN given</p><p className="text-2xl font-semibold">{summary.withTin}</p></CardContent></Card>
            </>
          ) : (
            <>
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Pledged</p><p className="text-2xl font-semibold text-emerald-600">{summary.pledgedCount}</p></CardContent></Card>
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Declined</p><p className="text-2xl font-semibold text-destructive">{summary.declined}</p></CardContent></Card>
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Average pledge</p><p className="text-2xl font-semibold">{summary.avgPct}%</p></CardContent></Card>
            </>
          )}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{survey?.title ?? 'Responses'}</CardTitle>
          <Button size="sm" variant="outline" onClick={downloadCsv} disabled={!survey || rows.length === 0}>
            <Download className="mr-1 h-4 w-4" /> Download CSV
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : error ? (
            <p role="alert" className="p-4 text-sm font-medium text-destructive">{error}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff ref</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Answer</TableHead>
                    {isStatutory && <TableHead>TIN</TableHead>}
                    {isStatutory && <TableHead>NSSF number</TableHead>}
                    <TableHead>Answered on</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.user_id}>
                      <TableCell className="font-mono text-xs">{r.staff_ref ?? '—'}</TableCell>
                      <TableCell>{r.full_name ?? '—'}</TableCell>
                      <TableCell>{r.department ?? '—'}</TableCell>
                      <TableCell
                        className={
                          r.response === 'decline'
                            ? 'font-semibold text-destructive'
                            : r.response
                              ? 'font-semibold text-emerald-600'
                              : 'text-muted-foreground'
                        }
                      >
                        {answerLabel(r)}
                      </TableCell>
                      {isStatutory && (
                        <TableCell className="font-mono text-xs">
                          {r.tin ?? (r.no_tin ? 'None yet' : '—')}
                        </TableCell>
                      )}
                      {isStatutory && <TableCell className="text-xs">{r.nssf_number ?? '—'}</TableCell>}
                      <TableCell className="text-xs text-muted-foreground">
                        {r.responded_at ? new Date(r.responded_at).toLocaleString('en-GB') : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.response ? (
                          <Button size="sm" variant="outline" onClick={() => void resetAnswer(r)}>
                            Reset
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
