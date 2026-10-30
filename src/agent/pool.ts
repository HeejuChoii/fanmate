// 사용자별 에이전트 인스턴스 관리 (부스 모드: 방문자마다 대화·기억 분리).
// - 사용자 하나에 인스턴스 하나: 같은 사용자는 재사용하고, 동시에 열리면 한 번만 연다.
// - 경로(저장 폴더) 하나에 소유자 하나: 한 프로세스가 한 사용자 폴더를 한 인스턴스로만 연다.
// - 한 사용자에 대한 쓰기는 직렬화한다(withUser).
// - 일정 시간 안 쓴 인스턴스는 close()로 정리한다(저장 폴더는 지우지 않는다). 동시 인스턴스 상한이 있다.
// Croche 자체는 모른다 — 실제 여는 방법(opener)은 croche.ts가 넘겨준다(테스트는 가짜 opener).

export type AgentEvent = { type: string; [key: string]: unknown };

/** 사용자 한 명의 열린 에이전트. Croche 호출은 이 인터페이스 뒤(croche.ts)에만 있다. */
export interface AgentHandle {
  send(input: { id: string; text: string; context: unknown }): Promise<unknown>;
  clearHistory(): Promise<void>;
  memoryList(): Array<{ id: string; text: string }>;
  /** deferred: 턴이 도는 중이라 지금이 아니라 그 턴이 끝난 뒤에 지워진다. */
  memoryClear(): Promise<{ deferred: boolean }>;
  memoryDelete(id: string): Promise<unknown>;
  close(): Promise<void>;
}

export type AgentOpener = (userId: string, onEvent: (event: AgentEvent) => void) => Promise<AgentHandle>;

export class PoolFullError extends Error {
  constructor() {
    super("동시 사용자 수 상한에 닿았어요.");
    this.name = "PoolFullError";
  }
}

export interface Session {
  readonly userId: string;
  readonly handle: AgentHandle;
  status: "idle" | "running" | "waiting";
  lastUsed: number;
  /** "기억 초기화"가 턴 도중이라 메모리 삭제가 미뤄졌을 때: 그 턴이 끝나면 app-state를 한 번 더 비운다. */
  resetStateWhenIdle: boolean;
}

export interface PoolOptions {
  open: AgentOpener;
  maxSessions: number;
  idleMs: number;
  /** 사용자 에이전트의 스트림 이벤트. 서버가 그 사용자의 화면에만 보낸다. */
  onEvent: (userId: string, event: AgentEvent) => void;
  /** resetStateWhenIdle이 걸린 사용자의 턴이 끝났을 때. */
  onIdleAfterReset?: (userId: string) => void;
  now?: () => number;
}

export class AgentPool {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<Session>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly options: PoolOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** 열려 있으면 그 세션(열지 않는다). */
  peek(userId: string): Session | undefined {
    return this.sessions.get(userId);
  }

  /** 사용자 세션: 열려 있으면 재사용, 아니면 연다. 꽉 찼으면 가장 오래 안 쓴 쉬는 세션을 닫고, 그것도 없으면 PoolFullError. */
  async get(userId: string): Promise<Session> {
    const existing = this.sessions.get(userId);
    if (existing) {
      existing.lastUsed = this.now();
      return existing;
    }
    const pending = this.opening.get(userId);
    if (pending) return pending;
    const opening = this.openSession(userId);
    this.opening.set(userId, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(userId);
    }
  }

  private async openSession(userId: string): Promise<Session> {
    // 이 시점엔 자기 자신은 아직 opening에 없다(get이 이 함수의 첫 await 뒤에 등록한다) — 다른 사용자들만 센다.
    if (this.sessions.size + this.opening.size >= this.options.maxSessions) {
      if (!(await this.evictOne())) throw new PoolFullError();
    }
    let session: Session | undefined;
    const handle = await this.options.open(userId, (event) => {
      if (session) this.observe(session, event);
      this.options.onEvent(userId, event);
    });
    session = { userId, handle, status: "idle", lastUsed: this.now(), resetStateWhenIdle: false };
    this.sessions.set(userId, session);
    return session;
  }

  private observe(session: Session, event: AgentEvent): void {
    session.lastUsed = this.now();
    if (event.type !== "state") return;
    const status = event.status;
    if (status === "idle" || status === "running" || status === "waiting") session.status = status;
    if (status === "idle" && session.resetStateWhenIdle) {
      session.resetStateWhenIdle = false;
      this.options.onIdleAfterReset?.(session.userId);
    }
  }

  private async evictOne(): Promise<boolean> {
    const idle = [...this.sessions.values()].filter((s) => s.status === "idle").sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = idle[0];
    if (!victim) return false;
    await this.close(victim.userId);
    return true;
  }

  /** 한 사용자에 대한 작업을 순서대로 하나씩 (같은 사용자의 동시 쓰기 금지). */
  withUser<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.locks.set(userId, next);
    void next.finally(() => {
      if (this.locks.get(userId) === next) this.locks.delete(userId);
    }).catch(() => {});
    return next;
  }

  async close(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;
    this.sessions.delete(userId);
    try {
      await session.handle.close();
    } catch (error) {
      console.error(`세션 닫기 실패 (${userId}):`, error);
    }
  }

  /** idleMs 동안 안 쓴, 쉬고 있는 세션을 닫는다. 닫은 수. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.options.idleMs;
    const stale = [...this.sessions.values()].filter((s) => s.status === "idle" && s.lastUsed < cutoff && !this.locks.has(s.userId));
    for (const s of stale) await this.close(s.userId);
    return stale.length;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
