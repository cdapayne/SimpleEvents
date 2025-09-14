import { Request, Response, NextFunction } from 'express';
import { getRepos } from '../lib/db';
import { getPlanDefinition, getOrCreateCurrentUsage } from '../lib/plan';

export async function planLimit(req: Request, res: Response, next: NextFunction) {
  let account = (req as any).account;
  if (!account) return next();
  if (!(account as any).plan) {
    try {
      const { accountRepo } = getRepos();
      const fresh = await accountRepo.find(account.id);
      if (fresh) account = fresh;
    } catch {/* ignore */}
  }
  try {
    const plan = getPlanDefinition(account.plan as any);
    if (!plan) return next();
    if (!isFinite(plan.monthlyEventLimit)) return next();
    const usage = await getOrCreateCurrentUsage(account);
    if (usage.events >= plan.monthlyEventLimit) {
      return res.status(429).json({ error: 'plan_limit_reached' });
    }
    next();
  } catch (e) {
    next(e);
  }
}
