// Croche SDK를 직접 부르는 곳은 이 파일뿐이다(CLAUDE.md 원칙 6). 11월 SDK 마이그레이션 때 여기만 고치면 된다.
//
// Croche.open(프로젝트 API)을 쓴다. SDK 0.5.4 README 기준 CrocheRuntime.create는 "프로젝트 없이 에이전트 하나를
// 여는 같은 Core"이고, 그 호스트 옵션(storage·user·serverKey…)은 Croche.open의 옵션과 같다(OpenOptions가
// HostOptions에서 serverKey/debugKey를 그대로 가져온다). 우리는 config(Tool·handlers·markerGuide·memory policy·
// defaultLanguage)가 필요해서 프로젝트 API를 유지한다. agentId는 쓰지 않는다: croche.agent()는 메인 에이전트
// ("default")를 열고, Studio 예시의 'companion'은 그 예제의 이름일 뿐이다. 기존 저장소를 다른 agentId로 열면
// identity_conflict가 난다.
//
// 서버 키 운영 규칙(Studio 안내): 사용자별 Runtime 하나, 사용자별 비공개 영구 저장 경로 하나, 경로마다 소유자 하나.
// user는 서버가 발급·서명한 익명 UUID(identity.ts), 저장 경로는 paths.ts가 정한다.
import { Croche } from "@h1r-ai/croche";
import { FileStorage } from "@h1r-ai/croche/node";
import type { CrocheKeys } from "../config.js";
import { crocheStorageDir } from "../paths.js";
import { toolDeclarations, toolHandlers } from "../tools/index.js";
import { INSTRUCTIONS, MARKER_GUIDE, MEMORY_POLICY } from "./prompt.js";
import { limitToolCallsPerTurn } from "./toolGuard.js";
import type { AgentEvent, AgentOpener } from "./pool.js";

export function crocheOpener(keys: CrocheKeys, options: { toolCallsPerTurn: number }): AgentOpener {
  const handlers = limitToolCallsPerTurn(toolHandlers, options.toolCallsPerTurn);
  return async (userId, onEvent) => {
    const croche = await Croche.open({
      projectKey: keys.projectKey,
      // 운영은 서버 키(csk_…), 로컬 개발은 디버그 키(cdt_…). 둘 다 서버에만 있고 브라우저로 가지 않는다.
      ...(keys.serverKey ? { serverKey: keys.serverKey } : { debugKey: keys.debugKey }),
      user: userId,
      storage: new FileStorage(crocheStorageDir(userId)),
      config: {
        model: "deepseek/deepseek-v4.1-flash",
        defaultLanguage: "en", // FanMate(Qloo 대회판): 해외 팬 대상이라 영어가 기본
        instructions: INSTRUCTIONS,
        markerGuide: MARKER_GUIDE,
        tools: toolDeclarations,
        // 한 메시지에 여러 요청이 들어와 searchItem→findAlternative→addWishlist→planRoute까지
        // 한 턴에서 전부 호출해야 하는 경우가 있어, 기본값보다 넉넉하게 잡아둔다.
        maxIterations: 12,
        memory: { policy: MEMORY_POLICY },
      },
      handlers,
    });
    try {
      const agent = await croche.agent();
      const subscription = agent.subscribe({ onEvent: (event) => onEvent(event as AgentEvent) });
      return {
        send: (input) => agent.send(input as Parameters<typeof agent.send>[0]),
        clearHistory: () => agent.clearHistory(),
        memoryList: () => agent.memory.list().map((m) => ({ id: m.id, text: m.text })),
        memoryClear: async () => ({ deferred: "deferred" in (await agent.memory.clear()) }),
        memoryDelete: (id) => agent.memory.delete(id),
        close: async () => {
          subscription.close();
          await croche.close();
        },
      };
    } catch (error) {
      await croche.close().catch(() => {});
      throw error;
    }
  };
}
