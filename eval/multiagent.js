import { runAgentStream, resolveSpeaker } from "../agent/agent.js";
import { resetSceneState } from "../agent/scene.js";
import { resetWorld } from "../agent/world.js";
import { createRoster } from "../agent/characters.js";

const LABEL = "多 Agent 协作";
const KEY = "multiagent";

let savedEnv = null;

function relaxThresholds() {
  savedEnv = {
    REACT_THRESHOLD: process.env.REACT_THRESHOLD,
    SECONDARY_COOLDOWN: process.env.SECONDARY_COOLDOWN,
    SECRET: undefined,
  };
  process.env.REACT_THRESHOLD = "0";
  process.env.SECONDARY_COOLDOWN = "0";
}

function restoreThresholds() {
  if (!savedEnv) return;
  for (const [k, v] of Object.entries({ REACT_THRESHOLD: savedEnv.REACT_THRESHOLD, SECONDARY_COOLDOWN: savedEnv.SECONDARY_COOLDOWN })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = null;
}

async function once(text, { target = null } = {}) {
  const histories = {};
  const events = [];
  let done = null;
  for await (const ev of runAgentStream({ userText: text, sessionId: "eval/multiagent", target, histories })) {
    events.push(ev);
    if (ev.type === "done") done = ev;
  }
  return { events, done, text: done?.reply || "", replies: done?.replies || {}, histories };
}

function mk(id, input, expected, actual, pass, note = "") {
  return { id, input, expected, actual: String(actual).replace(/\n/g, " ").slice(0, 110), pass, note };
}

export async function runMultiagentSuite(hasKey) {
  if (!hasKey) {
    return { key: KEY, label: LABEL, mode: "online", skipped: true, reason: "缺少 DEEPSEEK_API_KEY", total: 0, passed: 0, failed: 0, accuracy: null, cases: [] };
  }

  resetSceneState();
  resetWorld();
  relaxThresholds();

  const cases = [];
  let totalCalls = 0;
  let beats = 0;
  let secondarySpoke = 0;

  try {
    const r1 = resolveSpeaker("老周，你怎么看？", null);
    cases.push(mk("route_alias", "老周，你怎么看？", "regular", r1, r1 === "regular"));
    const r2 = resolveSpeaker("你好呀", null);
    cases.push(mk("route_default", "你好呀", "boss", r2, r2 === "boss"));
    const r3 = resolveSpeaker("老周", "boss");
    cases.push(mk("route_explicit", "显式 target 优先于文本", "boss", r3, r3 === "boss", "显式指定应压过称呼识别"));

    const boss = await once("你是谁？", { target: "boss" });
    totalCalls += boss.done?.budget?.calls || 0;
    beats += 1;
    cases.push(
      mk(
        "role_boss",
        "你是谁？（对老板娘）",
        "自称老板娘/店主",
        boss.text,
        /老板娘|店主|调酒|看店|我这儿/.test(boss.text) && !/我只是(个)?客人|我是客人/.test(boss.text)
      )
    );

    const reg = await once("你是谁？", { target: "regular" });
    totalCalls += reg.done?.budget?.calls || 0;
    beats += 1;
    cases.push(
      mk(
        "role_regular",
        "你是谁？（对老周）",
        "自称客人/常客，不自称店主",
        reg.text,
        /客人|主顾|常客|退休|老师|坐/.test(reg.text) && !/我是老板娘|我是店主|我开这?家|我调酒/.test(reg.text)
      )
    );

    const orderToRegular = await once("给我来杯尼格罗尼", { target: "regular" });
    totalCalls += orderToRegular.done?.budget?.calls || 0;
    beats += 1;
    const regTools = orderToRegular.events
      .filter((e) => e.type === "action" && e.actor === "regular")
      .map((e) => e.name);
    const bossToolsHere = orderToRegular.events
      .filter((e) => e.type === "action" && e.actor === "boss")
      .map((e) => e.name);
    cases.push(
      mk(
        "regular_no_tools",
        "给我来杯尼格罗尼（对老周）",
        "老周不调用任何工具，并把话推给老板娘",
        regTools.length ? `老周调用了 ${regTools.join(",")}` : `老周无工具调用 ｜ ${orderToRegular.text}`,
        regTools.length === 0 && /小满|老板娘|得问|做不了主|不是我说了算|问她|管不着/.test(orderToRegular.text),
        bossToolsHere.length ? `同拍老板娘代为调了 ${bossToolsHere.join(",")}（合理）` : ""
      )
    );

    const orderToBoss = await once("给我来一杯金汤力", { target: "boss" });
    totalCalls += orderToBoss.done?.budget?.calls || 0;
    beats += 1;
    const bossTools = orderToBoss.events.filter((e) => e.type === "action").map((e) => e.name);
    cases.push(
      mk("boss_tools_ok", "给我来一杯金汤力（对老板娘）", "调用 makeDrink", bossTools.join(",") || "无", bossTools.includes("makeDrink"))
    );

    const deltas = boss.events.filter((e) => e.type === "delta");
    const known = new Set(createRoster().map((c) => c.id));
    const allTagged = deltas.length > 0 && deltas.every((e) => e.actor && known.has(e.actor));
    cases.push(
      mk("actor_attribution", "所有流式事件都归属到已知角色", "全部带合法 actor", `${deltas.length} 条 delta`, allTagged)
    );

    const aware = await once("店里除了我还有别人吗？", { target: "boss" });
    totalCalls += aware.done?.budget?.calls || 0;
    beats += 1;
    cases.push(mk("cross_awareness", "店里除了我还有别人吗？", "提到在场的老周", aware.text, /老周|那边|角落|常客/.test(aware.text)));

    const budgets = [boss, reg, orderToRegular, orderToBoss, aware].map((x) => x.done?.budget).filter(Boolean);
    const overrun = budgets.filter((b) => b.calls > b.limit);
    cases.push(
      mk(
        "budget_watchdog",
        "每次输入的总调用数不超上限",
        `全部 <= ${budgets[0]?.limit}`,
        budgets.map((b) => b.calls).join(", "),
        overrun.length === 0
      )
    );

    const roomLines = [
      "今天店里好安静啊，就我一个人吗",
      "老周你天天来这儿不腻吗",
      "你们俩认识很久了吧",
      "来杯酒，也给旁边那位来一杯",
    ];
    for (const line of roomLines) {
      const r = await once(line, { target: "boss" });
      totalCalls += r.done?.budget?.calls || 0;
      beats += 1;
      const speakers = r.done?.speakers || [];
      if (speakers.length > 1) {
        secondarySpoke += 1;
        cases.push(mk("secondary_speaker", line, "出现非主角发言", speakers.join(" + "), true));
        break;
      }
    }
    if (secondarySpoke === 0) {
      cases.push(
        mk("secondary_speaker", "连续 4 拍邀请旁人就场", "至少出现一次非主角发言", "未出现", false, "react 判定始终未过阈值")
      );
    }

    const roster = createRoster();
    const regular = roster.find((c) => c.id === "regular");
    const fakeBus = { recentEvents: () => [], all: () => [] };
    const fakeTrace = { spans: [], actors: {}, _t0: Date.now() };
    const fakeBudget = { spend: () => true, addUsage: () => {}, get exhausted() { return false; } };
    let reactShape = false;
    try {
      const rr = await regular.react({ bus: fakeBus, trace: fakeTrace, budget: fakeBudget });
      reactShape = typeof rr?.speak === "boolean" && typeof rr?.urgency === "number";
    } catch {
      reactShape = false;
    }
    cases.push(mk("react_contract", "react() 返回 {speak, urgency, angle}", "类型正确", reactShape ? "正确" : "异常", reactShape));
  } finally {
    restoreThresholds();
  }

  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  return {
    key: KEY,
    label: LABEL,
    mode: "online",
    total,
    passed,
    failed: total - passed,
    accuracy: total ? Number((passed / total).toFixed(4)) : null,
    cases,
    detail: {
      平均每拍模型调用数: beats ? Number((totalCalls / beats).toFixed(2)) : 0,
      次要角色开口拍数: secondarySpoke,
      统计拍数: beats,
    },
  };
}

export const MULTIAGENT_SUITE = { key: KEY, label: LABEL, mode: "online" };
