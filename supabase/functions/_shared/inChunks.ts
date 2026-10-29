// PostgREST carries an `in (...)` list in the request URL. A few hundred uuids make that URL too long and the
// call fails with "TypeError: Invalid URL" before it reaches the database, so look the rows up in chunks.
export async function selectInChunks<T = any>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
  size = 100,
): Promise<{ data: T[]; error: unknown | null }> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const { data, error } = await run(ids.slice(i, i + size));
    if (error) return { data: out, error };
    if (data) out.push(...data);
  }
  return { data: out, error: null };
}
