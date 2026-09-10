// 场景调度。一拍 = 一次玩家输入牵动的整场反应。
// 三条硬约束：
//   1. 每拍只有一个主角，其他人要过 cheap react 才有发言权（否则 N² 互相应答）
//   2. 所有调用都从 budget 里扣，超上限立刻停（看门狗）
//   3. 角色只能看到自己说过的话，别人的内容通过场景块进入 system prompt
import { createBus } from "./bus.js";
import { createRoster, DEFAULT_SPEAKER } from "./characters.js";
import { createBudget } from "./character.js";
import { guardInput, guardOutput } from "./safety.js";
import { planBeat, shouldPlanBeat } from "./director.js";
import { reviewBeat } from "./critic.js";
import { getWorld, tick, presentActors, snapshot as worldSnapshot } from "./world.js";
import {
  startTrace,
  endTrace,
  timer,
  recordSafety,
  recordReact,
  recordBeat,
  recordBudgetExhausted,
} from "./telemetry.js";

// 运行时读取，方便评测按套件调阈值
const reactThreshold = () => Number(process.env.REACT_THRESHOLD ?? 0.25);
const maxSecondary = () => Number(process.env.MAX_SECONDARY_SPEAKERS ?? 1);
const secondaryCooldown = () => Number(process.env.SECONDARY_COOLDOWN ?? 2);

const roster = createRoster();

let beatIndex = 0;
let lastSecondaryBeat = -99;
let lastDirectorBeat = -99;

export function getRoster() {
  return roster.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, tools: c.tools || [] }));
}

export function resolveSpeaker(userText, target) {
  if (target) {
    const hit = roster.find((c) => c.id === target || c.aliases.includes(target));
    if (hit) return hit.id;
  }
  const t = String(userText || "");
  for (const c of roster) {
    if (c.id === DEFAULT_SPEAKER) continue;
    if (c.aliases.some((a) => t.includes(a))) return c.id;
  }
  return DEFAULT_SPEAKER;
}

export function resetSceneState() {
  beatIndex = 0;
  lastSecondaryBeat = -99;
  lastDirectorBeat = -99;
}

async function* streamTurn(gen) {
  let step = await gen.next();
  while (!step.done) {
    yield step.value;
    step = await gen.next();
  }
  return step.value;
}

export async function* runScene({ userText, sessionId = "default", target = null, histories = {} }) {
  const bus = createBus();
  const budget = createBudget();
  const sceneId = `sc_${Date.now().toString(36)}`;
  const trace = startTrace({ sessionId, userText, sceneId });
  const thisBeat = beatIndex++;

  const hist = (id) => {
    if (!Array.isArray(histories[id])) histories[id] = [];
    return histories[id];
  };

  try {
    const tGuard = timer();
    const inGuard = guardInput(userText);
    recordSafety(trace, {
      stage: "input",
      action: inGuard.action === "allow" ? "allow" : "block",
      reason: inGuard.reason,
      latencyMs: tGuard.ms(),
      reply: inGuard.reply,
    });

    if (inGuard.action === "deflect") {
      yield { type: "safety", stage: "input", action: "block", reason: inGuard.reason };
      yield { type: "delta", actor: DEFAULT_SPEAKER, text: inGuard.reply };
      hist(DEFAULT_SPEAKER).push({ role: "user", content: userText }, { role: "assistant", content: inGuard.reply });
      endTrace(trace, { reply: inGuard.reply, ok: true });
      yield {
        type: "done",
        reply: inGuard.reply,
        replies: { [DEFAULT_SPEAKER]: inGuard.reply },
        actions: [],
        speaker: DEFAULT_SPEAKER,
        world: worldSnapshot(),
        traceId: trace.id,
        budget: budget.snapshot(),
      };
      return;
    }

    const speakerId = resolveSpeaker(userText, target);
    bus.publish({ from: "player", type: "say", beat: thisBeat, payload: { text: userText } });

    let beat = null;
    if (shouldPlanBeat({ beatIndex: thisBeat, userText, lastBeatAt: lastDirectorBeat })) {
      beat = await planBeat({ bus, trace, budget, speakerId });
      if (beat) {
        lastDirectorBeat = thisBeat;
        recordBeat(trace, { index: thisBeat, ...beat });
        bus.publish({ from: "director", type: "beat", beat: thisBeat, payload: beat });
        yield { type: "beat", index: thisBeat, ...beat };
      }
    }

    const present = presentActors();
    const others = roster.filter((c) => c.id !== speakerId && present.includes(c.id));
    const reactPromises = others.map(async (c) => {
      recordReact(trace, { actor: c.id });
      const r = await c.react({ bus, trace, budget });
      return { character: c, ...r };
    });

    const primary = roster.find((c) => c.id === speakerId);
    if (!primary) throw new Error(`未知角色：${speakerId}`);

    const primaryBeat = beat && beat.assignee === speakerId ? beat : null;
    const mainTurn = yield* streamTurn(
      primary.act({
        bus,
        trace,
        budget,
        beat: primaryBeat,
        playerText: userText,
        history: hist(speakerId),
      })
    );

    let reply = mainTurn?.reply || "……";
    reply = guardAndReport({ trace, actor: speakerId, reply, out: [] });

    bus.publish({
      from: speakerId,
      type: "say",
      beat: thisBeat,
      payload: { speaker: primary.name, text: reply },
    });

    const reactions = await Promise.all(reactPromises);
    const withinCooldown = thisBeat - lastSecondaryBeat >= secondaryCooldown();

    let candidates = reactions
      .filter((r) => r.speak && r.urgency >= reactThreshold())
      .sort((a, b) => b.urgency - a.urgency);

    // 导演点名的人插到队首，不管 react 判没判过
    if (beat && beat.assignee !== speakerId) {
      const assigned = reactions.find((r) => r.character.id === beat.assignee);
      if (assigned && !candidates.includes(assigned)) candidates = [assigned, ...candidates];
    }
    if (!withinCooldown) candidates = [];

    const secondary = [];
    for (const cand of candidates.slice(0, maxSecondary())) {
      if (budget.exhausted) {
        recordBudgetExhausted(trace);
        yield { type: "budget_exhausted", used: budget.used };
        break;
      }
      const subBeat = {
        index: thisBeat,
        assignee: cand.character.id,
        from: "react",
        goal: cand.angle || (beat && beat.assignee === cand.character.id ? beat.goal : "就刚才发生的事补一句"),
      };
      const turn = yield* streamTurn(
        cand.character.act({
          bus,
          trace,
          budget,
          beat: subBeat,
          playerText: userText,
          history: hist(cand.character.id),
          observed: true,
        })
      );
      if (!turn) continue;

      const text = guardAndReport({ trace, actor: cand.character.id, reply: turn.reply, out: [], yieldRef: null });
      bus.publish({
        from: cand.character.id,
        type: "say",
        beat: thisBeat,
        payload: { speaker: cand.character.name, text },
      });
      secondary.push({ actor: cand.character.id, name: cand.character.name, reply: text, urgency: cand.urgency });
    }
    if (secondary.length) lastSecondaryBeat = thisBeat;

    const speakers = [speakerId, ...secondary.map((s) => s.actor)];
    const review = await reviewBeat({ bus, trace, budget, beat, speakers });
    if (review.verdict !== "pass") {
      yield { type: "critic", verdict: review.verdict, issue: review.issue, hint: review.hint };
    }

    tick();
    endTrace(trace, { reply, ok: true });

    yield {
      type: "done",
      reply,
      replies: { [speakerId]: reply, ...Object.fromEntries(secondary.map((s) => [s.actor, s.reply])) },
      actions: mainTurn?.actions || [],
      game: mainTurn?.game || null,
      world: worldSnapshot(),
      traceId: trace.id,
      sceneId,
      speaker: speakerId,
      beat: beat ? { index: thisBeat, ...beat } : { index: thisBeat },
      speakers,
      review,
      budget: budget.snapshot(),
    };
  } catch (e) {
    endTrace(trace, { reply: "", ok: false, error: e.message });
    throw e;
  }
}

// 输出守卫必须能替换已经流出去的文本，所以在这里统一处理并把替换结果带出去
function guardAndReport({ trace, actor, reply }) {
  const tOut = timer();
  const out = guardOutput(reply);
  recordSafety(trace, {
    actor,
    stage: "output",
    action: out.action === "allow" ? "allow" : "block",
    reason: out.reason,
    latencyMs: tOut.ms(),
    reply: out.reply,
  });
  return out.action === "replace" ? out.reply : reply;
}

export function sceneInfo() {
  return { beatIndex, lastSecondaryBeat, lastDirectorBeat, world: worldSnapshot() };
}

export { getWorld };
