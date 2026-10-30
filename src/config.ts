// 환경변수는 전부 여기서 읽는다. 키는 코드·레포에 넣지 않는다(CLAUDE.md 원칙 5).
// 로컬: `.env` + `npm start` / 운영(Render): 대시보드 Environment + `npm run start:prod`.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

const int = (name: string, fallback: number, min = 0): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name}는 ${min} 이상의 숫자여야 해요 (지금: ${raw})`);
  return Math.floor(value);
};

export const isProduction = env.NODE_ENV === "production";

/** 저장 위치 하나: 사용자별 Croche 저장소와 app-state가 모두 이 아래 users/<id>/ 에 들어간다. Render 디스크는 /data. */
export const DATA_DIR = path.resolve(env.DATA_DIR?.trim() || projectRoot);
export const PROJECT_ROOT = projectRoot;

export const PORT = int("PORT", 3000, 1);
export const HOST = env.HOST?.trim() || "0.0.0.0";

/** Render 같은 프록시 뒤에서는 X-Forwarded-For의 첫 주소를 방문자 IP로 본다. */
export const TRUST_PROXY = env.TRUST_PROXY ? env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true" : isProduction;

export const LIMITS = {
  /** 사용자(브라우저)당 메시지 수. "처음부터"(기억 초기화)로 새로 시작하면 다시 센다. */
  userMessages: int("USER_MESSAGE_LIMIT", 30),
  /** 서버 전체 시간당 메시지 수 (최근 60분). */
  globalMessagesPerHour: int("GLOBAL_MESSAGES_PER_HOUR", 600),
  /** 한 턴에 실행할 Tool 호출 수. 넘으면 Tool을 실행하지 않고 거절 결과를 돌려준다. */
  toolCallsPerTurn: int("TOOL_CALLS_PER_TURN", 12, 1),
  /** 동시에 열어 두는 사용자 Croche 인스턴스 수. */
  maxSessions: int("MAX_SESSIONS", 50, 1),
  /** 이 시간(분) 동안 안 쓴 인스턴스는 close() (저장 폴더는 그대로). */
  sessionIdleMinutes: int("SESSION_IDLE_MINUTES", 20, 1),
  /** IP 하나에서 한 시간에 새로 만들 수 있는 익명 사용자 수 (쿠키를 지워 가며 사용자를 찍어내는 걸 막는다). */
  newUsersPerIpPerHour: int("NEW_USERS_PER_IP_PER_HOUR", 100, 1),
};

/** 부스 화면: 이 시간(초) 동안 입력이 없으면 자동으로 "처음부터". 0이면 끔. */
export const BOOTH_IDLE_RESET = int("BOOTH_IDLE_RESET", 0);

export interface CrocheKeys {
  projectKey: string;
  /** 운영: Studio 서버 키(csk_…). 있으면 이걸 쓴다. */
  serverKey?: string;
  /** 로컬 개발 전용: Studio 디버그 키(cdt_…). 운영(NODE_ENV=production)에서는 쓰지 않는다. */
  debugKey?: string;
}

/** 서버 시작 시 한 번 확인한다. 문제가 있으면 무엇을 넣어야 하는지 알려 주는 에러. */
export function crocheKeys(): CrocheKeys {
  const projectKey = env.CROCHE_PROJECT_KEY?.trim();
  const serverKey = env.CROCHE_SERVER_KEY?.trim();
  const debugKey = env.CROCHE_DEBUG_KEY?.trim();
  const problems: string[] = [];
  if (!projectKey) problems.push("CROCHE_PROJECT_KEY(공개 프로젝트 키)가 없어요.");
  if (!serverKey && !debugKey) {
    problems.push("CROCHE_SERVER_KEY(운영, csk_…) 또는 CROCHE_DEBUG_KEY(로컬 개발, cdt_…) 중 하나가 필요해요.");
  } else if (isProduction && !serverKey) {
    problems.push("운영(NODE_ENV=production)에서는 CROCHE_SERVER_KEY가 필요해요. 디버그 키는 로컬 개발용이에요.");
  }
  if (problems.length) {
    throw new Error(
      `덕메 서버를 시작할 수 없어요:\n- ${problems.join("\n- ")}\n` +
        "로컬: .env에 넣고 `npm start` / Render: 서비스 Environment에 넣고 다시 배포.",
    );
  }
  return serverKey ? { projectKey: projectKey!, serverKey } : { projectKey: projectKey!, debugKey: debugKey! };
}

/**
 * 익명 사용자 쿠키 서명용 비밀값. 운영에서는 필수(없으면 재배포 때마다 모든 방문자의 쿠키가 무효가 된다).
 * 로컬에서 없으면 실행할 때마다 새로 만든다.
 */
export function sessionSecret(): Buffer {
  const secret = env.SESSION_SECRET?.trim();
  if (secret) {
    if (secret.length < 32) throw new Error("SESSION_SECRET은 32자 이상이어야 해요. (예: openssl rand -hex 32)");
    return Buffer.from(secret);
  }
  if (isProduction) throw new Error("운영(NODE_ENV=production)에서는 SESSION_SECRET이 필요해요. (예: openssl rand -hex 32)");
  console.warn("SESSION_SECRET이 없어서 임시 값을 써요. 서버를 다시 켜면 브라우저 쿠키가 새로 발급돼요(로컬 개발에서만 괜찮아요).");
  return randomBytes(32);
}
