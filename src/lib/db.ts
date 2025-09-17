import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

/** Data model interfaces */
export type PlanCode = 'APP_SUMO_TIER1' | 'APP_SUMO_TIER2' | 'TRIAL' | 'UNLIMITED';
export interface Account {
  id: string;
  name: string;
  createdAt: string;
  plan: PlanCode;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string | null;
}
export interface User { id: string; accountId: string; email: string; role: 'owner' | 'member'; passwordHash: string; createdAt: string; }
export interface ApiKey { id: string; accountId: string; key: string; label: string; createdAt: string; disabledAt?: string | null; }
export interface Event { id: string; accountId: string; app?: string; type: string; ts: string; userId?: string; sessionId?: string; properties?: Record<string, any>; sourceIp?: string; userAgent?: string; payload?: any; }
export interface Report { id: string; accountId: string; name: string; definition: Record<string, any>; createdAt: string; }
export interface PlanUsage { id: string; accountId: string; periodStart: string; periodEnd: string; events: number; eventsIngested?: number; }
export interface Redemption { id: string; accountId: string; code: string; redeemedAt: string; }
export interface DashboardItem { id: string; accountId: string; reportId: string; x: number; y: number; w: number; h: number; createdAt: string; }

const DB_DIR = path.join(process.cwd(), 'localdb');

/** Ensure directory exists */
function ensureDir() { if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true }); }

/** Atomic JSON write */
async function atomicWrite(file: string, data: any): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.promises.rename(tmp, file);
}

async function readJSON<T>(file: string, fallback: T): Promise<T> {
  try {
    const buf = await fs.promises.readFile(file, 'utf-8');
    return JSON.parse(buf) as T;
  } catch (err: any) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Base repository providing CRUD operations */
class JsonRepo<T extends { id: string }> {
  constructor(private filename: string) {}
  private get filePath() { return path.join(DB_DIR, this.filename); }

  async all(): Promise<T[]> { return await readJSON<T[]>(this.filePath, []); }
  async find(id: string): Promise<T | undefined> { return (await this.all()).find(r => r.id === id); }
  async create(data: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const list = await this.all();
    const record: T = { id: data.id || crypto.randomUUID(), ...(data as any) };
    list.push(record);
    await atomicWrite(this.filePath, list);
    return record;
  }
  async update(id: string, patch: Partial<T>): Promise<T | undefined> {
    const list = await this.all();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return undefined;
    list[idx] = { ...list[idx], ...patch };
    await atomicWrite(this.filePath, list);
    return list[idx];
  }
  async delete(id: string): Promise<boolean> {
    const list = await this.all();
    const next = list.filter(r => r.id !== id);
    if (next.length === list.length) return false;
    await atomicWrite(this.filePath, next);
    return true;
  }
  async replaceAll(data: T[]): Promise<void> { await atomicWrite(this.filePath, data); }
  async count(): Promise<number> { return (await this.all()).length; }
}

/** Specific repositories */
class AccountRepo extends JsonRepo<Account> {}
class UserRepo extends JsonRepo<User> {}
class ApiKeyRepo extends JsonRepo<ApiKey> {}
class EventRepo extends JsonRepo<Event> {}
class ReportRepo extends JsonRepo<Report> {}
class PlanUsageRepo extends JsonRepo<PlanUsage> {}
class RedemptionRepo extends JsonRepo<Redemption> {}
class DashboardItemRepo extends JsonRepo<DashboardItem> {}

export interface Repos {
  accountRepo: AccountRepo;
  userRepo: UserRepo;
  apiKeyRepo: ApiKeyRepo;
  eventRepo: EventRepo;
  reportRepo: ReportRepo;
  planUsageRepo: PlanUsageRepo;
  redemptionRepo: RedemptionRepo;
  dashboardItemRepo: DashboardItemRepo;
}

let repos: Repos | null = null;

async function hashPassword(plain: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

function createRepos(): Repos {
  return {
    accountRepo: new AccountRepo('accounts.json'),
    userRepo: new UserRepo('users.json'),
    apiKeyRepo: new ApiKeyRepo('apiKeys.json'),
    eventRepo: new EventRepo('events.json'),
    reportRepo: new ReportRepo('reports.json'),
    planUsageRepo: new PlanUsageRepo('planUsage.json'),
  redemptionRepo: new RedemptionRepo('redemptions.json'),
  dashboardItemRepo: new DashboardItemRepo('dashboardItems.json')
  };
}

/** Seed data if empty */
async function seedIfNeeded(r: Repos) {
  const existingAccounts = await r.accountRepo.count();
  if (existingAccounts > 0) return; // already seeded

  const now = Date.now();
  const periodStart = new Date(now).toISOString();
  const periodEnd = new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString();
  const account = await r.accountRepo.create({
    name: 'Demo Account',
    createdAt: new Date(now).toISOString(),
    plan: 'TRIAL',
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    canceledAt: null
  });
  // Placeholder password: demo1234
  const passwordHash = await hashPassword('demo1234');
  const owner = await r.userRepo.create({ accountId: account.id, email: 'owner@example.com', role: 'owner', passwordHash, createdAt: new Date(now).toISOString() });
  await r.apiKeyRepo.create({ accountId: account.id, key: crypto.randomUUID().replace(/-/g, ''), label: 'Default', createdAt: new Date(now).toISOString() });

  // Generate ~2000 events over last 14 days
  const events: Event[] = [];
  const total = 2000;
  for (let i = 0; i < total; i++) {
    const offsetMs = Math.floor(Math.random() * 14 * 24 * 60 * 60 * 1000);
    const ts = new Date(now - offsetMs).toISOString();
    events.push({
      id: crypto.randomUUID(),
      accountId: account.id,
      type: ['user.signup', 'page.view', 'order.created', 'order.paid'][Math.floor(Math.random() * 4)],
      ts,
      userId: owner.id,
      properties: { rnd: Math.random() }
    });
  }
  await r.eventRepo.replaceAll(events);
  
    // seed initial plan usage record
    await r.planUsageRepo.create({
      accountId: account.id,
      periodStart,
      periodEnd,
      events: events.length,
      eventsIngested: events.length,
    });
}

export async function initDB(): Promise<Repos> {
  if (repos) return repos;
  ensureDir();
  repos = createRepos();
  await seedIfNeeded(repos);
  return repos;
}

export function getRepos(): Repos {
  if (!repos) throw new Error('DB not initialized. Call initDB() first.');
  return repos;
}
