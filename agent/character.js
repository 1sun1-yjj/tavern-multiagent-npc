// 把原先写死在 agent.js 里的编排循环抽成「角色」。
// 每个角色有自己的 system prompt、自己的长期画像、自己的向量记忆归属，
// 以及自己的工具集——这是多 Agent 成立的实质条件，不是换个名字。
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

export function createCharacter({ id, name, aliases = [], persona, memoryNs = "default", tools = [], goalStyle = "" }) {
  const toolDefs = tools.length ? toolDefinitions.filter((t) => tools.includes(t.function.name)) : [];
  const allowed = new Set(tools);

  const api = {
    id,
    name,
    aliases,
    persona,

    getProfile() {
      return loadProfile(memoryNs);
    },

    saveProfile(profile) {
      saveProfile(profile, memoryNs);
    },

    // 廉价判定：只回答"要不要开口"，不生成台词。
    // 用小模型 + 极短 prompt，这是多 Agent 成本控制的关键一层。
    async react({ bus, trace, budget }) {
      if (!budget.spend("react")) return { speak: false, urgency: 0, angle: "" };

      const recent = bus
        .recentEvents(4)
        .map(formatEvent)
        .join("\n");

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
                `判断你是否想插一句话。酒吧里邻座搭话是很自然的事，如果话头跟你有关系、或者你有想说的，就该开口，不用太客气。\n` +
                `只有在这件事确实跟你毫无关系、或者你没什么可说的时候，才 speak=false。\n` +
                `urgency 用 0 到 1 表示你有多想说（0.3 = 随口一句，0.8 = 很想说）。\n` +
                `只输出 JSON：{"speak":true,"urgency":0.5,"angle":"你想说的那句话的大意"}`,
            },
            { role: "user", content: recent || "（还没有什么特别的事）" },
          ],
        });
        const parsed = parseLooseJson(res.content);
        const out = {
          speak: Boolean(parsed?.speak),
          urgency: Number(parsed?.urgency || 0),
          angle: String(parsed?.angle || "").slice(0, 60),
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
          detail: { ...out, tokens: res.usage?.total_tokens ?? null },
        });
        return out;
      } catch (e) {
        addSpan(trace, { kind: "react", actor: id, name: "react", durMs: Date.now() - t0, ok: false, detail: { error: e.message } });
        return { speak: false, urgency: 0, angle: "" };
      }
    },

    // 完整回合：跑一遍编排循环。
    // history 是这个角色自己的会话历史，不含别人说的话——别人的内容通过
    // 场景块进入 system prompt。上下文隔离是多 Agent 成立的前提。
    // observed=true 用于次要角色：这句不是对他说的，他只是听见了。
    async *act({ bus, trace, budget, beat, playerText, history = [], observed = false }) {
      const profile = api.getProfile();
      const { intent, tool } = detectIntent(playerText);
      const forcedTool = tool && allowed.has(tool) ? { type: "function", function: { name: tool } } : null;

      addSpan(trace, {
        kind: "intent",
        actor: id,
        name: intent || "none",
        durMs: 0,
        detail: { forcedTool: tool, forced: Boolean(forcedTool) },
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
      const beatLine = beat ? `\n【本拍你要做的事】${beat.goal}` : "";
      // 旁听者如果拿到的是玩家原话，会误以为在问自己，答出"这你得问老板娘"这种错位回答
      const userContent = observed
        ? `（旁边有人在说话，你听见了：「${playerText}」）\n` +
          (beat ? `你想接的话头：${beat.goal}` : "有想说的就接一句，没什么可说就简短应一声。")
        : playerText;
      const msgs = [
        {
          role: "system",
          content: api.buildSystemPrompt(profile, egg.hint, memoryNote, scene, beatLine, playerText),
        },
        ...history,
        { role: "user", content: userContent },
      ];

      const actions = [];
      let reply = "";
      let loops = 0;
      let inventedOnce = false;
      let reflectedOnce = false;

      while (loops < MAX_LOOPS) {
        if (!budget.spend("act")) break;
        const toolChoice = loops === 0 && forcedTool ? forcedTool : "auto";
        let message = null;
        let meta = null;
        let stepContent = "";

        for await (const ev of chatStream({ messages: msgs, tools: toolDefs, toolChoice })) {
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

            if (name === "inventDrink" && inventedOnce) {
              const result = "这杯酒已经原创好了，别再重复创作；直接把刚才那杯端给客人，并用一句话回答即可。";
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

            if (name === "inventDrink") {
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

      history.push({ role: "user", content: playerText });
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
      const crowd = others.length ? `\n【在场的人】除了顾客，还有：${others.join("、")}。` : "";
      const sc = scene ? `\n【刚才发生了什么】\n${scene}` : "";
      return [persona, game, crowd, memo, sc, beatLine || "", egg, vec].filter(Boolean).join("\n");
    },
  };

  return api;
}

// 一次玩家输入最多允许花掉多少次模型调用。超过就立刻停——
// 没有这个上限，一次异常输入可能触发几十次调用。
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
        { role: "system", content: "你是酒吧老板娘的记忆助手。从下面这段对话里提炼出【值得长期记住的事实】——顾客的名字、喜欢的口味/基酒、点过的酒、说过的喜好或约定。用一句不超过15个字的话概括，只输出这一句，不要加前缀；没有可记的就输出空字符串。" },
        { role: "user", content: `顾客：${userText}\n老板娘：${reply}\n（已知：顾客叫「${profile.customerName || "未知"}」，最爱「${profile.favoriteDrink || "未知"}」）` },
      ],
    });
    if (res.usage && trace) recordAuxLLM(trace, { actor: owner, usage: res.usage, latencyMs: res.latencyMs });
    return (res.content || "").trim();
  } catch {
    return "";
  }
}

export const CHARACTER_LIMITS = { MAX_LOOPS, HISTORY_LIMIT, HISTORY_KEEP_RECENT };
