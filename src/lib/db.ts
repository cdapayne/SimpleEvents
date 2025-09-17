import mysql, { Pool, PoolOptions, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import crypto from 'crypto';

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

export interface User {
  id: string;
  accountId: string;
  email: string;
  role: 'owner' | 'member';
  passwordHash: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  accountId: string;
  key: string;
  label: string;
  createdAt: string;
  disabledAt?: string | null;
}

export interface Event {
  id: string;
  accountId: string;
  app?: string;
  type: string;
  ts: string;
  userId?: string;
  sessionId?: string;
  properties?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  sourceIp?: string;
  userAgent?: string;
}

export interface Report {
  id: string;
  accountId: string;
  name: string;
  definition: Record<string, unknown>;
  createdAt: string;
}

export interface PlanUsage {
  id: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  events: number;
  eventsIngested?: number;
}

export interface Redemption {
  id: string;
  accountId: string;
  code: string;
  redeemedAt: string;
}

export interface DashboardItem {
  id: string;
  accountId: string;
  reportId?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: string;
  type?: string;
  pxX?: number | null;
  pxY?: number | null;
  pxW?: number | null;
  pxH?: number | null;
  brandingTitle?: string | null;
  brandingSubtitle?: string | null;
  brandingLogo?: string | null;
  updatedAt?: string | null;
}

type CreateInput<T> = Omit<T, 'id'> & { id?: string };

type CrudRepo<T> = {
  all(): Promise<T[]>;
  find(id: string): Promise<T | undefined>;
  create(data: CreateInput<T>): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
};

type ApiKeyRepository = CrudRepo<ApiKey> & {
  findByKey(key: string): Promise<ApiKey | undefined>;
};

type DashboardItemRepository = CrudRepo<DashboardItem>;

type PlanUsageRepository = CrudRepo<PlanUsage>;

type EventRepository = CrudRepo<Event>;

type ReportRepository = CrudRepo<Report>;

type UserRepository = CrudRepo<User>;

type AccountRepository = CrudRepo<Account>;

type RedemptionRepository = CrudRepo<Redemption>;

export interface Repos {
  accountRepo: AccountRepository;
  userRepo: UserRepository;
  apiKeyRepo: ApiKeyRepository;
  eventRepo: EventRepository;
  reportRepo: ReportRepository;
  planUsageRepo: PlanUsageRepository;
  redemptionRepo: RedemptionRepository;
  dashboardItemRepo: DashboardItemRepository;
}

let pool: Pool | null = null;
let repos: Repos | null = null;

const PLAN_TIERS: Record<PlanCode, { label: string; tier: number }> = {
  TRIAL: { label: 'Trial', tier: 0 },
  APP_SUMO_TIER1: { label: 'Tier 1', tier: 1 },
  APP_SUMO_TIER2: { label: 'Tier 2', tier: 2 },
  UNLIMITED: { label: 'Tier 3', tier: 3 }
};

const PLAN_LADDER: PlanCode[] = ['TRIAL', 'APP_SUMO_TIER1', 'APP_SUMO_TIER2', 'UNLIMITED'];

function describePlan(plan?: PlanCode) {
  const safe = (plan && PLAN_TIERS[plan]) ? plan : 'TRIAL';
  const meta = PLAN_TIERS[safe];
  const idx = PLAN_LADDER.indexOf(safe);
  const nextCode = idx >= 0 && idx < PLAN_LADDER.length - 1 ? PLAN_LADDER[idx + 1] : null;
  return {
    code: safe,
    tierLabel: meta.label,
    tier: meta.tier,
    nextCode,
    nextLabel: nextCode ? PLAN_TIERS[nextCode].label : null
  };
}

function getPool(): Pool {
  if (!pool) throw new Error('Database not initialised. Call initDB() first.');
  return pool;
}

function isDateValue(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function ensureIso(value: unknown): string {
  const date = isDateValue(value) ? value : new Date(value as any);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function toDateOrNull(value?: string | Date | null): Date | null {
  if (value === null || value === undefined) return null;
  if (isDateValue(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseJsonField<T>(value: any): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (err) {
      return undefined;
    }
  }
  return value as T;
}

function boolFromDb(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return Boolean(value);
}

function buildUpdate<T>(table: string, id: string, patch: Partial<T>, mapper: (row: RowDataPacket) => T): Promise<T | undefined> {
  const poolRef = getPool();
  const fields: string[] = [];
  const params: any[] = [];

  const entries = Object.entries(patch as Record<string, unknown>);
  for (const [key, raw] of entries) {
    if (raw === undefined) continue;
    const column = camelToSnake(key);
    if (column === 'id') continue;
    const value: any = raw;
    if (value === null) {
      fields.push(`\`${column}\` = ?`);
      params.push(null);
    } else if (value instanceof Date) {
      fields.push(`\`${column}\` = ?`);
      params.push(value);
    } else if (typeof value === 'boolean') {
      fields.push(`\`${column}\` = ?`);
      params.push(value ? 1 : 0);
    } else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      fields.push(`\`${column}\` = ?`);
      params.push(JSON.stringify(value));
    } else {
      fields.push(`\`${column}\` = ?`);
      params.push(value);
    }
  }

  if (!fields.length) {
    return poolRef
      .query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id])
      .then(([rows]) => rows[0] ? mapper(rows[0]) : undefined);
  }

  params.push(id);
  return poolRef
    .query<ResultSetHeader>(`UPDATE \`${table}\` SET ${fields.join(', ')} WHERE id = ?`, params)
    .then(() => poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]))
    .then(([rows]) => rows[0] ? mapper(rows[0]) : undefined);
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
}

function mapAccount(row: RowDataPacket): Account {
  return {
    id: row.id,
    name: row.name,
    plan: row.plan as PlanCode,
    createdAt: ensureIso(row.created_at),
    currentPeriodStart: ensureIso(row.current_period_start),
    currentPeriodEnd: ensureIso(row.current_period_end),
    cancelAtPeriodEnd: boolFromDb(row.cancel_at_period_end),
    canceledAt: row.canceled_at ? ensureIso(row.canceled_at) : null
  };
}

function mapUser(row: RowDataPacket): User {
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash,
    createdAt: ensureIso(row.created_at)
  };
}

function mapApiKey(row: RowDataPacket): ApiKey {
  return {
    id: row.id,
    accountId: row.account_id,
    key: row.key,
    label: row.label,
    createdAt: ensureIso(row.created_at),
    disabledAt: row.disabled_at ? ensureIso(row.disabled_at) : null
  };
}

function mapEvent(row: RowDataPacket): Event {
  return {
    id: row.id,
    accountId: row.account_id,
    app: row.app || undefined,
    type: row.type,
    ts: ensureIso(row.ts),
    userId: row.user_id || undefined,
    sessionId: row.session_id || undefined,
    properties: parseJsonField(row.properties),
    payload: parseJsonField(row.payload),
    sourceIp: row.source_ip || undefined,
    userAgent: row.user_agent || undefined
  };
}

function mapReport(row: RowDataPacket): Report {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    definition: parseJsonField(row.definition) ?? {},
    createdAt: ensureIso(row.created_at)
  };
}

function mapPlanUsage(row: RowDataPacket): PlanUsage {
  return {
    id: row.id,
    accountId: row.account_id,
    periodStart: ensureIso(row.period_start),
    periodEnd: ensureIso(row.period_end),
    events: Number(row.events ?? 0),
    eventsIngested: row.events_ingested === null || row.events_ingested === undefined ? undefined : Number(row.events_ingested)
  };
}

function mapRedemption(row: RowDataPacket): Redemption {
  return {
    id: row.id,
    accountId: row.account_id,
    code: row.code,
    redeemedAt: ensureIso(row.redeemed_at)
  };
}

function mapDashboardItem(row: RowDataPacket): DashboardItem {
  return {
    id: row.id,
    accountId: row.account_id,
    reportId: row.report_id || null,
    type: row.type || undefined,
    x: Number(row.x),
    y: Number(row.y),
    w: Number(row.w),
    h: Number(row.h),
    pxX: row.px_x === null || row.px_x === undefined ? null : Number(row.px_x),
    pxY: row.px_y === null || row.px_y === undefined ? null : Number(row.px_y),
    pxW: row.px_w === null || row.px_w === undefined ? null : Number(row.px_w),
    pxH: row.px_h === null || row.px_h === undefined ? null : Number(row.px_h),
    brandingTitle: row.branding_title || null,
    brandingSubtitle: row.branding_subtitle || null,
    brandingLogo: row.branding_logo || null,
    createdAt: ensureIso(row.created_at),
    updatedAt: row.updated_at ? ensureIso(row.updated_at) : null
  };
}

function makeAccountRepo(): AccountRepository {
  const table = 'accounts';
  const poolRef = getPool();
  return {
    async all() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      return rows.map(mapAccount);
    },
    async find(id: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? mapAccount(rows[0]) : undefined;
    },
    async create(data: CreateInput<Account>) {
      const id = data.id || crypto.randomUUID();
      const planInfo = describePlan(data.plan);
      const createdAt = toDateOrNull(data.createdAt) || new Date();
      const periodStart = toDateOrNull(data.currentPeriodStart) || createdAt;
      const periodEnd = toDateOrNull(data.currentPeriodEnd) || new Date(createdAt.getTime() + 14 * 24 * 60 * 60 * 1000);
      await poolRef.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (id, name, plan, created_at, current_period_start, current_period_end, cancel_at_period_end, canceled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, data.name, planInfo.code, createdAt, periodStart, periodEnd, data.cancelAtPeriodEnd ? 1 : 0, toDateOrNull(data.canceledAt ?? null)]
      );
      return (await this.find(id))!;
    },
    async update(id: string, patch: Partial<Account>) {
      return buildUpdate<Account>(table, id, patch, mapAccount);
    },
    async delete(id: string) {
      const [result] = await poolRef.query<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    },
    async count() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      return Number(rows[0]?.cnt ?? 0);
    }
  };
}

function makeUserRepo(): UserRepository {
  const table = 'users';
  const poolRef = getPool();
  return {
    async all() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      return rows.map(mapUser);
    },
    async find(id: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? mapUser(rows[0]) : undefined;
    },
    async create(data: CreateInput<User>) {
      const id = data.id || crypto.randomUUID();
      const createdAt = toDateOrNull(data.createdAt) || new Date();
      await poolRef.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (id, account_id, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, data.accountId, data.email, data.role ?? 'member', data.passwordHash, createdAt]
      );
      return (await this.find(id))!;
    },
    async update(id: string, patch: Partial<User>) {
      return buildUpdate<User>(table, id, patch, mapUser);
    },
    async delete(id: string) {
      const [result] = await poolRef.query<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    },
    async count() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      return Number(rows[0]?.cnt ?? 0);
    }
  };
}

function makeApiKeyRepo(): ApiKeyRepository {
  const table = 'api_keys';
  const poolRef = getPool();
  return {
    async all() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      return rows.map(mapApiKey);
    },
    async find(id: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? mapApiKey(rows[0]) : undefined;
    },
    async findByKey(key: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE \`key\` = ? LIMIT 1`, [key]);
      return rows[0] ? mapApiKey(rows[0]) : undefined;
    },
    async create(data: CreateInput<ApiKey>) {
      const id = data.id || crypto.randomUUID();
      const createdAt = toDateOrNull(data.createdAt) || new Date();
      await poolRef.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (id, account_id, \`key\`, label, created_at, disabled_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, data.accountId, data.key, data.label, createdAt, toDateOrNull(data.disabledAt ?? null)]
      );
      return (await this.find(id))!;
    },
    async update(id: string, patch: Partial<ApiKey>) {
      return buildUpdate<ApiKey>(table, id, patch, mapApiKey);
    },
    async delete(id: string) {
      const [result] = await poolRef.query<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    },
    async count() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      return Number(rows[0]?.cnt ?? 0);
    }
  };
}

function makeEventRepo(): EventRepository {
  const table = 'events';
  const poolRef = getPool();
  return {
    async all() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      return rows.map(mapEvent);
    },
    async find(id: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? mapEvent(rows[0]) : undefined;
    },
    async create(data: CreateInput<Event>) {
      const id = data.id || crypto.randomUUID();
      await poolRef.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (id, account_id, app, type, ts, user_id, session_id, properties, payload, source_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.accountId,
          data.app ?? null,
          data.type,
          toDateOrNull(data.ts) || new Date(),
          data.userId ?? null,
          data.sessionId ?? null,
          data.properties ? JSON.stringify(data.properties) : null,
          data.payload ? JSON.stringify(data.payload) : null,
          data.sourceIp ?? null,
          data.userAgent ?? null
        ]
      );
      return (await this.find(id))!;
    },
    async update(id: string, patch: Partial<Event>) {
      return buildUpdate<Event>(table, id, patch, mapEvent);
    },
    async delete(id: string) {
      const [result] = await poolRef.query<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    },
    async count() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      return Number(rows[0]?.cnt ?? 0);
    }
  };
}

function makeReportRepo(): ReportRepository {
  const table = 'reports';
  const poolRef = getPool();
  return {
    async all() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      return rows.map(mapReport);
    },
    async find(id: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? mapReport(rows[0]) : undefined;
    },
    async create(data: CreateInput<Report>) {
      const id = data.id || crypto.randomUUID();
      const createdAt = toDateOrNull(data.createdAt) || new Date();
      await poolRef.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (id, account_id, name, definition, created_at) VALUES (?, ?, ?, ?, ?)`,
        [id, data.accountId, data.name, JSON.stringify(data.definition ?? {}), createdAt]
      );
      return (await this.find(id))!;
    },
    async update(id: string, patch: Partial<Report>) {
      return buildUpdate<Report>(table, id, patch, mapReport);
    },
    async delete(id: string) {
      const [result] = await poolRef.query<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    },
    async count() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      return Number(rows[0]?.cnt ?? 0);
    }
  };
}

function makePlanUsageRepo(): PlanUsageRepository {
  const table = 'plan_usage';
  const poolRef = getPool();
  return {
    async all() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      return rows.map(mapPlanUsage);
    },
    async find(id: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? mapPlanUsage(rows[0]) : undefined;
    },
    async create(data: CreateInput<PlanUsage>) {
      const id = data.id || crypto.randomUUID();
      await poolRef.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (id, account_id, period_start, period_end, events, events_ingested) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.accountId,
          toDateOrNull(data.periodStart) || new Date(),
          toDateOrNull(data.periodEnd) || new Date(),
          data.events ?? 0,
          data.eventsIngested ?? data.events ?? 0
        ]
      );
      return (await this.find(id))!;
    },
    async update(id: string, patch: Partial<PlanUsage>) {
      return buildUpdate<PlanUsage>(table, id, patch, mapPlanUsage);
    },
    async delete(id: string) {
      const [result] = await poolRef.query<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    },
    async count() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      return Number(rows[0]?.cnt ?? 0);
    }
  };
}

function makeRedemptionRepo(): RedemptionRepository {
  const table = 'redemptions';
  const poolRef = getPool();
  return {
    async all() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      return rows.map(mapRedemption);
    },
    async find(id: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? mapRedemption(rows[0]) : undefined;
    },
    async create(data: CreateInput<Redemption>) {
      const id = data.id || crypto.randomUUID();
      await poolRef.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (id, account_id, code, redeemed_at) VALUES (?, ?, ?, ?)`,
        [id, data.accountId, data.code, toDateOrNull(data.redeemedAt) || new Date()]
      );
      return (await this.find(id))!;
    },
    async update(id: string, patch: Partial<Redemption>) {
      return buildUpdate<Redemption>(table, id, patch, mapRedemption);
    },
    async delete(id: string) {
      const [result] = await poolRef.query<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    },
    async count() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      return Number(rows[0]?.cnt ?? 0);
    }
  };
}

function makeDashboardItemRepo(): DashboardItemRepository {
  const table = 'dashboard_items';
  const poolRef = getPool();
  return {
    async all() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      return rows.map(mapDashboardItem);
    },
    async find(id: string) {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ? mapDashboardItem(rows[0]) : undefined;
    },
    async create(data: CreateInput<DashboardItem>) {
      const id = data.id || crypto.randomUUID();
      await poolRef.query<ResultSetHeader>(
        `INSERT INTO \`${table}\` (id, account_id, report_id, type, x, y, w, h, px_x, px_y, px_w, px_h, branding_title, branding_subtitle, branding_logo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [
          id,
          data.accountId,
          data.reportId ?? null,
          data.type ?? 'report',
          data.x,
          data.y,
          data.w,
          data.h,
          data.pxX ?? null,
          data.pxY ?? null,
          data.pxW ?? null,
          data.pxH ?? null,
          data.brandingTitle ?? null,
          data.brandingSubtitle ?? null,
          data.brandingLogo ?? null,
          toDateOrNull(data.createdAt) || new Date(),
          data.updatedAt ? toDateOrNull(data.updatedAt) : null
        ]
      );
      return (await this.find(id))!;
    },
    async update(id: string, patch: Partial<DashboardItem>) {
      return buildUpdate<DashboardItem>(table, id, patch, mapDashboardItem);
    },
    async delete(id: string) {
      const [result] = await poolRef.query<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    },
    async count() {
      const [rows] = await poolRef.query<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      return Number(rows[0]?.cnt ?? 0);
    }
  };
}

function createRepos(): Repos {
  return {
    accountRepo: makeAccountRepo(),
    userRepo: makeUserRepo(),
    apiKeyRepo: makeApiKeyRepo(),
    eventRepo: makeEventRepo(),
    reportRepo: makeReportRepo(),
    planUsageRepo: makePlanUsageRepo(),
    redemptionRepo: makeRedemptionRepo(),
    dashboardItemRepo: makeDashboardItemRepo()
  };
}

export async function initDB(): Promise<Repos> {
  if (repos) return repos;

  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME || 'evently';
  const useSsl = String(process.env.DB_SSL || '').toLowerCase() === 'true';

  if (!user) {
    throw new Error('DB_USER environment variable is required');
  }

  if (!password) {
    throw new Error('DB_PASSWORD environment variable is required');
  }

  const poolOptions: PoolOptions = {
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
    namedPlaceholders: true
  };

  if (useSsl) {
    poolOptions.ssl = { rejectUnauthorized: false };
  }

  pool = mysql.createPool(poolOptions);
  await pool.query('SELECT 1');
  repos = createRepos();
  return repos;
}

export function getRepos(): Repos {
  if (!repos) throw new Error('Database not initialised. Call initDB() first.');
  return repos;
}

export async function closeDB(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    repos = null;
  }
}
