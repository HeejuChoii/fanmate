// 재배포·재시작 뒤 "store_busy" 방지.
// Croche FileStorage는 저장 폴더에 소유 기록(<hash>.lock.N)을 남긴다. Render 같은 곳에서 컨테이너가 새로 뜨면
// 호스트 이름이 바뀌어서, 이전 컨테이너가 남긴 기록을 "다른 호스트가 아직 쓰는 중"으로 보고 그 사용자를 영영 열지 못한다.
// 이 서버는 영구 디스크 하나를 인스턴스 하나만 쓰므로(render.yaml), 서버가 막 시작한 시점에 남아 있는 기록은
// 전부 죽은 프로세스의 것이다. 그래서 요청을 받기 전에 한 번 지운다.
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const LOCK_RECORD = /\.lock\.\d+$/;

export async function clearStaleCrocheLocks(): Promise<number> {
  const usersDir = path.join(DATA_DIR, "users");
  let removed = 0;
  let users: string[] = [];
  try {
    users = await readdir(usersDir);
  } catch {
    return 0; // 아직 사용자가 없음
  }
  for (const user of users) {
    const dir = path.join(usersDir, user, "croche");
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!LOCK_RECORD.test(file)) continue;
      await rm(path.join(dir, file), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}
