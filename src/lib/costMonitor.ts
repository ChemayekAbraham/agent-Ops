/**
 * Lightweight cost monitoring — tracks request and query counts
 * for internal visibility without adding DB overhead.
 * Data lives in memory only (resets on page refresh).
 */

interface CostMetrics {
  apiRequests: number;
  dbQueries: number;
  edgeFunctionCalls: number;
  startTime: number;
  recentRequests: { timestamp: number; type: string; key: string }[];
}

const metrics: CostMetrics = {
  apiRequests: 0,
  dbQueries: 0,
  edgeFunctionCalls: 0,
  startTime: Date.now(),
  recentRequests: [],
};

const MAX_RECENT = 100;

export function trackRequest(type: 'api' | 'db' | 'edge', key: string): void {
  const now = Date.now();
  if (type === 'api') metrics.apiRequests++;
  else if (type === 'db') metrics.dbQueries++;
  else metrics.edgeFunctionCalls++;

  metrics.recentRequests.push({ timestamp: now, type, key });
  if (metrics.recentRequests.length > MAX_RECENT) {
    metrics.recentRequests = metrics.recentRequests.slice(-MAX_RECENT);
  }
}

export function getCostMetrics() {
  const uptimeMs = Date.now() - metrics.startTime;
  const uptimeMin = Math.max(1, uptimeMs / 60_000);

  return {
    ...metrics,
    requestsPerMinute: +(metrics.apiRequests / uptimeMin).toFixed(1),
    dbQueriesPerMinute: +(metrics.dbQueries / uptimeMin).toFixed(1),
    edgeCallsPerMinute: +(metrics.edgeFunctionCalls / uptimeMin).toFixed(1),
    uptimeMinutes: +uptimeMin.toFixed(1),
  };
}

/** Alert check — returns warnings if usage spikes */
export function checkCostAlerts(): string[] {
  const m = getCostMetrics();
  const alerts: string[] = [];

  if (m.requestsPerMinute > 20) alerts.push(`⚠️ High API rate: ${m.requestsPerMinute}/min`);
  if (m.dbQueriesPerMinute > 30) alerts.push(`⚠️ High DB query rate: ${m.dbQueriesPerMinute}/min`);
  if (m.edgeCallsPerMinute > 5) alerts.push(`⚠️ High edge function rate: ${m.edgeCallsPerMinute}/min`);

  return alerts;
}

// Expose to console for debugging
if (typeof window !== 'undefined') {
  (window as any).__costMetrics = getCostMetrics;
  (window as any).__costAlerts = checkCostAlerts;
}
