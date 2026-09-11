import { runScene, runAmbient, getRoster, resolveSpeaker, getAmbientState } from "./scene.js";
import { createRoster, DEFAULT_SPEAKER } from "./characters.js";

const bossCharacter = createRoster().find((c) => c.id === DEFAULT_SPEAKER);

export async function* runAgentStream({ userText, messages = null, sessionId = "default", target = null, histories = {} }) {
  const h = Array.isArray(messages) ? { ...histories, [DEFAULT_SPEAKER]: messages } : histories;
  yield* runScene({ userText, sessionId, target, histories: h });
}

export async function* runAmbientStream({ sessionId = "default", histories = {}, idleMs = 0, force = false, rand = Math.random }) {
  yield* runAmbient({ sessionId, histories, idleMs, force, rand });
}

export function buildSystemPrompt(profile, eggHint = "", memoryNote = "") {
  return bossCharacter.buildSystemPrompt(profile, eggHint, memoryNote, "", "", "");
}

export { getRoster, resolveSpeaker, getAmbientState, DEFAULT_SPEAKER };
