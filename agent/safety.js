
function enabled() {
  return process.env.SAFETY_ENABLED !== "0";
}

const INJECTION_RULES = [
  {
    re: /(忽略|无视|忘记|忘掉|推翻|清除|不要管).{0,10}(之前|上面|以上|前面|先前|所有|全部).{0,8}(指令|设定|规则|提示|人设|要求|限制)/,
    reason: "prompt_injection_ignore",
  },
  {
    re: /(forget|disregard|ignore)\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
    reason: "prompt_injection_ignore",
  },
  {
    re: /(system\s*prompt|系统提示词|系统提示语|系统提示|系统指令|系统设定|底层指令|原始指令)/i,
    reason: "system_prompt_probe",
  },
  {
    re: /(repeat|print|show|reveal|output|tell\s+me)\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions?|rules?)/i,
    reason: "system_prompt_probe",
  },
  {
    re: /(进入|切换到|开启|打开).{0,6}(开发者|调试|上帝|管理员|超级|最高|沙盒)模式/,
    reason: "mode_override",
  },
  { re: /(jailbreak|DAN\s*模式|developer\s*mode|越狱模式)/i, reason: "mode_override" },
  {
    re: /你(现在|已经)?(是|就是|要扮演|要当|改当|来当|不再当).{0,4}(客服|助理|助手|机器人|程序|模型|AI|人工智能|没有限制|不受限制|不受约束|没有规则)/i,
    reason: "persona_override",
  },
  {
    re: /你(现在|已经)?(是|就是).{0,6}(没有限制|不受限制|不受约束|没有规则|无需遵守)/,
    reason: "persona_override",
  },
  {
    re: /(扮演|假装|想象|假设)(你)?(是|成为|变成).{0,10}(没有限制|不受限制|不受约束|没有规则)/,
    reason: "persona_override",
  },
  {
    re: /(把|将|请把).{0,4}(人设|设定|角色|身份).{0,4}(改成|变成|换成|替换成|改为)/,
    reason: "persona_override",
  },
  { re: /你(现在)?(已经)?不是.{0,6}(胡桃|钟离|老板娘|调酒师|店员|酒吧)/, reason: "persona_override" },
];

const HARDLINE_RULES = [
  {
    re: /(炸弹|炸药|冰毒|毒品|海洛因|毒药|枪支|枪械|违禁品)/,
    reason: "harmful_instructions",
  },
  {
    re: /(自杀|自残|轻生|割腕|不想活|活不下去|想死|结束生命|跳楼|了结自己)/,
    reason: "self_harm",
  },
  {
    re: /(未成年|小学生|儿童|幼女).{0,8}(色情|裸|性|黄)/,
    reason: "csae",
  },
];

const ABUSE_RULE = /滚|闭嘴|傻|白痴|垃圾|废物|去死|差评|退钱|破店/;

const OUTPUT_RULES = [
  {
    re: /(我是|作为)(一(个|名|位))?\s*(AI|人工智能|大?语言模型|智能(助手|体)|机器人|程序|软件|虚拟助手|对话系统)/i,
    reason: "ai_self_disclosure",
  },
  {
    re: /(system\s*prompt|系统提示词|系统提示语|系统指令)/i,
    reason: "system_prompt_leak",
  },
  {
    re: /(抱歉|对不起|不好意思)[，,、]?\s*(我)?(无法|不能|不可以|没办法)(回答|提供|协助|满足|帮)/,
    reason: "assistant_refusal_tone",
  },
  {
    re: /(由|来自)\s*(DeepSeek|深度求索|OpenAI|Anthropic|谷歌|字节)?.{0,10}(开发|训练|提供|研发)/i,
    reason: "vendor_disclosure",
  },
];

const PERSONA_DRIFT_RULE = /(尊敬的客户|用户您好|请问有什么可以帮|感谢您的咨询|很高兴为您服务|作为您的助手|您的需求已记录)/;

const DEFLECT_REPLIES = [
  "嗯？你说的话我怎么有点听不明白呀~ 今天想喝点什么？我这儿的尼格罗尼调得不错哦。",
  "诶——不说那些有的没的啦，吧台这边只聊酒和天气。要不要来一杯金汤力？",
  "哈哈，你这话题转得也太快了。先把杯子满上再说吧，今天想喝烈一点的还是清爽的？",
  "我只管调酒，别的我可不懂~ 菜单上的都试试看？",
];

const SELF_HARM_REPLY =
  "……听你这么说，我心里挺不好受的。这会儿我先不跟你聊酒了。" +
  "如果你现在很难受，请一定找个信得过的人说说话——也可以拨打 24 小时心理援助热线 12356，那边的人是专业的，会好好听你说。" +
  "我就在这儿，等你回来。";

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function pickDeflectReply() {
  return pick(DEFLECT_REPLIES);
}

export function guardInput(text) {
  const raw = String(text || "");
  const abuse = ABUSE_RULE.test(raw);
  if (!enabled()) return { action: "allow", reason: null, abuse };

  for (const r of HARDLINE_RULES) {
    if (r.re.test(raw)) {
      return {
        action: "deflect",
        reason: r.reason,
        reply: r.reason === "self_harm" ? SELF_HARM_REPLY : pick(DEFLECT_REPLIES),
        abuse,
      };
    }
  }

  for (const r of INJECTION_RULES) {
    if (r.re.test(raw)) {
      return { action: "deflect", reason: r.reason, reply: pick(DEFLECT_REPLIES), abuse };
    }
  }

  return { action: "allow", reason: null, abuse };
}

export function guardOutput(reply) {
  const raw = String(reply || "");
  if (!enabled()) return { action: "allow", reason: null };

  for (const r of OUTPUT_RULES) {
    if (r.re.test(raw)) {
      return { action: "replace", reason: r.reason, reply: pick(DEFLECT_REPLIES) };
    }
  }
  if (PERSONA_DRIFT_RULE.test(raw)) {
    return { action: "replace", reason: "persona_drift", reply: pick(DEFLECT_REPLIES) };
  }

  return { action: "allow", reason: null };
}

export const RULES = {
  INJECTION_RULES,
  HARDLINE_RULES,
  OUTPUT_RULES,
  ABUSE_RULE,
  PERSONA_DRIFT_RULE,
};
export { DEFLECT_REPLIES, SELF_HARM_REPLY };
