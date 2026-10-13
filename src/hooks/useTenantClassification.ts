import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  TenantCategory,
  TenantClassificationRow,
  TenantClassificationSummary,
  TenantSubLabel,
} from '@/lib/tenantClassification';

const anyDb = supabase as any;

export const CLASSIFICATION_PAGE_SIZE = 50;
/** Rows read per call when exporting (the server caps a page at 1,000). */
const EXPORT_PAGE = 1000;
/** Most rows one Excel export will carry. */
export const CLASSIFICATION_EXPORT_CAP = 25_000;

export interface ClassificationFilters {
  category: TenantCategory | null;
  sub: TenantSubLabel | null;
  needsReview: boolean;
  search: string;
}

const args = (f: ClassificationFilters, limit: number, offset: number) => ({
  p_category: f.category,
  p_sub: f.sub,
  p_search: f.search.trim() || null,
  p_limit: limit,
  p_offset: offset,
  p_needs_review: f.needsReview,
});

/** Counts for the cards. Read-only: `tops_tenant_classification_summary`. */
export function useTenantClassificationSummary() {
  return useQuery({
    queryKey: ['tenant-classification-summary'],
    staleTime: 120_000,
    queryFn: async (): Promise<TenantClassificationSummary> => {
      const { data, error } = await anyDb.rpc('tops_tenant_classification_summary');
      if (error) throw new Error(error.message);
      return data as TenantClassificationSummary;
    },
  });
}

export interface ClassificationPage {
  rows: TenantClassificationRow[];
  total: number;
}

/** One page (50) of the list. Read-only: `tops_tenant_classification_list`. */
export function useTenantClassificationList(filters: ClassificationFilters, page: number) {
  return useQuery({
    queryKey: ['tenant-classification-list', filters.category, filters.sub, filters.needsReview, filters.search.trim(), page],
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<ClassificationPage> => {
      const { data, error } = await anyDb.rpc(
        'tops_tenant_classification_list',
        args(filters, CLASSIFICATION_PAGE_SIZE, page * CLASSIFICATION_PAGE_SIZE),
      );
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as TenantClassificationRow[];
      return { rows, total: rows.length > 0 ? Number(rows[0].total_rows) : 0 };
    },
  });
}

/** Every row of the current filter for an export, read page by page up to `cap`. */
export async function fetchClassificationRowsForExport(
  filters: ClassificationFilters,
  cap: number = CLASSIFICATION_EXPORT_CAP,
): Promise<{ rows: TenantClassificationRow[]; total: number; truncated: boolean }> {
  const rows: TenantClassificationRow[] = [];
  let total = 0;
  for (let offset = 0; offset < cap; offset += EXPORT_PAGE) {
    const limit = Math.min(EXPORT_PAGE, cap - offset);
    const { data, error } = await anyDb.rpc('tops_tenant_classification_list', args(filters, limit, offset));
    if (error) throw new Error(error.message);
    const page = (data ?? []) as TenantClassificationRow[];
    if (page.length === 0) break;
    total = Number(page[0].total_rows);
    rows.push(...page);
    if (rows.length >= total) break;
  }
  return { rows, total, truncated: total > rows.length };
}
