import express, { Request, Response, NextFunction } from 'express';
import expressLayouts from 'express-ejs-layouts';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieSession from 'cookie-session';
import csrf from 'csurf';
import { getRepos, Account, PlanCode } from './lib/db';
import { requireAuth, hashPassword, comparePassword, loadSessionUser } from './lib/auth';
import crypto from 'crypto';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import dotenv from 'dotenv';
import { rateLimiter } from './middleware/rateLimiter';
import { planLimit } from './middleware/planLimit';
import { getPlanDefinition, getOrCreateCurrentUsage, incrementUsage, usagePercent } from './lib/plan';
import { z } from 'zod';
import { parse } from 'url';
import { aggregateEvents, toChartResponse, ReportConfig } from './lib/reporting';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import multer from 'multer';
import fs from 'fs';

dotenv.config();

const app = express();

const PLAN_TIERS: Record<PlanCode, { label: string; tier: number }> = {
  TRIAL: { label: 'Trial', tier: 0 },
  APP_SUMO_TIER1: { label: 'Tier 1', tier: 1 },
  APP_SUMO_TIER2: { label: 'Tier 2', tier: 2 },
  UNLIMITED: { label: 'Tier 3', tier: 3 }
};

const PLAN_LADDER: PlanCode[] = ['TRIAL', 'APP_SUMO_TIER1', 'APP_SUMO_TIER2', 'UNLIMITED'];

function describePlan(plan?: PlanCode) {
  const safe = plan && PLAN_TIERS[plan] ? plan : 'TRIAL';
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

// File uploads (branding logos)
const uploadDir = path.join(__dirname,'..','public','uploads');
if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  // using any types to keep lightweight (no custom ambient declarations required)
  destination: (_req: Request, _file: any, cb: (error: Error | null, destination: string) => void) => cb(null, uploadDir),
  filename: (_req: Request, file: any, cb: (error: Error | null, filename: string) => void) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'logo_'+Date.now()+ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB

// Basic configuration
const APP_NAME = process.env.APP_NAME || 'Evently Analytics';

// View engine setup
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout');

// Static assets
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// Trust proxy (if behind reverse proxy in future)
app.set('trust proxy', 1);

// Security & logging middleware with CSP nonce for inline scripts
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  (res.locals as any).cspNonce = nonce;
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // Allow self, our nonce, and jsdelivr CDN for external libs
  "script-src": ["'self'", `'nonce-${nonce}'`, 'https://cdn.jsdelivr.net'],
  // Allow inline styles via Bootstrap and Google Fonts stylesheet
  "style-src": ["'self'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', "'unsafe-inline'"],
  // Permit font files from Google Fonts
  "font-src": ["'self'", 'data:', 'https://fonts.gstatic.com'],
        "img-src": ["'self'", 'data:'],
      }
    }
  })(req, res, next);
});
app.use(cors({ origin: process.env.APP_BASE_URL || '*', credentials: true }));
app.use(morgan('dev'));

// Sessions (cookie-session is stateless)
app.use(
  cookieSession({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'dev_change_me',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 4 // 4 hours
  })
);

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// CSRF protection (after sessions & body parsers)
const csrfProtection = csrf();
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/')) return next();
  return (csrfProtection as any)(req, res, next);
});

// Expose common locals
app.use(loadSessionUser);
app.use(async (req: Request, res: Response, next: NextFunction) => {
  res.locals.appName = APP_NAME;
  if (!req.path.startsWith('/api/')) {
    if (typeof (req as any).csrfToken === 'function') {
      res.locals.csrfToken = (req as any).csrfToken();
    }
  }
  const sessionUser = (req.session as any)?.user || null;
  res.locals.sessionUser = sessionUser;
  res.locals.accountPlan = null;
  res.locals.accountTierLabel = null;
  res.locals.accountTier = null;
  res.locals.canUpgradePlan = false;
  res.locals.nextPlanCode = null;
  res.locals.nextPlanLabel = null;
  if (sessionUser) {
    try {
      const { accountRepo } = getRepos();
      const account = await accountRepo.find(sessionUser.accountId) as Account | undefined;
      if (account) {
        const planInfo = describePlan(account.plan);
        res.locals.accountPlan = getPlanDefinition(planInfo.code);
        res.locals.accountTierLabel = planInfo.tierLabel;
        res.locals.accountTier = planInfo.tier;
        res.locals.canUpgradePlan = Boolean(planInfo.nextCode);
        res.locals.nextPlanCode = planInfo.nextCode;
        res.locals.nextPlanLabel = planInfo.nextLabel;
      }
    } catch (err) {
      // swallow plan lookup errors for unauthenticated-friendly rendering
    }
  }
  next();
});

// Routes
app.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const sessionUser = (req.session as any)?.user;
  if (!sessionUser) {
    return res.render('welcome', {
      title: 'Welcome',
      bodyClass: 'welcome-body',
      mainClass: 'welcome-main p-0',
      hideNavbar: true,
      hideFooter: true
    });
  }
  try {
    const { eventRepo, accountRepo, userRepo, apiKeyRepo } = getRepos();
    const [eventsCount, accountsCount, usersCount] = await Promise.all([
      eventRepo.count(),
      accountRepo.count(),
      userRepo.count()
    ]);
    const account = await accountRepo.find(sessionUser.accountId);
    if (!account) {
      (req.session as any).user = undefined;
      return res.redirect('/');
    }
    const planDef = getPlanDefinition(account.plan);
    const usage = await getOrCreateCurrentUsage(account);
    const limit = planDef.monthlyEventLimit;
    const percent = usagePercent(limit, usage.events);
    const nearLimit = isFinite(limit) && percent >= 90;
    const apiKeyRecord = (await apiKeyRepo.all()).find(k => k.accountId === account.id && !k.disabledAt);
    const apiKey = apiKeyRecord?.key || '';
    res.render('index', { title: 'Dashboard', eventsCount, accountsCount, usersCount, plan: planDef, usage, limit, percent, nearLimit, apiKey });
  } catch (e) {
    next(e);
  }
});

// Branding configuration screen
app.get('/branding', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dashboardItemRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const all = (await dashboardItemRepo.all()).filter(i=> i.accountId===accountId && (i as any).type==='branding');
    const existing = all[0];
    res.render('branding', { title: 'Branding', branding: existing });
  } catch(e){ next(e); }
});

app.post('/branding', requireAuth, upload.single('logo'), async (req: Request & { file?: any }, res: Response, next: NextFunction) => {
  try {
    const { dashboardItemRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const title = (req.body?.title||'').toString().slice(0,120);
    const subtitle = (req.body?.subtitle||'').toString().slice(0,180);
    const addToDashboard = req.body?.addToDashboard === 'on';
    let logoPath: string | undefined;
    if(req.file){
      logoPath = '/public/uploads/' + path.basename(req.file.path);
    }
    // Try find existing
    const all = await dashboardItemRepo.all();
    let existing = all.find(i=> i.accountId===accountId && (i as any).type==='branding');
    if(existing){
      const patch: any = {};
      patch.type = 'branding';
      patch.brandingTitle = title;
      patch.brandingSubtitle = subtitle;
      if(logoPath) patch.brandingLogo = logoPath;
      await dashboardItemRepo.update(existing.id, patch);
    } else if(addToDashboard) {
      existing = await dashboardItemRepo.create({ accountId, x:0, y:0, w:4, h:4, createdAt: new Date().toISOString(), type:'branding', brandingTitle: title, brandingSubtitle: subtitle, brandingLogo: logoPath } as any);
    }
    res.redirect('/');
  } catch(e){ next(e); }
});

// Auth pages
app.get('/register', (req: Request, res: Response) => {
  if ((req.session as any)?.user) return res.redirect('/');
  res.render('register', { title: 'Register' });
});

app.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountRepo, userRepo, apiKeyRepo } = getRepos();
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).render('register', { title: 'Register', error: 'Invalid input (password >= 8 chars).' });
    }
    const existingUsers = await userRepo.all();
    if (existingUsers.find(u => u.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).render('register', { title: 'Register', error: 'Email already in use.' });
    }
    const now = new Date();
    const periodStart = now.toISOString();
    const periodEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const account = await accountRepo.create({ name: email.split('@')[0] + "'s Account", createdAt: now.toISOString(), plan: 'TRIAL', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd });
    const passwordHash = await hashPassword(password);
  const user = await userRepo.create({ accountId: account.id, email, role: 'owner', passwordHash, createdAt: new Date().toISOString() });
  // Create a default API key so the API Keys page is immediately useful
  await apiKeyRepo.create({ accountId: account.id, key: crypto.randomUUID().replace(/-/g,''), label: 'Default', createdAt: new Date().toISOString(), disabledAt: null });
  (req.session as any).user = { userId: user.id, accountId: account.id, email: user.email, role: user.role };
    res.redirect('/');
  } catch (err) { next(err); }
});

app.get('/login', (req: Request, res: Response) => {
  if ((req.session as any)?.user) return res.redirect('/');
  res.render('login', { title: 'Login' });
});

app.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userRepo } = getRepos();
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).render('login', { title: 'Login', error: 'Email and password required.' });
    const user = (await userRepo.all()).find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return res.status(401).render('login', { title: 'Login', error: 'Invalid credentials.' });
    const match = await comparePassword(password, user.passwordHash);
    if (!match) return res.status(401).render('login', { title: 'Login', error: 'Invalid credentials.' });
    (req.session as any).user = { userId: user.id, accountId: user.accountId, email: user.email, role: user.role };
    res.redirect('/');
  } catch (err) { next(err); }
});

app.post('/logout', (req: Request, res: Response) => {
  // cookie-session clears when set to null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).session = null;
  res.redirect('/login');
});

// Protected placeholder pages
const protectedPages: Array<[string, string]> = [
  // ['/events', 'Events'], // replaced with real implementation
  // '/apikeys' removed now that real API Keys implementation exists
  ['/billing', 'Billing']
];
protectedPages.forEach(([path, label]) => {
  app.get(path, requireAuth, (_req: Request, res: Response) => {
    res.render('placeholder', { title: label, heading: label });
  });
});

// Dedicated events route
app.get('/events', requireAuth, (_req: Request, res: Response) => {
  res.render('events', { title: 'Events' });
});

// API Keys UI
app.get('/apikeys', requireAuth, async (req: Request, res: Response) => {
  const { apiKeyRepo } = getRepos();
  const all = (await apiKeyRepo.all()).filter(k => k.accountId === (req.session as any).user.accountId);
  // Mask keys except last 4
  const masked = all.map(k => ({
    ...k,
    masked: k.key.slice(0,4) + '…' + k.key.slice(-4),
    active: !k.disabledAt
  }));
  res.render('apikeys', { title: 'API Keys', apiKeys: masked });
});

app.post('/apikeys', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { apiKeyRepo } = getRepos();
    const label = (req.body?.label || 'Key') as string;
    const key = crypto.randomBytes(24).toString('hex'); // 48 chars
    await apiKeyRepo.create({
      accountId: (req.session as any).user.accountId,
      key,
      label,
      createdAt: new Date().toISOString(),
      disabledAt: null
    });
    res.redirect('/apikeys');
  } catch (e) { next(e); }
});

app.post('/apikeys/:id/disable', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { apiKeyRepo } = getRepos();
    const id = req.params.id;
    const all = await apiKeyRepo.all();
    const record = all.find(k => k.id === id && k.accountId === (req.session as any).user.accountId);
    if (record && !record.disabledAt) {
      await apiKeyRepo.update(record.id, { disabledAt: new Date().toISOString() } as any);
    }
    res.redirect('/apikeys');
  } catch (e) { next(e); }
});

app.get('/docs', (req: Request, res: Response) => {
  res.render('docs', { title: 'API Docs' });
});

// API Key auth test endpoint
app.get('/api/auth-test', apiKeyAuth, (req: Request, res: Response) => {
  res.json({ accountId: req.account?.id, apiKeyId: req.apiKeyRecord?.id });
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Event ingestion endpoint
app.post('/api/v1/events/ingest', apiKeyAuth, planLimit, async (req: Request, res: Response, next: NextFunction) => {
  // Accept both 'event' (preferred) and 'type' (legacy) for event name
  const schema = z.object({
    app: z.string(),
    event: z.string().optional(),
    type: z.string().optional(),
    occurredAt: z.string().datetime().optional(),
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    payload: z.any().optional()
  });
  try {
    const parsed = schema.parse(req.body || {});
    const name = parsed.event || parsed.type; // prefer 'event'
    if (!name) return res.status(400).json({ error: 'missing_event', message: "Provide 'event' (preferred) or 'type'." });
    const { eventRepo } = getRepos();
    const account = (req as any).account;
    const nowIso = new Date().toISOString();
    const ev = await eventRepo.create({
      accountId: account.id,
      app: parsed.app,
      type: name,
      ts: parsed.occurredAt || nowIso,
      userId: parsed.userId,
      sessionId: parsed.sessionId,
      payload: parsed.payload,
      sourceIp: req.ip,
      userAgent: req.get('user-agent') || undefined
    });
    await incrementUsage(account, 1);
    res.status(201).json({ id: ev.id, status: 'ok' });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid_body', issues: e.issues });
    }
    next(e);
  }
});

// Events meta endpoint for report builder simplification
app.get('/api/v1/events/meta', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const events = (await eventRepo.all()).filter(e => e.accountId === accountId);
    const eventNames = Array.from(new Set(events.map(e => e.type).filter(Boolean))).sort();
    const apps = Array.from(new Set(events.map(e => e.app || '').filter(a => a))).sort();
    // Collect payload keys (top-level) across events (payload or properties for legacy)
    const payloadKeys = new Set<string>();
    for (const ev of events) {
      const payload = ev.payload || ev.properties;
      if (payload && typeof payload === 'object') {
        for (const k of Object.keys(payload)) payloadKeys.add(k);
      }
    }
    res.json({ events: eventNames, apps, payloadFields: Array.from(payloadKeys).sort() });
  } catch (e) { next(e); }
});

// Event ingestion endpoint (legacy)
app.post('/api/events', apiKeyAuth, rateLimiter, planLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventRepo } = getRepos();
    const account = (req as any).account;
    const { type = 'custom', properties = {} } = req.body || {};
    if (typeof type !== 'string' || !type) return res.status(400).json({ error: 'invalid_type' });
    const ev = await eventRepo.create({
      accountId: account.id,
      type,
      ts: new Date().toISOString(),
      properties: typeof properties === 'object' ? properties : {}
    });
    await incrementUsage(account, 1);
    res.status(201).json({ id: ev.id });
  } catch (e) { next(e); }
});

app.get('/api/v1/events', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventRepo } = getRepos();
  const { page = '1', limit = '50', type, app: appFilter, userId, from, to, search, all } = req.query as Record<string,string>;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit as string, 10) || 50));
    const accountId = (req.session as any).user.accountId;
    let events = (await eventRepo.all()).filter(e => e.accountId === accountId);
    if (type) events = events.filter(e => e.type === type);
    if (appFilter) events = events.filter(e => (e.app||'') === appFilter);
    if (userId) events = events.filter(e => e.userId === userId);
    if (from) events = events.filter(e => e.ts >= from);
    if (to) events = events.filter(e => e.ts <= to);
    if (search) {
      const needle = search.toLowerCase();
      events = events.filter(e => {
        try {
          const blob = JSON.stringify(e.payload || e.properties || {});
          return blob.toLowerCase().includes(needle);
        } catch { return false; }
      });
    }
    events.sort((a,b)=> a.ts < b.ts ? 1 : -1);
    const total = events.length;
    let rows;
    if (all === '1') {
      rows = events; // return everything
    } else {
      const start = (pageNum - 1) * limitNum;
      rows = events.slice(start, start + limitNum);
    }
    res.json({ rows, total, all: all === '1' });
  } catch (e) { next(e); }
});

app.get('/api/v1/events/export.csv', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventRepo } = getRepos();
    const { type, app: appFilter, userId, from, to, search } = req.query as Record<string,string>;
    const accountId = (req.session as any).user.accountId;
    let events = (await eventRepo.all()).filter(e => e.accountId === accountId);
    if (type) events = events.filter(e => e.type === type);
    if (appFilter) events = events.filter(e => (e.app||'') === appFilter);
    if (userId) events = events.filter(e => e.userId === userId);
    if (from) events = events.filter(e => e.ts >= from);
    if (to) events = events.filter(e => e.ts <= to);
    if (search) {
      const needle = search.toLowerCase();
      events = events.filter(e => {
        try { return JSON.stringify(e.payload || e.properties || {}).toLowerCase().includes(needle); } catch { return false; }
      });
    }
    events.sort((a,b)=> a.ts < b.ts ? 1 : -1);
    const header = ['id','ts','app','type','userId','sessionId','payload'];
    const lines = [header.join(',')];
    for (const ev of events) {
      const row = [ev.id, ev.ts, ev.app||'', ev.type, ev.userId||'', ev.sessionId||'', JSON.stringify(ev.payload || ev.properties || {})];
      lines.push(row.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(','));
    }
    const csv = lines.join('\n');
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="events.csv"');
    res.send(csv);
  } catch (e) { next(e); }
});

// Reports JSON list (minimal) for dashboard add modal
app.get('/api/v1/reports', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reportRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const reports = (await reportRepo.all()).filter(r => r.accountId === accountId).map(r => ({ id: r.id, name: r.name, chartType: r.definition?.chartType }));
    res.json({ reports });
  } catch (e) { next(e); }
});

// Dashboard items API
app.get('/api/v1/dashboard/items', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dashboardItemRepo, reportRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const items = (await dashboardItemRepo.all()).filter(i => i.accountId === accountId);
    const reports = await reportRepo.all();
    const enriched = items.map(i => ({ ...i, report: reports.find(r => r.id === i.reportId && r.accountId === accountId) }));
    res.json({ items: enriched });
  } catch (e) { next(e); }
});
app.patch('/api/v1/dashboard/items', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dashboardItemRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const body = req.body || {};
    if (!Array.isArray(body.items)) return res.status(400).json({ error: 'invalid_body' });
    const all = await dashboardItemRepo.all();
    for (const patch of body.items) {
      const { id, x, y, w, h, pxX, pxY, pxW, pxH } = patch || {};
      if (!id) continue;
      const existing = all.find(i => i.id === id && i.accountId === accountId);
      if (!existing) continue;
      const clean: any = {};
      if (Number.isInteger(x)) clean.x = x;
      if (Number.isInteger(y)) clean.y = y;
      if (Number.isInteger(w)) clean.w = Math.max(1, Math.min(12, w));
      if (Number.isInteger(h)) clean.h = Math.max(2, Math.min(24, h));
      // Pixel-based freeform fields (no specific limits besides sane max)
      function isNum(v:any){ return typeof v === 'number' && isFinite(v); }
      if (isNum(pxX)) clean.pxX = Math.max(0, Math.min(100000, pxX));
      if (isNum(pxY)) clean.pxY = Math.max(0, Math.min(100000, pxY));
      if (isNum(pxW)) clean.pxW = Math.max(80, Math.min(20000, pxW));
      if (isNum(pxH)) clean.pxH = Math.max(80, Math.min(20000, pxH));
      if (Object.keys(clean).length) await dashboardItemRepo.update(existing.id, clean);
    }
    res.json({ status: 'ok' });
  } catch (e) { next(e); }
});

app.post('/api/v1/dashboard/items', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dashboardItemRepo, reportRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const { reportId } = req.body || {};
    if(!reportId) return res.status(400).json({ error: 'reportId_required' });
    const report = (await reportRepo.all()).find(r => r.id === reportId && r.accountId === accountId);
    if(!report) return res.status(404).json({ error: 'not_found' });
    // Avoid duplicate dashboard items for same report
    const existing = (await dashboardItemRepo.all()).find(i => i.reportId === reportId && i.accountId === accountId);
    if(existing) return res.json({ status: 'ok', id: existing.id, existing: true });
    const items = (await dashboardItemRepo.all()).filter(i => i.accountId === accountId);
    let y = 0;
    if (items.length) {
      y = Math.max(...items.map(i => i.y + i.h));
    }
    const item = await dashboardItemRepo.create({ accountId, reportId, x: 0, y, w: 4, h: 4, createdAt: new Date().toISOString() });
    res.status(201).json({ status: 'ok', id: item.id });
  } catch (e) { next(e); }
});

app.post('/api/v1/reports/preview', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  // Validate & sanitize
  try {
    const body = req.body || {};
    const zFilters = z.array(z.object({ field: z.string(), op: z.literal('eq'), value: z.string() })).optional();
    const schema = z.object({
        dateRange: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
        filters: zFilters.default([]),
        groupBy: z.string(),
        aggregate: z.enum(['count','sum','avg']),
        valueField: z.string().optional(),
        interval: z.enum(['hour','day','week','month']),
        chartType: z.enum(['line','bar','pie','number','doughnut','radar','polarArea','area']),
        includeEvents: z.array(z.string()).optional(),
        includeApps: z.array(z.string()).optional(),
        save: z.boolean().optional(),
        name: z.string().max(120).optional(),
        addToDashboard: z.boolean().optional()
      });
    const parsed = schema.parse(body);

    function allowField(g: string): boolean {
      return g === 'type' || g === 'app' || g.startsWith('payload.');
    }
    if (!allowField(parsed.groupBy)) return res.status(400).json({ error: 'invalid_groupBy' });
    if (parsed.valueField && !parsed.valueField.startsWith('payload.')) return res.status(400).json({ error: 'invalid_valueField' });
    const safeFilters = parsed.filters.filter(f => allowField(f.field));

    const cfg: ReportConfig = {
      dateRange: parsed.dateRange,
      filters: safeFilters as any,
      groupBy: parsed.groupBy as any,
      aggregate: parsed.aggregate,
      valueField: parsed.valueField as any,
      interval: parsed.interval,
      chartType: parsed.chartType,
      includeEvents: parsed.includeEvents,
      includeApps: parsed.includeApps
    };

    const { eventRepo, reportRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
  // Scope events strictly to the authenticated user's account
  const events = (await eventRepo.all()).filter(e => e.accountId === accountId);
  const agg = aggregateEvents(events, cfg);
    let response = toChartResponse(agg, cfg);
    if (cfg.chartType === 'number') {
      // Collapse to a single aggregated value across all groups & buckets.
      // For count: sum all bucket counts. For sum/avg we already aggregated per bucket; sum their totals.
      let total = 0;
      for (const k of Object.keys((agg as any).series)) {
        const arr = (agg as any).series[k];
        total += arr.reduce((a:number,b:number)=>a+b,0);
      }
      response = { chartType: 'number', value: total } as any;
    }

    // Build raw sample events (up to 100) after aggregation for UI filter assistance
    try {
      const fromIso = cfg.dateRange.from;
      const toIso = cfg.dateRange.to;
      let filtered = events.filter(e => e.ts >= fromIso && e.ts <= toIso);
      // Apply group selection filters (includeEvents/includeApps)
      if (cfg.includeEvents && cfg.includeEvents.length) filtered = filtered.filter(e => cfg.includeEvents!.includes(e.type));
      if (cfg.includeApps && cfg.includeApps.length) filtered = filtered.filter(e => cfg.includeApps!.includes(e.app||''));
      // Apply user-chosen field filters (eq only)
      for (const f of cfg.filters||[]) {
        if (f.field === 'type') filtered = filtered.filter(e => e.type === f.value);
        else if (f.field === 'app') filtered = filtered.filter(e => (e.app||'') === f.value);
        else if (f.field.startsWith('payload.')) {
          const key = f.field.slice('payload.'.length);
            filtered = filtered.filter(e => {
              const payload = (e as any).payload || (e as any).properties;
              if(!payload || typeof payload !== 'object') return false;
              return payload[key] == f.value; // loose eq for primitives
            });
        }
      }
      // Sort newest first for sampling
      filtered.sort((a,b)=> a.ts < b.ts ? 1 : -1);
      const sample = filtered.slice(0,100).map(e => {
        const payload = (e as any).payload || (e as any).properties || {};
        const valField = cfg.valueField && cfg.valueField.startsWith('payload.') ? cfg.valueField.slice('payload.'.length) : undefined;
        const value = valField ? payload[valField] : undefined;
        return {
          id: e.id,
          ts: e.ts,
          type: e.type,
          app: e.app,
          userId: e.userId,
          sessionId: e.sessionId,
          group: cfg.groupBy === 'type' ? e.type : (cfg.groupBy === 'app' ? (e.app||'') : (cfg.groupBy.startsWith('payload.') ? (payload[cfg.groupBy.slice('payload.'.length)] ?? '') : '')),
          value,
          payloadPreview: Object.fromEntries(Object.entries(payload).slice(0,8)) // cap keys to avoid huge response
        };
      });
      (response as any).rawSamples = sample;
    } catch(_e){ /* ignore sampling errors */ }

    if (parsed.save) {
      if (!parsed.name) return res.status(400).json({ error: 'name_required' });
      const saved = await reportRepo.create({ accountId, name: parsed.name, definition: cfg as any, createdAt: new Date().toISOString() });
      if (parsed.addToDashboard) {
        const { dashboardItemRepo } = getRepos();
        // Simple placement: find max y then append, or start at (0,0)
        const items = (await dashboardItemRepo.all()).filter(i => i.accountId === accountId);
        let y = 0;
        if (items.length) {
          y = Math.max(...items.map(i => i.y + i.h));
        }
        await dashboardItemRepo.create({ accountId, reportId: saved.id, x: 0, y, w: 4, h: 4, createdAt: new Date().toISOString() });
      }
      (response as any).savedReportId = saved.id;
    }

    res.json(response);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'invalid_body', issues: e.issues });
    next(e);
  }
});

// 404 handler
app.get('/reports/new', requireAuth, (_req: Request, res: Response) => {
  res.render('report_new', { title: 'New Report' });
});
app.get('/reports', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reportRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const reports = (await reportRepo.all()).filter(r => r.accountId === accountId).sort((a,b)=> a.createdAt < b.createdAt ? 1 : -1);
    res.render('reports_index', { title: 'Reports', reports });
  } catch (e) { next(e); }
});
app.get('/reports/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reportRepo } = getRepos();
    const report = (await reportRepo.all()).find(r => r.id === req.params.id && r.accountId === (req.session as any).user.accountId);
    if (!report) return res.status(404).render('404', { title: 'Not Found' });
    res.render('report_show', { title: report.name, report });
  } catch (e) { next(e); }
});

// Lightweight report definition (for dashboard widgets)
app.get('/api/v1/reports/:id/definition', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reportRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const report = (await reportRepo.all()).find(r => r.id === req.params.id && r.accountId === accountId);
    if(!report) return res.status(404).json({ error: 'not_found' });
    res.json({ id: report.id, name: report.name, definition: report.definition });
  } catch (e) { next(e); }
});

// Run a saved report (live mode optionally adjusts date range to rolling window)
app.get('/api/v1/reports/:id/run', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reportRepo, eventRepo } = getRepos();
    const accountId = (req.session as any).user.accountId;
    const report = (await reportRepo.all()).find(r => r.id === req.params.id && r.accountId === accountId);
    if(!report) return res.status(404).json({ error: 'not_found' });
    const live = 'live' in req.query; // presence of live param enables rolling window
    const originalCfg = report.definition as any;
    const cfg = JSON.parse(JSON.stringify(originalCfg));
    if(live){
      const fromMs = new Date(cfg.dateRange.from).getTime();
      const toMs = new Date(cfg.dateRange.to).getTime();
      const span = Math.max(5*60*1000, toMs - fromMs); // at least 5m
      const now = Date.now();
      cfg.dateRange.to = new Date(now).toISOString();
      cfg.dateRange.from = new Date(now - span).toISOString();
    }
    const events = (await eventRepo.all()).filter(e => e.accountId === accountId);
    const agg = aggregateEvents(events, cfg);
    let response = toChartResponse(agg, cfg);
    if (cfg.chartType === 'number') {
      let total = 0; for (const k of Object.keys((agg as any).series)) { const arr = (agg as any).series[k]; total += arr.reduce((a:number,b:number)=>a+b,0); }
      response = { chartType: 'number', value: total } as any;
    }
    response.dateRange = cfg.dateRange;
    response.live = live;
    res.json(response);
  } catch(e){ next(e); }
});

// 404 handler (after all routes)
app.use((req: Request, res: Response) => {
  res.status(404).render('404', { title: 'Not Found' });
});

// Error handler (last)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || 500;
  const isCsrf = err.code === 'EBADCSRFTOKEN';
  if (isCsrf) {
    return res.status(403).render('error', { title: 'Security Error', message: 'Invalid CSRF token.' });
  }
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(status).json({ error: err.message || 'Server Error' });
  }
  res.status(status).render('error', { title: 'Error', message: err.message || 'Server Error' });
});

export default app;
