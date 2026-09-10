import { runScene, getRoster, resolveSpeaker } from "./scene.js";
import { createRoster, DEFAULT_SPEAKER } from "./characters.js";

const bossCharacter = createRoster().find((c) => c.id === DEFAULT_SPEAKER);

export async function* runAgentStream({ userText, messages = null, sessionId = "default", target = null, histories = {} }) {
  const h = Array.isArray(messages) ? { ...histories, [DEFAULT_SPEAKER]: messages } : histories;
  yield* runScene({ userText, sessionId, target, histories: h });
}

export function buildSystemPrompt(profile, eggHint = "", memoryNote = "") {
  return bossCharacter.buildSystemPrompt(profile, eggHint, memoryNote, "", "", "");
}

export { getRoster, resolveSpeaker, DEFAULT_SPEAKER };
