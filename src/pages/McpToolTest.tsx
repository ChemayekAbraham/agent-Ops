import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, Loader2, Play, X, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';

const PROJECT_REF = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? '';
const MCP_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/mcp`;

/**
 * The MCP tool handlers are written for the Deno edge runtime and read their
 * Supabase config from process.env. Populate that shape before the tool modules
 * are imported so the exact same handler code can be exercised in the browser.
 */
function primeRuntimeEnv() {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g.process as { env?: Record<string, string | undefined> } | undefined;
  const proc = existing ?? {};
  proc.env = proc.env ?? {};
  proc.env.SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
  proc.env.SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  g.process = proc;
}

interface Ctx {
  isAuthenticated: () => boolean;
  getUserId: () => string | undefined;
  getUserEmail: () => string | undefined;
  getClientId: () => string | undefined;
  getClaims: () => Record<string, unknown>;
  getToken: () => string | undefined;
}

type ToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

interface RunState {
  status: 'idle' | 'running' | 'pass' | 'fail';
  ms?: number;
  text?: string;
  structured?: unknown;
  error?: string;
  checks?: { label: string; ok: boolean }[];
}

type Field = { key: string; label: string; placeholder: string; kind: 'number' | 'text' };

type LoadedTool = {
  default: { handler: (input: never, ctx: never) => ToolResult | Promise<ToolResult> };
};

interface ToolSpec {
  name: string;
  title: string;
  load: () => Promise<unknown>;
  fields: Field[];
  /** Assertions run against a successful result. */
  check: (r: ToolResult) => { label: string; ok: boolean }[];
}

const numeric = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

const TOOLS: ToolSpec[] = [
  {
    name: 'get_my_profile',
    title: 'Get my profile',
    load: () => import('@/lib/mcp/tools/get-my-profile'),
    fields: [],
    check: (r) => {
      const p = (r.structuredContent as { profile?: Record<string, unknown> } | undefined)?.profile;
      return [
        { label: 'returned a profile object', ok: !!p },
        { label: 'has a full name', ok: typeof p?.full_name === 'string' && !!p.full_name },
        { label: 'has a verification flag', ok: typeof p?.verified === 'boolean' },
      ];
    },
  },
  {
    name: 'get_my_wallet',
    title: 'Get my wallet',
    load: () => import('@/lib/mcp/tools/get-my-wallet'),
    fields: [],
    check: (r) => {
      const w = (r.structuredContent as { wallet?: Record<string, unknown> } | undefined)?.wallet;
      return [
        { label: 'returned a wallet object', ok: !!w },
        { label: 'currency is UGX', ok: w?.currency === 'UGX' },
        { label: 'withdrawable_balance is numeric', ok: numeric(w?.withdrawable_balance) },
        { label: 'float_balance is numeric', ok: numeric(w?.float_balance) },
        { label: 'advance_balance is numeric', ok: numeric(w?.advance_balance) },
        {
          label: 'withdrawable is not negative',
          ok: numeric(w?.withdrawable_balance) && (w!.withdrawable_balance as number) >= 0,
        },
      ];
    },
  },
  {
    name: 'list_my_transactions',
    title: 'List my transactions',
    load: () => import('@/lib/mcp/tools/list-my-transactions'),
    fields: [{ key: 'limit', label: 'limit', placeholder: '20', kind: 'number' }],
    check: (r) => {
      const s = r.structuredContent as { transactions?: unknown } | undefined;
      const rows = Array.isArray(s?.transactions) ? (s!.transactions as Record<string, unknown>[]) : null;
      return [
        { label: 'returned a transactions array', ok: !!rows },
        { label: 'produced text content', ok: !!r.content?.[0]?.text },
        {
          label: rows?.length ? 'every row has a numeric amount' : 'no rows to validate (empty history)',
          ok: !rows ? false : rows.every((x) => numeric(Number(x.amount))),
        },
      ];
    },
  },
  {
    name: 'get_my_wallet_statement',
    title: 'Get my wallet statement',
    load: () => import('@/lib/mcp/tools/get-my-wallet-statement'),
    fields: [
      { key: 'from', label: 'from (YYYY-MM-DD)', placeholder: '2026-07-01', kind: 'text' },
      { key: 'to', label: 'to (YYYY-MM-DD)', placeholder: '2026-07-31', kind: 'text' },
      { key: 'limit', label: 'limit', placeholder: '200', kind: 'number' },
    ],
    check: (r) => {
      const st = (r.structuredContent as { statement?: Record<string, unknown> } | undefined)?.statement;
      const rows = Array.isArray(st?.rows) ? (st!.rows as Record<string, unknown>[]) : null;
      const inTotal = Number(st?.total_in ?? NaN);
      const outTotal = Number(st?.total_out ?? NaN);
      const net = Number(st?.net_movement ?? NaN);
      return [
        { label: 'returned a statement object', ok: !!st },
        { label: 'rows is an array', ok: !!rows },
        { label: 'totals are numeric', ok: numeric(inTotal) && numeric(outTotal) },
        { label: 'net_movement equals in − out', ok: numeric(net) && Math.abs(net - (inTotal - outTotal)) < 1 },
        { label: 'closing_withdrawable is numeric', ok: numeric(Number(st?.closing_withdrawable ?? NaN)) },
      ];
    },
  },
];

function StatusBadge({ state }: { state: RunState }) {
  if (state.status === 'running') {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> Running
      </Badge>
    );
  }
  if (state.status === 'pass') {
    return (
      <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
        <Check className="h-3 w-3" /> Pass{state.ms != null ? ` · ${state.ms}ms` : ''}
      </Badge>
    );
  }
  if (state.status === 'fail') {
    return (
      <Badge variant="destructive" className="gap-1">
        <X className="h-3 w-3" /> Fail{state.ms != null ? ` · ${state.ms}ms` : ''}
      </Badge>
    );
  }
  return <Badge variant="outline">Not run</Badge>;
}

export default function McpToolTest() {
  const navigate = useNavigate();
  const [session, setSession] = useState<{ userId: string; email?: string; token: string } | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [inputs, setInputs] = useState<Record<string, Record<string, string>>>({});
  const [results, setResults] = useState<Record<string, RunState>>({});
  const [endpoint, setEndpoint] = useState<{ status: string; detail: string } | null>(null);
  const [runningAll, setRunningAll] = useState(false);

  useEffect(() => {
    primeRuntimeEnv();
    supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      if (s) setSession({ userId: s.user.id, email: s.user.email ?? undefined, token: s.access_token });
      setLoadingSession(false);
    });
  }, []);

  const buildCtx = useCallback((): Ctx => {
    const s = session;
    return {
      isAuthenticated: () => !!s,
      getUserId: () => s?.userId,
      getUserEmail: () => s?.email,
      getClientId: () => 'mcp-tool-test-screen',
      getClaims: () => ({ sub: s?.userId, email: s?.email, aud: 'authenticated' }),
      getToken: () => s?.token,
    };
  }, [session]);

  const runTool = useCallback(
    async (spec: ToolSpec) => {
      setResults((prev) => ({ ...prev, [spec.name]: { status: 'running' } }));
      const started = performance.now();
      try {
        primeRuntimeEnv();
        const mod = (await spec.load()) as LoadedTool;
        const raw = inputs[spec.name] ?? {};
        const input: Record<string, unknown> = {};
        for (const f of spec.fields) {
          const v = raw[f.key]?.trim();
          if (!v) continue;
          input[f.key] = f.kind === 'number' ? Number(v) : v;
        }
        const result = await mod.default.handler(
          input as never,
          buildCtx() as never,
        );
        const ms = Math.round(performance.now() - started);
        const text = result.content?.map((c) => c.text ?? '').join('\n');
        if (result.isError) {
          setResults((prev) => ({
            ...prev,
            [spec.name]: { status: 'fail', ms, error: text || 'Tool returned isError', text },
          }));
          return false;
        }
        const checks = spec.check(result);
        const ok = checks.every((c) => c.ok);
        setResults((prev) => ({
          ...prev,
          [spec.name]: {
            status: ok ? 'pass' : 'fail',
            ms,
            text,
            structured: result.structuredContent,
            checks,
          },
        }));
        return ok;
      } catch (e) {
        setResults((prev) => ({
          ...prev,
          [spec.name]: {
            status: 'fail',
            ms: Math.round(performance.now() - started),
            error: e instanceof Error ? e.message : String(e),
          },
        }));
        return false;
      }
    },
    [buildCtx, inputs],
  );

  const runAll = useCallback(async () => {
    setRunningAll(true);
    for (const spec of TOOLS) await runTool(spec);
    setRunningAll(false);
  }, [runTool]);

  const checkEndpoint = useCallback(async () => {
    setEndpoint({ status: 'checking', detail: 'Contacting the deployed MCP server…' });
    try {
      const res = await fetch(`${MCP_URL}/.mcp/list-tools`, { headers: { Accept: 'application/json' } });
      const body = await res.text();
      if (!res.ok) {
        setEndpoint({
          status: 'unreachable',
          detail: `HTTP ${res.status}. ${body.slice(0, 300)}`,
        });
        return;
      }
      let names = '';
      try {
        const parsed = JSON.parse(body) as { tools?: { name?: string }[] };
        names = (parsed.tools ?? []).map((t) => t.name).filter(Boolean).join(', ');
      } catch {
        names = body.slice(0, 200);
      }
      setEndpoint({ status: 'live', detail: names || 'Responded, but advertised no tools.' });
    } catch (e) {
      setEndpoint({ status: 'unreachable', detail: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const passed = TOOLS.filter((t) => results[t.name]?.status === 'pass').length;
  const failed = TOOLS.filter((t) => results[t.name]?.status === 'fail').length;

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 pb-24">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-4 -ml-2">
        <ArrowLeft className="mr-1.5 h-4 w-4" />
        Back
      </Button>

      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">MCP tool test</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Runs the real MCP tool handlers against your own signed-in account and asserts the shape of every response.
          Read-only — nothing here writes data.
        </p>
      </header>

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <div className="mr-auto text-sm">
            {loadingSession ? (
              <span className="text-muted-foreground">Checking your session…</span>
            ) : session ? (
              <>
                <span className="font-medium">Signed in as</span>{' '}
                <span className="text-muted-foreground">{session.email ?? session.userId}</span>
              </>
            ) : (
              <span className="flex items-center gap-1.5 text-destructive">
                <AlertTriangle className="h-4 w-4" /> Not signed in — sign in first, the tools need your session.
              </span>
            )}
          </div>
          {(passed > 0 || failed > 0) && (
            <div className="flex gap-2 text-xs">
              <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">{passed} passed</Badge>
              {failed > 0 && <Badge variant="destructive">{failed} failed</Badge>}
            </div>
          )}
          <Button onClick={runAll} disabled={!session || runningAll}>
            {runningAll ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
            Run all tools
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {TOOLS.map((spec) => {
          const state = results[spec.name] ?? { status: 'idle' as const };
          return (
            <Card key={spec.name}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">{spec.title}</CardTitle>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                    {spec.name}
                  </code>
                  <div className="ml-auto flex items-center gap-2">
                    <StatusBadge state={state} />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!session || state.status === 'running'}
                      onClick={() => runTool(spec)}
                    >
                      Run
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {spec.fields.length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    {spec.fields.map((f) => (
                      <div key={f.key} className="space-y-1">
                        <Label htmlFor={`${spec.name}-${f.key}`} className="text-xs">
                          {f.label}
                        </Label>
                        <Input
                          id={`${spec.name}-${f.key}`}
                          placeholder={f.placeholder}
                          value={inputs[spec.name]?.[f.key] ?? ''}
                          onChange={(e) =>
                            setInputs((prev) => ({
                              ...prev,
                              [spec.name]: { ...(prev[spec.name] ?? {}), [f.key]: e.target.value },
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}

                {state.checks && (
                  <ul className="space-y-1">
                    {state.checks.map((c) => (
                      <li key={c.label} className="flex items-center gap-2 text-sm">
                        {c.ok ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        ) : (
                          <X className="h-3.5 w-3.5 shrink-0 text-destructive" />
                        )}
                        <span className={c.ok ? 'text-muted-foreground' : 'text-destructive'}>{c.label}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {state.error && (
                  <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{state.error}</p>
                )}

                {state.text && (
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Text the assistant sees
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs">
                      {state.text}
                    </pre>
                  </div>
                )}

                {state.structured !== undefined && (
                  <details>
                    <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Structured payload
                    </summary>
                    <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
                      {JSON.stringify(state.structured, null, 2)}
                    </pre>
                  </details>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Deployed endpoint</CardTitle>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={checkEndpoint}>
              Check
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <code className="block break-all rounded bg-muted/50 p-2 font-mono text-xs">{MCP_URL}</code>
          {endpoint ? (
            <p className={endpoint.status === 'live' ? 'text-emerald-600' : 'text-muted-foreground'}>
              <span className="font-medium capitalize">{endpoint.status}:</span> {endpoint.detail}
            </p>
          ) : (
            <p className="text-muted-foreground">
              Checks that the published MCP server answers and lists its tools. The server only exists after a publish,
              so this reports unreachable on preview builds even when the tests above all pass.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">export_my_wallet_statement</span> is not listed above: it uses server-only
            Excel and storage APIs, so it can only be exercised against the deployed endpoint from ChatGPT or Claude.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}