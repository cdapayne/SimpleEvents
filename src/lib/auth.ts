import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { getRepos, User } from './db';

export async function hashPassword(plain: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface SessionUser { userId: string; accountId: string; email: string; role: string; }

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!(req.session as any)?.user) {
    return res.redirect('/login');
  }
  next();
}

export async function loadSessionUser(req: Request, _res: Response, next: NextFunction) {
  const sessUser = (req.session as any)?.user as SessionUser | undefined;
  if (sessUser) {
    try {
      const { userRepo } = getRepos();
      const user = await userRepo.find(sessUser.userId) as User | undefined;
      if (!user) delete (req.session as any).user;
    } catch {
      // ignore
    }
  }
  next();
}