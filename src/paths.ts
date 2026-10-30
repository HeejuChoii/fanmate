// 사용자별 저장 경로는 서버가 정한다: DATA_DIR/users/<id>/ 아래에 app-state.json, croche/(FileStorage).
// 요청에서 온 값을 그대로 경로에 쓰지 않는다 — 여기서 허용하는 id 모양이 아니면 거절한다
// (방문자 id는 identity.ts가 UUID 형식·서명까지 확인한 것만 들어온다).
import path from "node:path";
import { DATA_DIR } from "./config.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export function userDataDir(userId: string): string {
  if (!SAFE_ID.test(userId)) throw new Error(`허용되지 않는 사용자 id 형식이에요: ${JSON.stringify(userId).slice(0, 40)}`);
  return path.join(DATA_DIR, "users", userId);
}

export const appStateFile = (userId: string) => path.join(userDataDir(userId), "app-state.json");
export const crocheStorageDir = (userId: string) => path.join(userDataDir(userId), "croche");
