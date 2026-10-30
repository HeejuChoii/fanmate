// 브라우저마다 익명 사용자 id. 서버가 랜덤 UUID를 만들어 httpOnly 쿠키로 준다.
// - 쿠키 값 = "<uuid>.<서명>" (HMAC-SHA256, SESSION_SECRET). SDK README: 사용자 id는 클라이언트가 위조할 수
//   없게(세션 쿠키 서명) 하고, 새 익명 사용자는 IP별로 제한한다 — 새 사용자마다 Croche 기본 사용량이 생기기 때문.
// - UUID 형식과 서명이 둘 다 맞을 때만 그 id를 쓴다(경로에도 이 id만 쓴다). 틀리면 새로 발급.
// - SameSite=Lax, HttpOnly. Secure는 HTTPS로 들어온 요청(Render)에만 붙인다 — 부스 노트북의
//   http://192.168.x.x 처럼 HTTP로 열면 브라우저가 Secure 쿠키를 저장하지 않아 매번 새 사용자가 되기 때문.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const COOKIE_NAME = "dukme_uid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const isUuid = (value: string) => UUID.test(value);

export interface IdentityOptions {
  secret: Buffer;
  trustProxy: boolean;
  newUsersPerIpPerHour: number;
  now?: () => number;
}

export type IdentityResult =
  | { ok: true; userId: string; isNew: boolean; setCookie?: string }
  | { ok: false; reason: "new_user_limit" };

export class Identity {
  private readonly newUsers = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: IdentityOptions) {
    this.now = options.now ?? Date.now;
  }

  sign(userId: string): string {
    return `${userId}.${createHmac("sha256", this.options.secret).update(userId).digest("base64url")}`;
  }

  /** 서명된 쿠키 값 → UUID. 형식이나 서명이 틀리면 null. */
  verify(value: string | undefined): string | null {
    if (!value) return null;
    const dot = value.indexOf(".");
    if (dot < 0) return null;
    const userId = value.slice(0, dot);
    if (!isUuid(userId)) return null;
    const expected = Buffer.from(this.sign(userId));
    const actual = Buffer.from(value);
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? userId : null;
  }

  clientIp(req: IncomingMessage): string {
    if (this.options.trustProxy) {
      const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  /** 요청의 사용자. 쿠키가 없거나 틀리면 새 UUID를 발급한다(IP별 시간당 상한 안에서). */
  resolve(req: IncomingMessage): IdentityResult {
    const existing = this.verify(readCookie(req.headers.cookie, COOKIE_NAME));
    if (existing) return { ok: true, userId: existing, isNew: false };

    const ip = this.clientIp(req);
    const hourAgo = this.now() - 60 * 60 * 1000;
    const recent = (this.newUsers.get(ip) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= this.options.newUsersPerIpPerHour) {
      this.newUsers.set(ip, recent);
      return { ok: false, reason: "new_user_limit" };
    }
    recent.push(this.now());
    this.newUsers.set(ip, recent);
    if (this.newUsers.size > 5000) for (const [key, times] of this.newUsers) if (!times.some((t) => t > hourAgo)) this.newUsers.delete(key);

    const userId = randomUUID();
    return { ok: true, userId, isNew: true, setCookie: this.cookie(userId, isHttps(req, this.options.trustProxy)) };
  }

  cookie(userId: string, secure: boolean): string {
    return [
      `${COOKIE_NAME}=${this.sign(userId)}`,
      "Path=/",
      `Max-Age=${MAX_AGE_SECONDS}`,
      "HttpOnly",
      "SameSite=Lax",
      ...(secure ? ["Secure"] : []),
    ].join("; ");
  }
}

export function isHttps(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https";
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
