// Simple in-memory token bucket rate limiter per API key
// 30 requests per second burst, smooth refill
import { Request, Response, NextFunction } from 'express';

interface Bucket { tokens: number; lastRefill: number; }
const buckets = new Map<string, Bucket>();
const RATE = 30; // tokens per second
const CAPACITY = 30; // max burst

export function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const keyId = (req as any).apiKeyRecord?.id;
  if (!keyId) return next(); // only apply to authenticated API key routes
  const now = Date.now();
  let b = buckets.get(keyId);
  if (!b) { b = { tokens: CAPACITY, lastRefill: now }; buckets.set(keyId, b); }
  const elapsed = (now - b.lastRefill) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(CAPACITY, b.tokens + elapsed * RATE);
    b.lastRefill = now;
  }
  if (b.tokens < 1) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  b.tokens -= 1;
  next();
}
