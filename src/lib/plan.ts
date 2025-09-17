// Plan configuration and helpers
import type { Account, PlanUsage, PlanCode } from './db';
import { getRepos } from './db';

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  monthlyEventLimit: number; // Infinity for unlimited
  dashboardsLimit?: number; // number of dashboards allowed (Infinity for unlimited)
  chartsLimit?: number; // number of saved charts or similar
  includedChartTypes?: string[]; // chart types available
  branding?: boolean; // whether branding capability is included
  trialDays?: number;
}

export const PLANS: Record<PlanCode, PlanDefinition> = {
  APP_SUMO_TIER1: { code: 'APP_SUMO_TIER1', name: 'Tier 1', monthlyEventLimit: 50_000, dashboardsLimit: 20, chartsLimit: 20, includedChartTypes: ['bar','line','pie'], branding: false },
  APP_SUMO_TIER2: { code: 'APP_SUMO_TIER2', name: 'Tier 2', monthlyEventLimit: 500_000, dashboardsLimit: 50, chartsLimit: 50, includedChartTypes: ['bar','line','pie','doughnut','radar','polarArea','area'], branding: false },
  TRIAL: { code: 'TRIAL', name: 'Free', monthlyEventLimit: 200, dashboardsLimit: 5, chartsLimit: 5, includedChartTypes: ['bar','line','pie'], trialDays: 14, branding: false },
  UNLIMITED: { code: 'UNLIMITED', name: 'Tier 3', monthlyEventLimit: Infinity, dashboardsLimit: Infinity, chartsLimit: Infinity, includedChartTypes: ['*'], branding: true },
};

export function getPlanDefinition(plan: PlanCode): PlanDefinition {
  return PLANS[plan];
}

export async function getOrCreateCurrentUsage(account: Account): Promise<PlanUsage> {
  const { planUsageRepo } = getRepos();
  const all = await planUsageRepo.all();
  const current = all.find(u => u.accountId === account.id && u.periodStart === account.currentPeriodStart);
  if (current) return current;
  return planUsageRepo.create({
    accountId: account.id,
    periodStart: account.currentPeriodStart,
    periodEnd: account.currentPeriodEnd,
    events: 0,
    eventsIngested: 0,
  });
}

export async function incrementUsage(account: Account, delta: number): Promise<PlanUsage> {
  const { planUsageRepo } = getRepos();
  const usage = await getOrCreateCurrentUsage(account);
  usage.events += delta;
  usage.eventsIngested = (usage.eventsIngested || 0) + delta;
  await planUsageRepo.update(usage.id, { events: usage.events, eventsIngested: usage.eventsIngested });
  return usage;
}

export function usagePercent(limit: number, used: number): number {
  if (!isFinite(limit)) return 0; // unlimited => treat as 0% used for bar logic
  return Math.min(100, Math.round((used / limit) * 100));
}
