import { chatWithModel } from "./llm.js";
import { formatEvent } from "./bus.js";
import { displayName, presentActors, getWorld } from "./world.js";
import { addSpan, recordInitiative, recordAuxLLM } from "./telemetry.js";
import { parseLooseJson } from "./character.js";

const INITIATIVE_SYSTEM = `你在酒吧里演一个角色。这会儿没人跟你说话，你想主动跟吧台前的那位客人搭一句。

只输出 JSON，不要解释：
{"topic":"你打算开口说的那句话大意（一句话）","why":"为什么这时候想说","urgency":0.5}

要求：
- 是搭话，不是自言自语：可以问一句、点评一句、提一件你注意到的小事
- 换着花样来，别每次都问同一类问题；天气、这条街、你手边那杯酒、刚才别人的话都能当由头
- 一句话就够，不要连着抛三个问题，不要像问卷
- 客人要是不想聊，你也只是轻轻一句，不要纠缠
- 不要重复刚才已经说过的内容`;

export function initiativeEnabled() {
  return process.env.GUEST_INITIATIVE !== "0";
}

export function initiativeConfig() {
  return {
    chance: Number(process.env.GUEST_INITIATIVE_CHANCE ?? 0.35),
    gapMs: Number(process.env.GUEST_INITIATIVE_GAP_MS ?? 45000),
    minIdleMs: Number(process.env.GUEST_INITIATIVE_MIN_IDLE_MS ?? 20000),
    replyWindowMs: Number(process.env.GUEST_REPLY_WINDOW_MS ?? 90000),
    followup: process.env.GUEST_FOLLOWUP !== "0",
  };
}

export function shouldInitiate({
  idleMs = 0,
  sinceLastMs = Infinity,
  present = [],
  candidates = [],
  rand = Math.random,
  force = false,
  enabled = initiativeEnabled(),
  config = initiativeConfig(),
} = {}) {
  if (!enabled) return { go: false, reason: "disabled", actor: null };
  const here = candidates.filter((id) => present.includes(id));
  if (!here.length) return { go: false, reason: "nobody_present", actor: null };
  if (force) return { go: true, reason: "forced", actor: here[0] };
  if (!(idleMs >= config.minIdleMs)) return { go: false, reason: "too_soon", actor: here[0] };
  if (sinceLastMs < config.gapMs) return { go: false, reason: "cooldown", actor: here[0] };
  if (!(rand() <= config.chance)) return { go: false, reason: "chance", actor: here[0] };
  return { go: true, reason: "ok", actor: here[0] };
}

export async function planInitiative({ bus, trace, budget, initiatorId, silentMs = 0 }) {
  if (!budget.spend("initiative")) return null;
  recordInitiative(trace, { actor: initiatorId, phase: "plan" });

  const world = getWorld();
  const recent = bus.recentEvents(6).map(formatEvent).join("\n");
  const t0 = Date.now();

  try {
    const res = await chatWithModel({
      model: process.env.SMALL_MODEL || undefined,
      messages: [
        { role: "system", content: INITIATIVE_SYSTEM },
        {
          role: "user",
          content:
            `你是「${displayName(initiatorId)}」。\n` +
            `在场的人：${presentActors().map(displayName).join("、")}\n` +
            `现在是${world.clock.phase}，第 ${world.clock.turn} 拍，今天已经卖出 ${world.servedToday} 杯。\n` +
            `吧台前的客人已经 ${Math.max(0, Math.round(silentMs / 1000))} 秒没开口了。\n\n` +
            `刚才发生的事：\n${recent || "（没什么特别的）"}`,
        },
      ],
    });

    const parsed = parseLooseJson(res.content);
    if (res.usage) {
      budget.addUsage(res.usage);
      recordAuxLLM(trace, { actor: initiatorId, usage: res.usage, latencyMs: Date.now() - t0 });
    }

    const goal = String(parsed?.topic || "").slice(0, 80);
    if (!goal) {
      addSpan(trace, { kind: "initiative", actor: initiatorId, name: "plan", durMs: Date.now() - t0, ok: false, detail: { degraded: true } });
      return null;
    }

    const plan = {
      goal,
      why: String(parsed?.why || "").slice(0, 60),
      urgency: Number(parsed?.urgency ?? 0.5),
    };
    addSpan(trace, { kind: "initiative", actor: initiatorId, name: "plan", durMs: Date.now() - t0, detail: plan });
    return plan;
  } catch (e) {
    addSpan(trace, { kind: "initiative", actor: initiatorId, name: "plan", durMs: Date.now() - t0, ok: false, detail: { error: e.message } });
    return null;
  }
}

export const INITIATIVE_PROMPT = "（客人安静了一会儿，你先开口）";

export const INITIATIVE_DEFAULT_GOAL = "自己起个话头，跟吧台前的客人搭一句";
