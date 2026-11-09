import { describe, expect, it, vi } from 'vitest';
import { uniqueUuidIds, withUuidIds } from './isUuid';

const id = '14247b23-b000-4000-8000-0123456789ab';
describe('UUID lookup lists', () => {
  it('excludes the production non-ID values and deduplicates IDs', () => {
    expect(uniqueUuidIds([id, id.toUpperCase(), null, 'null', 'tenant', 'Partner', 'Rent Management Pool', 'josh_wanda_admin']))
      .toEqual([id]);
  });
  it('skips an empty profile or portfolio lookup', async () => {
    const load = vi.fn(async () => ({ data: [{ id }], error: null }));
    expect(await withUuidIds(['Partner', 'null'], load)).toMatchObject({ data: [], error: null });
    expect(load).not.toHaveBeenCalled();
  });
  it('passes only valid identifiers to the real lookup', async () => {
    const load = vi.fn(async (ids: string[]) => ({ data: ids, error: null }));
    expect(await withUuidIds([id, 'tenant'], load)).toEqual({ data: [id], error: null });
    expect(load).toHaveBeenCalledWith([id]);
  });
});