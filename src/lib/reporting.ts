import { Event } from './db';

export type GroupBy = 'type' | 'app' | `payload.${string}`;
export type Aggregate = 'count' | 'sum' | 'avg';
export type Interval = 'hour' | 'day' | 'week' | 'month';

export interface ReportConfig {
  dateRange: { from: string; to: string };
  filters: Array<{ field: 'type' | 'app' | `payload.${string}`; op: 'eq'; value: string }>;
  groupBy: GroupBy;
  aggregate: Aggregate;
  valueField?: `payload.${string}`;
  interval: Interval;
  chartType: 'line' | 'bar' | 'pie' | 'number' | 'doughnut' | 'radar' | 'polarArea' | 'area';
  includeEvents?: string[]; // optional allowlist of event types
  includeApps?: string[];   // optional allowlist of apps
}

interface BucketResult { labels: string[]; series: Record<string, number[]>; }

function parseDate(d: string): Date { return new Date(d); }

function floorToInterval(date: Date, interval: Interval): Date {
  const d = new Date(date);
  if (interval === 'hour') d.setMinutes(0,0,0);
  if (interval === 'day') d.setHours(0,0,0,0);
  if (interval === 'week') {
    const day = d.getUTCDay(); // 0 Sun
    const diff = (day + 6) % 7; // make Monday start
    d.setUTCHours(0,0,0,0);
    d.setUTCDate(d.getUTCDate() - diff);
  }
  if (interval === 'month') { d.setUTCDate(1); d.setUTCHours(0,0,0,0); }
  return d;
}

function addInterval(date: Date, interval: Interval): Date {
  const d = new Date(date);
  if (interval === 'hour') d.setHours(d.getHours()+1);
  if (interval === 'day') d.setDate(d.getDate()+1);
  if (interval === 'week') d.setDate(d.getDate()+7);
  if (interval === 'month') d.setMonth(d.getMonth()+1);
  return d;
}

function formatLabel(date: Date, interval: Interval): string {
  if (interval === 'hour') return date.toISOString().slice(0,13)+':00';
  if (interval === 'day') return date.toISOString().slice(0,10);
  if (interval === 'week') return 'Wk ' + date.toISOString().slice(0,10);
  if (interval === 'month') return date.getUTCFullYear()+'-'+String(date.getUTCMonth()+1).padStart(2,'0');
  return date.toISOString();
}

function getPayloadField(ev: Event, path: string): any {
  const parts = path.split('.').slice(1); // remove 'payload'
  let cur: any = ev.payload || ev.properties || {};
  for (const p of parts) {
    if (cur && typeof cur === 'object') cur = cur[p]; else return undefined;
  }
  return cur;
}

export function aggregateEvents(events: Event[], cfg: ReportConfig): BucketResult {
  const from = parseDate(cfg.dateRange.from);
  const to = parseDate(cfg.dateRange.to);
  const safeFilters = cfg.filters || [];
  const filtered = events.filter(ev => {
    if (cfg.includeEvents && cfg.includeEvents.length && !cfg.includeEvents.includes(ev.type)) return false;
    if (cfg.includeApps && cfg.includeApps.length && !(cfg.includeApps.includes(ev.app || ''))) return false;
    const ts = new Date(ev.ts).getTime();
    if (isNaN(ts) || ts < from.getTime() || ts > to.getTime()) return false;
    for (const f of safeFilters) {
      let val: any;
      if (f.field === 'type') val = ev.type;
      else if (f.field === 'app') val = ev.app || '';
      else if (f.field.startsWith('payload.')) val = getPayloadField(ev, f.field);
      if (String(val) !== f.value) return false;
    }
    return true;
  });

  const baseStart = floorToInterval(from, cfg.interval);
  const buckets: Date[] = [];
  for (let d = new Date(baseStart); d <= to; d = addInterval(d, cfg.interval)) {
    buckets.push(new Date(d));
  }

  const labels = buckets.map(b => formatLabel(b, cfg.interval));
  const series: Record<string, number[]> = {};

  function ensureSeries(key: string) { if (!series[key]) series[key] = Array(buckets.length).fill(0); }

  const valuePath = cfg.valueField;

  filtered.forEach(ev => {
    const tsDate = new Date(ev.ts);
    // find bucket index
    let idx = buckets.findIndex(b => tsDate >= b && tsDate < addInterval(b, cfg.interval));
    if (idx === -1) return; // outside range
    let groupKey: string;
    if (cfg.groupBy === 'type') groupKey = ev.type;
    else if (cfg.groupBy === 'app') groupKey = ev.app || '';
    else if (cfg.groupBy.startsWith('payload.')) groupKey = String(getPayloadField(ev, cfg.groupBy) ?? '');
    else groupKey = 'all';
    ensureSeries(groupKey);
    let inc = 1;
    if (cfg.aggregate !== 'count' && valuePath) {
      const raw = getPayloadField(ev, valuePath);
      const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (!isNaN(num)) inc = num; else inc = 0;
    }
    if (cfg.aggregate === 'count') {
      series[groupKey][idx] += 1;
    } else if (cfg.aggregate === 'sum') {
      series[groupKey][idx] += inc;
    } else if (cfg.aggregate === 'avg') {
      // For avg we accumulate sum in value slot; later we'll divide by counts
      // We'll store counts separately
      if (!('_avgCounts' in series)) (series as any)._avgCounts = {};
      const counts = (series as any)._avgCounts;
      if (!counts[groupKey]) counts[groupKey] = Array(buckets.length).fill(0);
      series[groupKey][idx] += inc;
      counts[groupKey][idx] += 1;
    }
  });

  if ((series as any)._avgCounts) {
    const counts = (series as any)._avgCounts;
    Object.keys(series).filter(k => k !== '_avgCounts').forEach(k => {
      series[k] = series[k].map((v,i) => counts[k][i] ? v / counts[k][i] : 0);
    });
    delete (series as any)._avgCounts;
  }

  return { labels, series };
}

export function toChartResponse(result: BucketResult, cfg: ReportConfig) {
  const labels = result.labels;
  const datasets = Object.keys(result.series).map(k => ({ label: k || '∅', data: result.series[k] }));
  // Table form
  const columns = ['Group', ...labels];
  const rows = datasets.map(ds => ({ group: ds.label, values: ds.data }));
  return { labels, datasets, table: { columns, rows }, chartType: cfg.chartType } as any;
}
