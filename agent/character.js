import { chatStream } from "./llm.js";
import { toolDefinitions, toolImplementations } from "./tools.js";
import { loadProfile, saveProfile } from "./memory.js";
import { detectIntent } from "./intent.js";
import { detectEasterEgg, buildGameRules, updateGameState, snapshot } from "./game.js";
import { vectorEnabled } from "./embed.js";
import { addMemory, searchMemory } from "./vectorstore.js";
import { reflectOnTools, buildRevisionMessage, reflectionEnabled } from "./reflection.js";
import { getWorld, adjustRelationship, displayName } from "./world.js";
import { formatEvent } from "./bus.js";
import {
  addSpan,
  timer,
  recordLLM,
  recordTool,
  recordMemory,
  recordReflection,
  recordLoop,
  recordAuxLLM,
} from "./telemetry.js";

const MAX_LOOPS = Number(process.env.MAX_AGENT_LOOPS || 6);
const HISTORY_LIMIT = 16;
const HISTORY_KEEP_RECENT = 8;

function toolCallKey(name, args) {
  const keys = Object.keys(args || {}).sort();
  return `${name}::${JSON.stringify(keys.map((k) => [k, args[k]]))}`;
}

export function createCharacter({ id, name, aliases = [], persona, memoryNs = "default", tools = [], goalStyle = "" }) {
  const toolDefs = tools.length ? toolDefinitions.filter((t) => tools.includes(t.function.name)) : [];
  const allowed = new Set(tools);
  const requiredArgs = (toolName) =>
    (toolDefs.find((t) => t.function.name === toolName)?.function.parameters?.required || []);

  const api = {
    id,
    name,
    aliases,
    tools: [...allowed],
    persona,

    getProfile() {
      return loadProfile(memoryNs);
    },

    saveProfile(profile) {
      saveProfile(profile, memoryNs);
    },

    async react({ bus, trace, budget, phase = "parallel", sinceSpeak = null }) {
      if (!budget.spend("react")) return { speak: false, urgency: 0, angle: "", reason: "" };

      const recent = bus
        .recentEvents(4)
        .map(formatEvent)
        .join("\n");

      const here = getWorld().present.filter((p) => p !== id);
      const crowd = here.length
        ? `此刻店里除了你和顾客，还有：${here.map(displayName).join("、")}。他们就在场，别把人说成不在、没来或者没见着人影。\n`
        : `此刻店里除了你和顾客，没有别人。\n`;

      const myTurn = sinceSpeak == null
        ? `你今晚还一句话都没说过。\n`
        : sinceSpeak <= 1
          ? `你上一拍刚开过口，这一拍就别急着再接。\n`
          : `你上一次开口是 ${sinceSpeak} 拍之前。\n`;

      const t0 = Date.now();
      const { chatWithModel } = await import("./llm.js");
      try {
        const res = await chatWithModel({
          model: process.env.SMALL_MODEL || undefined,
          messages: [
            {
              role: "system",
              content:
                `你是「${name}」。${goalStyle}\n` +
                `你正在这家酒吧里，刚听到了下面这些事。\n` +
                crowd +
                myTurn +
                (phase === "followup"
                  ? `最后那一句是别人刚说的。你可以顺着那一句接，也可以只对客人说。\n`
                  : "") +
                `现在判断这一拍你要不要开口。默认答案是不说——你是个在角落里喝酒听人说话的人，多数时候不插嘴，偶尔说一句才有分量。\n` +
                `只有下面这几种情况才值得开口：\n` +
                `- 有人直接叫了你的名字，或者问到了你\n` +
                `- 你手上有别人没有的东西：这条街的事、你坐这些年看见的事、你自己身上的事\n` +
                `- 你确实不认同对方说的，而且说出来有用\n` +
                `下面这些都不是理由，出现就别开口：\n` +
                `- 捧场、附和、把别人的话换个说法再说一遍（"说得在理""确实""没错"）\n` +
                `- 只是想让客人注意到你，或者想显摆自己在这儿坐了多少年\n` +
                `- 客人刚进门、还在跟老板娘寒暄，这事跟你没关系\n` +
                `- 你刚才已经说过了\n` +
                `urgency 只在开口时才有意义：0.6 = 有点想说，0.8 = 很想说，1 = 非说不可。\n` +
                `只输出 JSON：{"speak":false,"urgency":0,"angle":"","reason":"一句话说明为什么开口，或者为什么不说"}`,
            },
            { role: "user", content: recent || "（还没有什么特别的事）" },
          ],
        });
        const parsed = parseLooseJson(res.content);
        const reason = String(parsed?.reason || "").slice(0, 80);
        const wanted = Boolean(parsed?.speak);
        const out = {
          speak: wanted && Boolean(reason),
          urgency: Number(parsed?.urgency || 0),
          angle: String(parsed?.angle || "").slice(0, 60),
          reason,
          downgraded: wanted && !reason,
        };
        if (res.usage) {
          budget.addUsage(res.usage);
          recordAuxLLM(trace, { actor: id, usage: res.usage, latencyMs: Date.now() - t0 });
        }
        addSpan(trace, {
          kind: "react",
          actor: id,
          name: "react",
          durMs: Date.now() - t0,
          detail: { phase, ...out, tokens: res.usage?.total_tokens ?? null },
        });
        return out;
      } catch (e) {
        addSpan(trace, { kind: "react", actor: id, name: "react", durMs: Date.now() - t0, ok: false, detail: { phase, error: e.message } });
        return { speak: false, urgency: 0, angle: "", reason: "" };
      }
    },

    async *act({ bus, trace, budget, beat, playerText, history = [], observed = false, initiated = false, criticNote = "" }) {
      const profile = api.getProfile();
      const { intent, tool } = detectIntent(playerText);
      const forcedTool = tool && allowed.has(tool) ? { type: "function", function: { name: tool } } : null;
      const activeToolDefs = observed && !tool ? [] : toolDefs;

      addSpan(trace, {
        kind: "intent",
        actor: id,
        name: intent || "none",
        durMs: 0,
        detail: { forcedTool: tool, forced: Boolean(forcedTool), toolsOffered: activeToolDefs.length },
      });

      const egg = id === "boss" ? detectEasterEgg(playerText, profile) : { hint: "" };

      let memoryNote = "";
      if (vectorEnabled()) {
        const tMem = timer();
        const relevant = await searchMemory(playerText, 4, id);
        if (relevant.length) memoryNote = relevant.map((s, i) => `${i + 1}. ${s}`).join("\n");
        recordMemory(trace, {
          actor: id,
          op: "recall",
          count: relevant.length,
          latencyMs: tMem.ms(),
          detail: { count: relevant.length, items: relevant },
        });
      }

      const scene = bus.recentEvents(6).map(formatEvent).join("\n");
      const note = criticNote ? `\n【场记对上一拍的意见】${criticNote}` : "";
      const beatLine = !beat
        ? ""
        : beat.from
          ? `\n【你想接的话头】${beat.goal}\n（这只是个话头：如果它跟你知道的事实冲突——比如把在场的人说成不在——按事实来。）`
          : `\n【本拍你要做的事】${beat.goal}`;
      const userContent = initiated
        ? "（吧台前那位客人有一会儿没开口了。你主动起个话头，跟他说一句。）"
        : observed
          ? `（旁边有人在说话，你听见了：「${playerText}」）\n` +
            (beat ? `你想接的话头：${beat.goal}` : "有想说的就接一句，没什么可说就简短应一声。") +
            (tool ? "" : "\n（这句不是在跟你点单，别去动吧台的工具。）")
          : playerText;
      const msgs = [
        {
          role: "system",
          content: api.buildSystemPrompt(profile, egg.hint, memoryNote, scene + note, beatLine, playerText),
        },
        ...history,
        { role: "user", content: userContent },
      ];

      const actions = [];
      let reply = "";
      let loops = 0;
      let inventedOnce = false;
      let reflectedOnce = false;
      let resetPending = false;
      const executed = new Map();

      while (loops < MAX_LOOPS) {
        if (!budget.spend("act")) break;
        if (resetPending) {
          resetPending = false;
          yield { type: "reset", actor: id };
        }
        const toolChoice = loops === 0 && forcedTool ? forcedTool : "auto";
        let message = null;
        let meta = null;
        let stepContent = "";

        for await (const ev of chatStream({ messages: msgs, tools: activeToolDefs, toolChoice })) {
          if (ev.kind === "delta") {
            stepContent += ev.text;
            yield { type: "delta", actor: id, text: ev.text };
          } else if (ev.kind === "result") {
            message = ev.message;
            meta = ev;
          }
        }

        loops += 1;
        recordLoop(trace, id);

        if (meta) {
          recordLLM(trace, {
            actor: id,
            step: loops,
            model: meta.model,
            toolChoice: toolChoice === "auto" ? "auto" : `forced:${toolChoice.function.name}`,
            usage: meta.usage,
            latencyMs: meta.latencyMs,
            ttftMs: meta.ttftMs,
            contentChars: stepContent.length,
            toolCalls: (message?.tool_calls || []).map((t) => t.function.name),
            finishReason: meta.finishReason,
          });
        }

        if (message && message.tool_calls && message.tool_calls.length) {
          msgs.push(message);

          for (const tc of message.tool_calls) {
            const { name, arguments: argStr } = tc.function;
            let args = {};
            try {
              args = argStr ? JSON.parse(argStr || "{}") : {};
            } catch (e) {
              args = {};
            }

            if (!allowed.has(name)) {
              const result = `你没有权限使用工具 ${name}。`;
              msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
              recordTool(trace, { actor: id, name, args, result, latencyMs: 0, ok: false });
              continue;
            }

            const missing = requiredArgs(name).filter((k) => {
              const v = args[k];
              return v === undefined || v === null || (typeof v === "string" && !v.trim());
            });
            if (missing.length) {
              const result = `调用 ${name} 缺少必填参数：${missing.join("、")}。请补齐参数后重新调用。`;
              msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
              recordTool(trace, { actor: id, name, args, result, latencyMs: 0, ok: false });
              continue;
            }

            if (name === "inventDrink" && inventedOnce) {
              const result = "这杯酒已经原创好了，别再重复创作；直接把刚才那杯端给客人，并用一句话回答即可。";
              msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
              recordTool(trace, { actor: id, name, args, result, latencyMs: 0, ok: true });
              continue;
            }

            const execKey = toolCallKey(name, args);
            if (executed.has(execKey)) {
              const result = `这一步本轮已经执行过了，不要再重复执行：${executed.get(execKey)}`;
              msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
              recordTool(trace, { actor: id, name, args, result, latencyMs: 0, ok: true });
              continue;
            }

            const tTool = timer();
            let result;
            let ok = true;
            try {
              const impl = toolImplementations[name];
              if (!impl) throw new Error(`未知工具：${name}`);
              result = impl(args);
            } catch (e) {
              ok = false;
              result = `工具执行出错：${e.message}`;
            }
            if (ok) executed.set(execKey, String(result));

            if (name === "inventDrink" && ok) {
              inventedOnce = true;
              if (!profile.customDrinks) profile.customDrinks = [];
              profile.customDrinks.unshift({
                name: args.name, spirit: args.spirit, mixer: args.mixer, note: args.note || "",
              });
              if (profile.customDrinks.length > 20) profile.customDrinks.pop();
            }

            msgs.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
            const action = { name, args, result: String(result) };
            actions.push(action);
            recordTool(trace, { actor: id, name, args, result, latencyMs: tTool.ms(), ok });

            bus.publish({
              from: id,
              type: "act",
              beat: beat?.index ?? null,
              payload: { tool: name, summary: String(result).slice(0, 80) },
            });
            yield { type: "action", actor: id, name, args, result: String(result) };
          }

          if (reflectionEnabled() && !reflectedOnce && budget.spend("reflect")) {
            reflectedOnce = true;
            const r = await reflectOnTools({ userText: playerText, actions });
            const willRetry = r.verdict === "revise" && loops < MAX_LOOPS - 1;
            if (r.ran) {
              recordReflection(trace, {
                actor: id,
                verdict: r.verdict,
                issue: r.issue,
                latencyMs: r.latencyMs,
                retried: willRetry,
              });
              if (r.usage) budget.addUsage(r.usage);
              yield { type: "reflection", actor: id, verdict: r.verdict, issue: r.issue, retried: willRetry };
            }
            if (willRetry) msgs.push({ role: "system", content: buildRevisionMessage(r) });
          }

          resetPending = true;
          continue;
        }

        message = message || {};
        reply = message.content || stepContent || reply;
        break;
      }

      if (!reply) reply = "……（没接上话）";

      profile.orderCount += 1;
      updateProfileFromReply(profile, playerText, reply);

      const signals = {
        ordered: actions.some((a) => a.name === "makeDrink" || a.name === "inventDrink"),
        paid: actions.some((a) => a.name === "takePayment"),
        saidName: /我叫|我是/.test(playerText),
        friendly: /谢谢|喜欢|好好喝|真棒|可爱|好看|好喝|温柔|厉害|好评/.test(playerText),
        rude: /滚|闭嘴|傻|白痴|垃圾|废物|去死|差评|退钱|破店/.test(playerText),
      };
      const gameUpdate = id === "boss" ? updateGameState(profile, signals) : { levelUp: false };
      api.saveProfile(profile);
      adjustRelationship(id, signals.friendly ? 2 : signals.rude ? -3 : 0);

      const memorable =
        signals.ordered || signals.paid || signals.saidName || actions.some((a) => a.name === "inventDrink");

      if (vectorEnabled() && memorable && budget.spend("memory")) {
        const tWrite = timer();
        const memoryText = await extractMemory(playerText, reply, profile, id, trace);
        if (memoryText) {
          await addMemory(memoryText, {}, id);
          recordMemory(trace, { actor: id, op: "write", count: 1, latencyMs: tWrite.ms(), detail: { text: memoryText } });
        }
      }

      history.push({ role: "user", content: initiated ? "（你主动开了个话头）" : playerText });
      history.push({ role: "assistant", content: reply });
      if (history.length > HISTORY_LIMIT) {
        const tCompact = timer();
        await compactHistory(history, trace, id);
        addSpan(trace, { kind: "memory", actor: id, name: "compact", durMs: tCompact.ms(), detail: { historyLength: history.length } });
      }

      return {
        reply,
        actions,
        game: { ...snapshot(profile), levelUp: gameUpdate.levelUp },
      };
    },

    buildSystemPrompt(profile, eggHint, memoryNote, scene, beatLine, playerText) {
      const known = [];
      if (profile.customerName) known.push(`顾客的名字是「${profile.customerName}」。`);
      if (profile.favoriteDrink) known.push(`顾客最喜欢的饮品是「${profile.favoriteDrink}」。`);
      if (profile.orderCount > 0) known.push(`今天已经为这位顾客招待过 ${profile.orderCount} 次。`);
      const memo = known.length ? `\n关于这位顾客，你记得：${known.join(" ")}` : "";
      const game = id === "boss" ? buildGameRules(profile) : "";
      const egg = eggHint ? `\n【本轮特别剧情】${eggHint}` : "";
      const vec = memoryNote ? `\n【你记得的相关往事（语义检索）】\n${memoryNote}` : "";
      const others = getWorld().present.filter((p) => p !== id).map(displayName);
      const crowd = others.length
        ? `\n【在场的人】除了顾客，还有：${others.join("、")}。他们就在店里坐着，别说成不在、没来或者没见着人影。`
        : "";
      const sc = scene ? `\n【刚才发生了什么】\n${scene}` : "";
      return [persona, game, crowd, memo, sc, beatLine || "", egg, vec].filter(Boolean).join("\n");
    },
  };

  return api;
}

export function createBudget(limit = Number(process.env.MAX_SCENE_CALLS || 16)) {
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const byKind = {};
  return {
    spend(kind) {
      if (calls >= limit) return false;
      calls += 1;
      byKind[kind] = (byKind[kind] || 0) + 1;
      return true;
    },
    addUsage(usage) {
      promptTokens += usage.prompt_tokens || 0;
      completionTokens += usage.completion_tokens || 0;
    },
    get used() {
      return calls;
    },
    get exhausted() {
      return calls >= limit;
    },
    snapshot() {
      return { calls, limit, byKind, promptTokens, completionTokens };
    },
  };
}

export function parseLooseJson(text) {  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function updateProfileFromReply(profile, userText, reply) {
  const nameMatch = userText.match(/我叫([^\s，。！？,.!?]+)/) ||
                    userText.match(/我是([^\s，。！？,.!?]+)/);
  if (nameMatch && !profile.customerName) {
    profile.customerName = nameMatch[1].slice(0, 6);
  }
  const drinkMatch = userText.match(/(点一杯|来一杯|要一杯|来杯|给我来)([^\s，。！？,.!?]+)/) ||
                     reply.match(/「([^」]+)」/);
  if (drinkMatch && !profile.favoriteDrink) {
    profile.favoriteDrink = drinkMatch[2] || drinkMatch[1];
  }
}

async function compactHistory(messages, trace, actorId) {
  const { chatWithModel } = await import("./llm.js");
  const dropCount = messages.length - HISTORY_KEEP_RECENT;
  const dropped = messages.slice(0, dropCount);
  messages.splice(0, dropCount);
  try {
    const lines = dropped.map((m) => `${m.role}：${m.content}`).join("\n");
    const res = await chatWithModel({
      messages: [
        { role: "system", content: "你是对话压缩助手。把下面这段酒吧对话浓缩成不超过2句话的摘要，只保留有用信息（顾客名字、点过的东西、重要约定），用第三人称。直接输出摘要文本，不要加前缀。" },
        { role: "user", content: lines },
      ],
    });
    messages.unshift({ role: "system", content: `【更早的对话摘要】${(res.content || "").trim()}` });
  } catch (e) {
    console.warn("[agent] 摘要压缩失败，已回退为丢弃旧消息：", e.message);
    addSpan(trace, { kind: "memory", actor: actorId, name: "compact_failed", durMs: 0, ok: false, detail: { error: e.message } });
  }
}

async function extractMemory(userText, reply, profile, owner, trace) {
  const { chatWithModel } = await import("./llm.js");
  try {
    const res = await chatWithModel({
      messages: [
        { role: "system", content: `你是这家酒吧的记忆助手。从下面这段对话里提炼出【值得长期记住的事实】——顾客的名字、喜欢的口味/基酒、点过的酒、说过的喜好或约定。用一句不超过15个字的话概括，只输出这一句，不要加前缀；没有可记的就输出空字符串。` },
        { role: "user", content: `顾客：${userText}\n${displayName(owner)}：${reply}\n（已知：顾客叫「${profile.customerName || "未知"}」，最爱「${profile.favoriteDrink || "未知"}」）` },
      ],
    });
    if (res.usage && trace) recordAuxLLM(trace, { actor: owner, usage: res.usage, latencyMs: res.latencyMs });
    return (res.content || "").trim();
  } catch {
    return "";
  }
}

export const CHARACTER_LIMITS = { MAX_LOOPS, HISTORY_LIMIT, HISTORY_KEEP_RECENT };
