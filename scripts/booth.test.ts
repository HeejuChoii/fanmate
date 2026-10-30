import assert from 'node:assert/strict';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { AgentPool, PoolFullError, type AgentEvent, type AgentHandle } from '../src/agent/pool.js';
import { limitToolCallsPerTurn } from '../src/agent/toolGuard.js';
import { Identity, COOKIE_NAME, isUuid, readCookie } from '../src/identity.js';
import { HourlyLimit } from '../src/limits.js';
import { userDataDir, crocheStorageDir, appStateFile } from '../src/paths.js';
import { DATA_DIR } from '../src/config.js';

// ── 사용자별 인스턴스 풀 (가짜 opener: Croche 없이) ─────────────────────────
let clock = 1_000_000;
const opened: string[] = [];
const closed: string[] = [];
const emitters = new Map<string, (e: AgentEvent) => void>();
const delivered: Array<[string, string]> = [];
const idleResets: string[] = [];
let openDelay = 0;
function fakeHandle(userId: string): AgentHandle {
  return {
    send: async () => ({ ok: true }),
    clearHistory: async () => {},
    memoryList: () => [{ id: 'm1', text: `${userId}의 기억` }],
    memoryClear: async () => ({ deferred: false }),
    memoryDelete: async () => ({ deleted: true }),
    close: async () => { closed.push(userId); },
  };
}
const pool = new AgentPool({
  open: async (userId, onEvent) => {
    opened.push(userId);
    emitters.set(userId, onEvent);
    if (openDelay) await new Promise((r) => setTimeout(r, openDelay));
    return fakeHandle(userId);
  },
  maxSessions: 2,
  idleMs: 20 * 60 * 1000,
  onEvent: (userId, event) => delivered.push([userId, event.type]),
  onIdleAfterReset: (userId) => idleResets.push(userId),
  now: () => clock,
});

// 같은 사용자는 재사용, 동시에 열려도 한 번만 연다
openDelay = 20;
const [a1, a2] = await Promise.all([pool.get('alice'), pool.get('alice')]);
openDelay = 0;
assert.equal(a1, a2);
assert.deepEqual(opened, ['alice']);
assert.equal((await pool.get('alice')).handle.memoryList()[0]!.text, 'alice의 기억');

// 이벤트는 그 사용자 것으로만 전달된다
await pool.get('bob');
emitters.get('alice')!({ type: 'message.end', text: 'hi alice' });
emitters.get('bob')!({ type: 'message.end', text: 'hi bob' });
assert.deepEqual(delivered, [['alice', 'message.end'], ['bob', 'message.end']]);

// 상한: 꽉 차면 가장 오래 안 쓴 "쉬는" 세션을 닫고 연다
clock += 1000;
await pool.get('bob'); // bob이 더 최근
emitters.get('alice')!({ type: 'state', status: 'idle' });
clock += 1000;
emitters.get('bob')!({ type: 'state', status: 'idle' });
clock += 1000;
await pool.get('carol');
assert.deepEqual(closed, ['alice'], '가장 오래 안 쓴 alice가 정리됨');
assert.equal(pool.size, 2);
// 둘 다 턴이 도는 중이면 닫지 않고 PoolFullError
emitters.get('bob')!({ type: 'state', status: 'running' });
emitters.get('carol')!({ type: 'state', status: 'running' });
await assert.rejects(pool.get('dave'), PoolFullError);
assert.equal(opened.includes('dave'), false);

// 일정 시간 안 쓴 세션 정리 (턴 도는 중이면 정리하지 않음)
emitters.get('bob')!({ type: 'state', status: 'idle' });
clock += 21 * 60 * 1000;
assert.equal(await pool.sweep(), 1, '쉬는 bob만 정리');
assert.ok(closed.includes('bob') && !closed.includes('carol'));

// 기억 초기화가 미뤄진 사용자: 그 턴이 끝나면 한 번 더 비우기
const carol = await pool.get('carol');
carol.resetStateWhenIdle = true;
emitters.get('carol')!({ type: 'state', status: 'idle' });
assert.deepEqual(idleResets, ['carol']);
assert.equal(carol.resetStateWhenIdle, false);

// 한 사용자 작업은 순서대로(동시 쓰기 금지), 다른 사용자는 서로 막지 않는다
const order: string[] = [];
const slow = (label: string, ms: number) => async () => { order.push(`${label}:start`); await new Promise((r) => setTimeout(r, ms)); order.push(`${label}:end`); };
await Promise.all([pool.withUser('x', slow('x1', 30)), pool.withUser('x', slow('x2', 1)), pool.withUser('y', slow('y1', 1))]);
assert.ok(order.indexOf('x1:end') < order.indexOf('x2:start'), `같은 사용자 직렬화: ${order}`);
assert.ok(order.indexOf('y1:end') < order.indexOf('x1:end'), '다른 사용자는 기다리지 않음');
// 앞 작업이 실패해도 다음 작업은 돈다
await assert.rejects(pool.withUser('x', async () => { throw new Error('boom'); }));
assert.equal(await pool.withUser('x', async () => 'ok'), 'ok');

await pool.closeAll();
assert.equal(pool.size, 0);

// ── Tool 호출 상한 (한 턴) ────────────────────────────────────────────────
let ran = 0;
const guarded = limitToolCallsPerTurn({ searchItem: () => { ran += 1; return { ok: true }; } }, 3);
const ctxFor = (user: string, input: string) => ({ user, causedBy: [input] }) as any;
for (let i = 0; i < 5; i++) await guarded.searchItem!({ key: 'search_item', args: {} } as any, ctxFor('u1', 'turn-1'));
assert.equal(ran, 3, '한 턴에 3번까지만 실행');
const refused = await guarded.searchItem!({ key: 'search_item', args: {} } as any, ctxFor('u1', 'turn-1')) as any;
assert.equal(refused.status, 'rejected');
await guarded.searchItem!({ key: 'search_item', args: {} } as any, ctxFor('u1', 'turn-2'));
await guarded.searchItem!({ key: 'search_item', args: {} } as any, ctxFor('u2', 'turn-1'));
assert.equal(ran, 5, '다음 턴·다른 사용자는 새로 센다');

// ── 익명 사용자 쿠키 ──────────────────────────────────────────────────────
const fakeReq = (cookie?: string, ip = '10.0.0.1', headers: Record<string, string> = {}) =>
  ({ headers: { ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: ip } }) as unknown as IncomingMessage;
const identity = new Identity({ secret: Buffer.from('x'.repeat(32)), trustProxy: true, newUsersPerIpPerHour: 2, now: () => clock });
const first = identity.resolve(fakeReq());
assert.ok(first.ok && first.isNew && isUuid(first.userId));
assert.match(first.setCookie!, /HttpOnly/);
assert.match(first.setCookie!, /SameSite=Lax/);
assert.doesNotMatch(first.setCookie!, /Secure/, 'HTTP(부스 노트북 와이파이 주소)에서는 Secure를 붙이지 않음');
const cookieValue = readCookie(first.setCookie!.split(';')[0], COOKIE_NAME)!;
// 같은 쿠키 → 같은 사용자, 새로 발급하지 않음
const again = identity.resolve(fakeReq(`${COOKIE_NAME}=${cookieValue}`));
assert.ok(again.ok && !again.isNew && again.userId === first.userId && !again.setCookie);
// HTTPS(프록시 뒤)에서는 Secure
const https = identity.resolve(fakeReq(undefined, '10.0.0.9', { 'x-forwarded-proto': 'https' }));
assert.ok(https.ok && /Secure/.test(https.setCookie!));
// 서명이 틀리거나, UUID 형식이 아니거나, 경로 조작 시도면 새로 발급
for (const bad of [
  `${first.userId}.forged`,
  `../../etc.${identity.sign('../../etc').split('.')[1]}`,
  'not-a-uuid',
  identity.sign('00000000-0000-0000-0000-000000000000'), // UUID v4 형식 아님
]) {
  const r = identity.resolve(fakeReq(`${COOKIE_NAME}=${encodeURIComponent(bad)}`, '10.0.0.2'));
  if (r.ok) assert.ok(r.isNew && r.userId !== first.userId && isUuid(r.userId), bad);
}
// IP별 새 사용자 상한 (프록시 뒤에서는 X-Forwarded-For의 첫 주소)
const viaProxy = (n: number) => identity.resolve(fakeReq(undefined, '127.0.0.1', { 'x-forwarded-for': `203.0.113.${n}, 10.0.0.1` }));
assert.ok(viaProxy(7).ok && viaProxy(7).ok);
assert.deepEqual(viaProxy(7), { ok: false, reason: 'new_user_limit' });
assert.ok(viaProxy(8).ok, '다른 IP는 따로 센다');
clock += 61 * 60 * 1000;
assert.ok(viaProxy(7).ok, '한 시간 지나면 다시');

// ── 저장 경로: 서버가 정하고, 이상한 id는 거절 ──────────────────────────
assert.equal(userDataDir(first.userId), path.join(DATA_DIR, 'users', first.userId));
assert.equal(crocheStorageDir(first.userId), path.join(DATA_DIR, 'users', first.userId, 'croche'));
assert.equal(appStateFile(first.userId), path.join(DATA_DIR, 'users', first.userId, 'app-state.json'));
for (const bad of ['../x', 'a/b', '', '.hidden', 'x'.repeat(101), 'a b']) assert.throws(() => userDataDir(bad), bad);

// ── 서버 전체 시간당 상한 ─────────────────────────────────────────────────
let t = 0;
const hourly = new HourlyLimit(2, () => t);
assert.ok(hourly.tryTake() && hourly.tryTake());
assert.equal(hourly.tryTake(), false);
t += 60 * 60 * 1000 + 1;
assert.ok(hourly.tryTake());
assert.equal(new HourlyLimit(0).tryTake(), false);

console.log('PASS: 부스 모드 — 사용자별 인스턴스(재사용·직렬화·정리·상한), Tool 호출 상한, 서명된 익명 쿠키, 저장 경로, 시간당 상한');
