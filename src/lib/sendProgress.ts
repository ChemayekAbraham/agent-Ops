/**
 * Progress and timing for the rent request send paths (T4 form, resubmit, renewal,
 * the tenant's own request), so the button moves and the console shows where the
 * seconds go.
 *
 * Nothing slow and optional sits on a send path: notices, SMS and the assistant are
 * fired without waiting (see the callers); the button says "Sent ✓" as soon as the
 * request is saved.
 */

export type SendProgress =
  | { phase: 'uploading'; done: number; total: number }
  | { phase: 'saving' }
  | { phase: 'sent' };

export type OnSendProgress = (p: SendProgress) => void;

/** The button's words for a send in progress, or `idle` when nothing is being sent. */
export function sendButtonLabel(p: SendProgress | null, idle: string): string {
  if (!p) return idle;
  if (p.phase === 'uploading') return `Uploading photos ${p.done}/${p.total}…`;
  if (p.phase === 'saving') return 'Saving…';
  return 'Sent ✓';
}

/**
 * Counts finished uploads and reports them. `add` registers uploads as they are
 * planned; `tick` marks one finished (failed ones too, so the count always ends).
 * Once every upload is in, it reports "saving".
 */
export function createUploadCounter(onProgress?: OnSendProgress) {
  let total = 0;
  let done = 0;
  const report = () => {
    if (!onProgress) return;
    onProgress(total > 0 && done < total ? { phase: 'uploading', done, total } : { phase: 'saving' });
  };
  return {
    add(n: number) { total += n; report(); },
    tick() { done = Math.min(total, done + 1); report(); },
    /** Uploads are over (or there were none): the rest is saving. */
    saving() { onProgress?.({ phase: 'saving' }); },
    get total() { return total; },
    get done() { return done; },
  };
}
export type UploadCounter = ReturnType<typeof createUploadCounter>;

/** Runs `job` and ticks the counter when it settles, whatever the outcome. */
export function counted<T>(counter: UploadCounter | null | undefined, job: Promise<T>): Promise<T> {
  if (!counter) return job;
  return job.finally(() => counter.tick());
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * Times the steps of one send. `step` wraps a promise; `finish` logs one line with
 * the total and each step, e.g. `[send-timing] new request 4.2 s · uploads 2.1 s · …`.
 */
export function createSendTimer(label: string) {
  const start = now();
  const steps: { name: string; ms: number }[] = [];
  return {
    async step<T>(name: string, job: Promise<T>): Promise<T> {
      const t = now();
      try { return await job; } finally { steps.push({ name, ms: now() - t }); }
    },
    finish(outcome: 'ok' | 'failed') {
      const total = now() - start;
      const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
      const line = `[send-timing] ${label} ${outcome} ${s(total)} · ${steps.map((x) => `${x.name} ${s(x.ms)}`).join(' · ')}`;
      try { console.info(line); } catch { /* console unavailable */ }
      return { totalMs: total, steps: [...steps] };
    },
  };
}
