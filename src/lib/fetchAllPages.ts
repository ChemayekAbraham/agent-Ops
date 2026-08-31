/**
 * Fetch every page of a server-paginated RPC without a sequential waterfall.
 *
 * The first page is fetched to learn the reported total, then the remaining
 * pages are requested in parallel waves (bounded concurrency) instead of one
 * round trip at a time. For a 4,400-row dataset paged at 100 this turns ~45
 * serial requests into ~6 waves.
 */
export async function fetchAllPages<TItem, TMeta = unknown>(opts: {
  pageSize: number;
  /** Fetch a single page. Must resolve to the items plus the reported total. */
  fetchPage: (offset: number, limit: number) => Promise<{ items: TItem[]; total: number; meta?: TMeta }>;
  /** How many page requests may be in flight at once. */
  concurrency?: number;
  /** Safety valve so a bad total can never spin forever. */
  maxItems?: number;
}): Promise<{ items: TItem[]; total: number; meta?: TMeta }> {
  const { pageSize, fetchPage } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const maxItems = opts.maxItems ?? 20000;

  const first = await fetchPage(0, pageSize);
  const total = Math.min(Number(first.total ?? first.items.length), maxItems);
  if (first.items.length === 0 || total <= first.items.length) {
    return { items: first.items, total: Number(first.total ?? first.items.length), meta: first.meta };
  }

  const offsets: number[] = [];
  for (let offset = first.items.length; offset < total; offset += pageSize) offsets.push(offset);

  const pages: TItem[][] = [];
  for (let i = 0; i < offsets.length; i += concurrency) {
    const wave = await Promise.all(
      offsets.slice(i, i + concurrency).map((offset) => fetchPage(offset, pageSize)),
    );
    let empty = true;
    for (const page of wave) {
      pages.push(page.items);
      if (page.items.length > 0) empty = false;
    }
    // Total shrank underneath us (rows taken by other partners) — stop early.
    if (empty) break;
  }

  return {
    items: [...first.items, ...pages.flat()],
    total: Number(first.total ?? first.items.length),
    meta: first.meta,
  };
}
