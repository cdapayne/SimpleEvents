import { Request, Response, NextFunction } from 'express';
import { getRepos, Account, ApiKey } from '../lib/db';

declare global {
  namespace Express {
    interface Request {
      account?: Account;
      apiKeyRecord?: ApiKey;
    }
  }
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.header('X-API-Key');
  if (!key) return res.status(401).json({ error: 'Missing API key' });
  try {
    const { apiKeyRepo, accountRepo } = getRepos();
    const apiKeys = await apiKeyRepo.all();
    const record = apiKeys.find(k => k.key === key && !k.disabledAt);
    if (!record) return res.status(401).json({ error: 'Invalid API key' });
    const account = await accountRepo.find(record.accountId);
    if (!account) return res.status(401).json({ error: 'Invalid API key' });
    req.account = account;
    req.apiKeyRecord = record;
    next();
  } catch (err) {
    next(err);
  }
}