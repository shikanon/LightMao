import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Store } from '../../packages/shared/store.ts';
import type { User, DeviceAuthorization, LoginSession } from '../../packages/shared/types.ts';

export type StoredUser = User & { passwordHash: string; salt: string };
type StoredToken = {
  id: string;
  userId: string;
  expires: number;
  kind?: 'access' | 'device';
  sessionId?: string;
  deviceGrantId?: string;
  revokedAt?: string;
};
type StoredSession = {
  id: string;
  userId: string;
  refreshHash: string;
  previousRefreshHash?: string;
  createdAt: string;
  lastUsedAt: string;
  label: string;
  expires: number;
  rotatedAt: number;
  revokedAt?: string;
};
type RefreshIndex = { id: string; sessionId: string; usedAt?: number };
type StoredDevice = DeviceAuthorization & {
  userId: string;
  tokenHash: string;
  expires: number;
  issuerSessionId?: string;
  issuerTokenId?: string;
};
export interface AuthOptions {
  accessTtlMs?: number;
  sessionTtlMs?: number;
  deviceTtlMs?: number;
  refreshGraceMs?: number;
  now?: () => number;
}
export type Principal = { user: User; token: StoredToken };
export const safeUser = ({ passwordHash: _, salt: __, ...user }: StoredUser): User => user;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = promisify(scrypt);
const fail = (statusCode: number, message: string, code: string): never => {
  throw Object.assign(new Error(message), { statusCode, code });
};
export const REFRESH_COOKIE = 'lightmao_refresh';
export const refreshCookie = (token: string, seconds: number, secure: boolean) =>
  `${REFRESH_COOKIE}=${token}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(seconds))}${secure ? '; Secure' : ''}`;
export function readRefreshCookie(header?: string) {
  return (
    header
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${REFRESH_COOKIE}=`))
      ?.slice(REFRESH_COOKIE.length + 1) || ''
  );
}

export class AuthService {
  readonly accessTtlMs: number;
  readonly sessionTtlMs: number;
  readonly deviceTtlMs: number;
  private clock: () => number;
  private graceMs: number;
  constructor(
    readonly store: Store,
    options: AuthOptions = {},
  ) {
    this.accessTtlMs = options.accessTtlMs ?? 15 * 60000;
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 86400000;
    this.deviceTtlMs = options.deviceTtlMs ?? 90 * 86400000;
    this.graceMs = options.refreshGraceMs ?? 5000;
    this.clock = options.now || Date.now;
  }
  private iso() {
    return new Date(this.clock()).toISOString();
  }
  private user(id: string) {
    const user = this.store.get<StoredUser>('user', id);
    if (!user || user.status !== 'active') return fail(403, '账号已停用', 'ACCOUNT_DISABLED');
    return user;
  }
  async createUser(name: string, email: string, password: string, role: User['role']) {
    const salt = randomBytes(16).toString('hex'),
      hash = (await derive(password, salt, 64)) as Buffer;
    if (this.store.list<StoredUser>('user').some((u) => u.email === email))
      return fail(409, '该邮箱已注册', 'EMAIL_EXISTS');
    return this.store.put<StoredUser>('user', 'system', {
      id: randomUUID(),
      name,
      email,
      role,
      status: 'active',
      createdAt: this.iso(),
      salt,
      passwordHash: hash.toString('hex'),
    });
  }
  async verifyPassword(email: string, password: string) {
    const user = this.store.list<StoredUser>('user').find((u) => u.email === email.toLowerCase());
    const computed = (await derive(password, user?.salt || 'absent-account-salt', 64)) as Buffer;
    if (!user || !timingSafeEqual(computed, Buffer.from(user.passwordHash, 'hex')))
      return fail(401, '邮箱或密码不正确', 'INVALID_CREDENTIALS');
    this.user(user.id);
    return user;
  }
  private access(user: User, sessionId: string) {
    const token = randomBytes(32).toString('base64url'),
      expires = this.clock() + this.accessTtlMs;
    this.store.put<StoredToken>('token', 'system', {
      id: digest(token),
      userId: user.id,
      kind: 'access',
      sessionId,
      expires,
    });
    return {
      token,
      expiresAt: new Date(expires).toISOString(),
      user: safeUser(this.user(user.id)),
    };
  }
  login(user: User, label: string) {
    const refreshToken = randomBytes(32).toString('base64url'),
      id = randomUUID(),
      expires = this.clock() + this.sessionTtlMs;
    const session: StoredSession = {
      id,
      userId: user.id,
      refreshHash: digest(refreshToken),
      label: label.slice(0, 120),
      createdAt: this.iso(),
      lastUsedAt: this.iso(),
      expires,
      rotatedAt: this.clock(),
    };
    this.store.db.exec('BEGIN');
    try {
      this.store.put('auth-session', user.id, session);
      this.store.put<RefreshIndex>('auth-refresh', 'system', {
        id: session.refreshHash,
        sessionId: id,
      });
      const response = this.access(user, id);
      this.store.db.exec('COMMIT');
      return { ...response, refreshToken, cookieMaxAge: this.sessionTtlMs / 1000 };
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  refresh(token: string) {
    const index = this.store.get<RefreshIndex>('auth-refresh', digest(token));
    const session = index && this.store.get<StoredSession>('auth-session', index.sessionId);
    if (!index || !session || session.revokedAt || session.expires <= this.clock())
      return fail(401, '登录已过期，请重新登录', 'AUTH_EXPIRED');
    const user = this.user(session.userId);
    if (index.usedAt !== undefined) {
      // Concurrent tabs may finish the same refresh together. Only the immediately
      // previous rotation has a brief grace window; older/replayed tokens revoke the family.
      if (index.id === session.previousRefreshHash && this.clock() - index.usedAt < this.graceMs)
        return { ...this.access(user, session.id), refreshToken: undefined, cookieMaxAge: 0 };
      this.revokeSession(user.id, session.id);
      return fail(401, '登录凭证已失效，请重新登录', 'REFRESH_REUSED');
    }
    if (index.id !== session.refreshHash)
      return fail(401, '登录已过期，请重新登录', 'AUTH_EXPIRED');
    const refreshToken = randomBytes(32).toString('base64url'),
      at = this.clock();
    this.store.db.exec('BEGIN');
    try {
      this.store.put('auth-refresh', 'system', { ...index, usedAt: at });
      const next = {
        ...session,
        previousRefreshHash: index.id,
        refreshHash: digest(refreshToken),
        rotatedAt: at,
        lastUsedAt: this.iso(),
      };
      this.store.put('auth-session', user.id, next);
      this.store.put<RefreshIndex>('auth-refresh', 'system', {
        id: next.refreshHash,
        sessionId: session.id,
      });
      const response = this.access(user, session.id);
      this.store.db.exec('COMMIT');
      return { ...response, refreshToken, cookieMaxAge: (session.expires - at) / 1000 };
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  authenticate(authorization?: string): Principal {
    if (!authorization?.startsWith('Bearer ')) return fail(401, '请先登录', 'AUTH_REQUIRED');
    const token = this.store.get<StoredToken>('token', digest(authorization.slice(7)));
    if (!token || token.expires <= this.clock())
      return fail(401, '登录已过期，请重新登录', 'AUTH_EXPIRED');
    const user = this.user(token.userId);
    if (token.sessionId) {
      const session = this.store.get<StoredSession>('auth-session', token.sessionId, user.id);
      if (!session || session.revokedAt || session.expires <= this.clock())
        return fail(401, '登录已过期，请重新登录', 'AUTH_EXPIRED');
    }
    if (token.kind === 'device') {
      const grant = this.store.get<StoredDevice>('auth-device', token.deviceGrantId!, user.id);
      if (
        !grant ||
        grant.revokedAt ||
        grant.expires <= this.clock() ||
        grant.tokenHash !== token.id
      )
        return fail(401, '设备授权已失效，请重新授权', 'DEVICE_AUTH_REQUIRED');
      // Limit write amplification while retaining meaningful last-seen evidence.
      if (this.clock() - Date.parse(grant.lastUsedAt) > 60000)
        this.store.put('auth-device', user.id, { ...grant, lastUsedAt: this.iso() });
    }
    if (token.revokedAt) return fail(401, '登录凭证已撤销，请重新登录', 'AUTH_EXPIRED');
    return { user: safeUser(user), token };
  }
  authorize(principal: Principal, path: string, method: string) {
    if (principal.token.kind !== 'device') return;
    const allowed =
      (method === 'GET' &&
        (['/api/me', '/api/bootstrap'].includes(path) ||
          /^\/api\/skills\/[^/]+$/.test(path) ||
          /^\/api\/assets\/[^/]+\/(preview|download|content)$/.test(path) ||
          path === '/api/generations' ||
          path === '/api/perception' ||
          /^\/api\/perception\/[^/]+$/.test(path) ||
          /^\/api\/generations\/[^/]+$/.test(path))) ||
      (method === 'POST' &&
        [
          '/api/v1/chat/completions',
          '/api/v1/systemone',
          '/api/generations',
          '/api/perception',
          ...(/^\/api\/perception\/[^/]+\/revalidate$/.test(path) ? [path] : []),
        ].includes(path));
    if (!allowed) return fail(403, '设备凭证不能执行此账号管理操作', 'DEVICE_SCOPE_DENIED');
  }
  logout(principal: Principal) {
    if (principal.token.sessionId) this.revokeSession(principal.user.id, principal.token.sessionId);
    this.store.remove('token', principal.token.id, 'system');
  }
  sessions(userId: string, currentId?: string): LoginSession[] {
    return this.store
      .list<StoredSession>('auth-session', userId)
      .filter((s) => !s.revokedAt && s.expires > this.clock())
      .map((s) => ({
        id: s.id,
        label: s.label,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: new Date(s.expires).toISOString(),
        current: s.id === currentId,
      }));
  }
  revokeSession(userId: string, id: string) {
    const session = this.store.get<StoredSession>('auth-session', id, userId);
    if (!session) return fail(404, '登录会话不存在', 'NOT_FOUND');
    this.store.put('auth-session', userId, { ...session, revokedAt: this.iso() });
    for (const token of this.store.list<StoredToken>('token'))
      if (token.sessionId === id)
        this.store.put('token', 'system', { ...token, revokedAt: this.iso() });
  }
  device(principal: Principal, deviceId: string, label: string) {
    const userId = principal.user.id;
    const existing = this.store
      .list<StoredDevice>('auth-device', userId)
      .find((d) => d.deviceId === deviceId);
    if (!existing && this.devices(userId).filter((d) => !d.revokedAt).length >= 20)
      return fail(429, '设备数量已达上限，请先撤销旧设备', 'DEVICE_LIMIT');
    if (existing) this.store.remove('token', existing.tokenHash, 'system');
    const token = randomBytes(32).toString('base64url'),
      expires = this.clock() + this.deviceTtlMs;
    const grant: StoredDevice = {
      id: existing?.id || randomUUID(),
      userId,
      deviceId,
      label,
      createdAt: existing?.createdAt || this.iso(),
      lastUsedAt: this.iso(),
      expiresAt: new Date(expires).toISOString(),
      expires,
      tokenHash: digest(token),
      issuerSessionId: principal.token.sessionId,
      issuerTokenId: principal.token.id,
    };
    this.store.db.exec('BEGIN');
    try {
      this.store.put('auth-device', userId, grant);
      this.store.put<StoredToken>('token', 'system', {
        id: grant.tokenHash,
        userId,
        kind: 'device',
        deviceGrantId: grant.id,
        expires,
      });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    return { token, grant: this.safeDevice(grant) };
  }
  private safeDevice({
    tokenHash: _,
    userId: __,
    expires: ___,
    issuerSessionId: ____,
    issuerTokenId: _____,
    ...grant
  }: StoredDevice): DeviceAuthorization {
    return grant;
  }
  devices(userId: string) {
    return this.store.list<StoredDevice>('auth-device', userId).map((d) => this.safeDevice(d));
  }
  revokeDevice(userId: string, id: string) {
    const grant = this.store.get<StoredDevice>('auth-device', id, userId);
    if (!grant) return fail(404, '设备不存在', 'NOT_FOUND');
    this.store.put('auth-device', userId, { ...grant, revokedAt: this.iso() });
    const token = this.store.get<StoredToken>('token', grant.tokenHash);
    if (token) this.store.put('token', 'system', { ...token, revokedAt: this.iso() });
    if (grant.issuerSessionId && this.store.get('auth-session', grant.issuerSessionId, userId))
      this.revokeSession(userId, grant.issuerSessionId);
    if (grant.issuerTokenId) {
      const issuer = this.store.get<StoredToken>('token', grant.issuerTokenId);
      if (issuer) this.store.put('token', 'system', { ...issuer, revokedAt: this.iso() });
    }
  }
  revokeUser(userId: string) {
    for (const session of this.sessions(userId)) this.revokeSession(userId, session.id);
    for (const device of this.devices(userId))
      if (!device.revokedAt) this.revokeDevice(userId, device.id);
    for (const token of this.store.list<StoredToken>('token'))
      if (token.userId === userId)
        this.store.put('token', 'system', { ...token, revokedAt: this.iso() });
  }
  prune() {
    for (const token of this.store.list<StoredToken>('token'))
      if (token.expires <= this.clock()) this.store.remove('token', token.id, 'system');
    const expired = new Set(
      this.store
        .list<StoredSession>('auth-session')
        .filter((s) => s.expires <= this.clock())
        .map((s) => s.id),
    );
    for (const index of this.store.list<RefreshIndex>('auth-refresh'))
      if (expired.has(index.sessionId)) this.store.remove('auth-refresh', index.id, 'system');
    for (const session of this.store.list<StoredSession>('auth-session'))
      if (expired.has(session.id)) this.store.remove('auth-session', session.id, session.userId);
  }
  async changePassword(userId: string, currentPassword: string, password: string) {
    const user = this.user(userId);
    await this.verifyPassword(user.email, currentPassword);
    const salt = randomBytes(16).toString('hex'),
      hash = (await derive(password, salt, 64)) as Buffer;
    const latest = this.user(userId);
    if (latest.passwordHash !== user.passwordHash)
      return fail(409, '密码刚刚变更，请重新登录', 'PASSWORD_CHANGED');
    this.store.put('user', 'system', { ...latest, salt, passwordHash: hash.toString('hex') });
    this.revokeUser(userId);
    return safeUser(this.user(userId));
  }
}
