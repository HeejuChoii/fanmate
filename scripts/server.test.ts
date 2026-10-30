// 실제 서버를 띄워서 확인(Croche 연결 없이 되는 범위): 시작 시 키 검사, /health, 익명 쿠키, 사용자별 app-state,
// 사용자·전체 메시지 상한, /config. Croche에 실제로 붙는 대화는 노트북·Render에서 확인한다.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(root, 'src', 'server.ts');
const dataDir = mkdtempSync(path.join(tmpdir(), 'dukme-server-test-'));
const baseEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

// ── 시작 시 키 검사: 둘 다 없거나, 운영에서 서버 키가 없으면 분명한 에러로 종료 ──
const startOnce = (env: Record<string, string>) =>
  spawnSync(process.execPath, ['--import', 'tsx', serverEntry], { env: { ...baseEnv, DATA_DIR: dataDir, PORT: '1', ...env }, encoding: 'utf8', timeout: 20000 });
let r = startOnce({});
assert.equal(r.status, 2);
assert.match(r.stderr, /CROCHE_PROJECT_KEY/);
assert.match(r.stderr, /CROCHE_SERVER_KEY.*CROCHE_DEBUG_KEY/);
r = startOnce({ NODE_ENV: 'production', CROCHE_PROJECT_KEY: 'pk_test', CROCHE_DEBUG_KEY: 'cdt_test', SESSION_SECRET: 's'.repeat(40) });
assert.equal(r.status, 2);
assert.match(r.stderr, /운영\(NODE_ENV=production\)에서는 CROCHE_SERVER_KEY가 필요/);
r = startOnce({ NODE_ENV: 'production', CROCHE_PROJECT_KEY: 'pk_test', CROCHE_SERVER_KEY: 'csk_test' });
assert.equal(r.status, 2);
assert.match(r.stderr, /SESSION_SECRET/);

// ── 서버 띄우기 (디버그 키, 메시지 상한 0 → Croche에 닿기 전에 거절되는지 본다) ──
const port = 40000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
  env: {
    ...baseEnv, DATA_DIR: dataDir, PORT: String(port), CROCHE_PROJECT_KEY: 'pk_test', CROCHE_DEBUG_KEY: 'cdt_test',
    SESSION_SECRET: 'x'.repeat(40), BOOTH_IDLE_RESET: '180', USER_MESSAGE_LIMIT: '0', TRUST_PROXY: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 아직 안 뜸 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200, output);
  assert.equal((await health.json()).ok, true);
  assert.match(output, /디버그 키\(로컬 개발\)/);

  // 첫 화면에서 익명 사용자 쿠키 발급
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const setCookie = home.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^dukme_uid=[0-9a-f-]{36}\.[\w-]+;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /Secure/);
  const cookieA = setCookie.split(';')[0]!;
  const userA = cookieA.split('=')[1]!.split('.')[0]!;
  // HTTPS 프록시 뒤(Render)면 Secure
  const viaHttps = await fetch(`${base}/`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(viaHttps.headers.get('set-cookie') ?? '', /Secure/);

  // 같은 쿠키면 새로 발급하지 않음 / 위조 쿠키면 새 사용자
  assert.equal((await fetch(`${base}/state`, { headers: { cookie: cookieA } })).headers.get('set-cookie'), null);
  const forged = await fetch(`${base}/state`, { headers: { cookie: `dukme_uid=${userA}.forged` } });
  const forgedCookie = forged.headers.get('set-cookie') ?? '';
  assert.ok(forgedCookie && !forgedCookie.includes(userA), '위조 서명은 새 id로');
  const cookieB = forgedCookie.split(';')[0]!;

  // 사용자별 app-state: A의 클릭은 B에게 안 보인다
  await fetch(`${base}/purchase-click`, { method: 'POST', headers: { cookie: cookieA } });
  await fetch(`${base}/purchase-click`, { method: 'POST', headers: { cookie: cookieA } });
  const stateA = await (await fetch(`${base}/state`, { headers: { cookie: cookieA } })).json();
  const stateB = await (await fetch(`${base}/state`, { headers: { cookie: cookieB } })).json();
  assert.equal(stateA.purchaseClicks, 2);
  assert.equal(stateB.purchaseClicks, 0);
  assert.deepEqual(stateA.memory, []);
  assert.ok(existsSync(path.join(dataDir, 'users', userA, 'app-state.json')), 'DATA_DIR/users/<uuid>/app-state.json');
  assert.equal(existsSync(path.join(dataDir, 'users', userA, 'croche')), false, '대화하기 전에는 Croche 저장소를 만들지 않음');

  // 사용자 메시지 상한(0) → Croche에 닿기 전에 친절한 거절 코드
  const limited = await fetch(`${base}/send`, { method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' }, body: JSON.stringify({ text: '안녕' }) });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'user_limit' });
  assert.equal(existsSync(path.join(dataDir, 'users', userA, 'croche')), false);

  // 처음부터(기억 초기화): 그 사용자 것만 비운다 (Croche 저장소가 없으면 열지 않음)
  const reset = await fetch(`${base}/reset`, { method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'all' }) });
  assert.equal(reset.status, 200);
  assert.equal((await (await fetch(`${base}/state`, { headers: { cookie: cookieA } })).json()).purchaseClicks, 0);

  // 화면 설정 (키는 절대 없음)
  const config = await (await fetch(`${base}/config`)).json();
  assert.deepEqual(config, { boothIdleResetSeconds: 180, userMessageLimit: 0 });
  assert.equal((await fetch(`${base}/markers.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');

  // 잘못된 요청
  assert.equal((await fetch(`${base}/send`, { method: 'POST', headers: { cookie: cookieA }, body: '{nope' })).status, 400);
  assert.equal((await fetch(`${base}/health`)).status, 200, '그래도 서버는 살아 있음');
  console.log('PASS: 서버 — 키 검사, /health, 서명된 익명 쿠키(HttpOnly·SameSite=Lax·HTTPS면 Secure), 사용자별 app-state, 상한, /config');
} finally {
  child.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}
