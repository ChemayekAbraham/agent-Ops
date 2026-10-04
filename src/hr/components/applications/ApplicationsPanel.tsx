/**
 * Professional careers applications — the screen HR reads them on.
 *
 * Deliberately not a pipeline board and deliberately not scored. It answers one
 * question: who has applied, and who moves forward. Rows are newest first and
 * that order is fixed — sorting a list of people by an evaluative key is
 * forbidden by decision, and arrival order is not evaluative.
 *
 * Filter options are derived from the rows returned, never from a hardcoded
 * list, so a status or category the database starts producing shows up here
 * without a code change and no row is ever silently hidden.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listJobApplications, type JobApplicationRow } from '@/hr/api/applications';
import {
  ApplicationDetailSheet,
  formatDate,
} from '@/hr/components/applications/ApplicationDetailSheet';

const ALL = 'all';

function unique(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort();
}

export default function ApplicationsPanel() {
  const [rows, setRows] = useState<JobApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [selected, setSelected] = useState<JobApplicationRow | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const data = await listJobApplications();
        if (live) setRows(data);
      } catch (e) {
        if (live) {
          setLoadError(e instanceof Error ? e.message : 'Could not load applications.');
        }
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const statuses = useMemo(() => unique(rows.map((r) => r.status)), [rows]);
  const categories = useMemo(() => unique(rows.map((r) => r.category)), [rows]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== ALL && r.status !== status) return false;
      if (category !== ALL && r.category !== category) return false;
      if (!needle) return true;
      return [r.full_name, r.email, r.whatsapp_number, r.role_interest]
        .filter((v): v is string => !!v)
        .some((v) => v.toLowerCase().includes(needle));
    });
  }, [rows, search, status, category]);

  function applyChange(row: JobApplicationRow) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
    setSelected(row);
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (loadError) {
    return (
      <Card className="p-6">
        <p className="text-sm text-destructive">{loadError}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Reload the page. If it keeps failing, check that the signed-in account holds the hr
          role — reading an application depends on the role, not on a dashboard grant.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search name, email, phone or role"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Any category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any category</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          Showing {visible.length} of {rows.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-medium">No applications yet.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Submissions from the careers form on welile.com appear here as they arrive.
          </p>
        </Card>
      ) : visible.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm">Nothing matches those filters.</p>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role interest</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Experience</TableHead>
                <TableHead>Applied</TableHead>
                <TableHead>CV</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => setSelected(r)}>
                  <TableCell className="font-medium">{r.full_name}</TableCell>
                  <TableCell>{r.role_interest || '—'}</TableCell>
                  <TableCell>{r.location || '—'}</TableCell>
                  <TableCell>{r.experience_level || '—'}</TableCell>
                  <TableCell>{formatDate(r.created_at)}</TableCell>
                  <TableCell>{r.resume_url ? 'Yes' : '—'}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <ApplicationDetailSheet
        application={selected}
        onClose={() => setSelected(null)}
        onChanged={applyChange}
      />
    </div>
  );
}
