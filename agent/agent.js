// 对外的入口。真正的编排在 scene.js + character.js 里，这里只做参数适配，
// 同时保留旧签名，免得调用方全部要改。
import { runScene, getRoster, resolveSpeaker } from "./scene.js";
import { createRoster, DEFAULT_SPEAKER } from "./characters.js";

const bossCharacter = createRoster().find((c) => c.id === DEFAULT_SPEAKER);

export async function* runAgentStream({ userText, messages = null, sessionId = "default", target = null, histories = {} }) {
  // messages 是旧签名里的会话数组，等价于老板娘的私有历史
  const h = Array.isArray(messages) ? { ...histories, [DEFAULT_SPEAKER]: messages } : histories;
  yield* runScene({ userText, sessionId, target, histories: h });
}

// 评测层要断言"记忆有没有真的进 prompt"，所以这里单独暴露一个构造器
export function buildSystemPrompt(profile, eggHint = "", memoryNote = "") {
  return bossCharacter.buildSystemPrompt(profile, eggHint, memoryNote, "", "", "");
}

export { getRoster, resolveSpeaker, DEFAULT_SPEAKER };
