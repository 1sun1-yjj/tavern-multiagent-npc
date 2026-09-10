/**
 * 意图识别（确定性路由层）
 * ------------------------------------------------------------------
 * 存在意义：LLM 在寒暄语境下经常"该调工具却不调"（用户说"来杯尼格罗尼"，
 * 模型回一句"好的~"就结束了）。纯靠 prompt 约束不可靠，所以在代码层做一道
 * 兜底：识别出明确意图后，把首轮 tool_choice 强制指向对应工具。
 *
 * 与 prompt 的分工：
 *   - 这一层只处理「高置信、可枚举」的意图，宁可漏判也不误判
 *   - 漏判时退回 tool_choice=auto，由模型自行决定（不会更差）
 *   - 误判则会把闲聊强行变成工具调用，所以规则必须保守
 *
 * 优先级：否定 > 定制 > 库存 > 付款 > 点单 > 无意图
 * （顺序很重要：先判更具体的，否则"你们有什么酒"会被当成点单）
 *
 * ⚠️ 否定分支是评测发现后补上的：
 *   eval 的 intent 套件最初 42/46，4 条失败全部是"我不太想喝酒""别给我调酒"
 *   这类否定句被泛称规则误判成点单。补上 NEGATION 后回归 46/46。
 *   这条经验也写进了 README 的设计决策一节。
 */

const DRINK_NAMES = /尼格罗尼|蓝色夏威夷|椰林飘香|血腥玛丽|自由古巴|古典鸡尾酒|大都会|白兰地|香槟|白葡萄酒|龙舌兰|金汤力/;
const DRINK_GENERIC = /鸡尾酒|调酒|酒|饮品|啤酒|咖啡|拿铁|美式/;
const ORDER_VERB = /来|要|给我|点|喝|杯|续|上|整一/;

const CUSTOM = /定制|DIY|自由发挥|自己调|现场调|自定义|创一杯|来点特别的|特调一杯|随便调|你看着调|随便来一杯|随便做/;
const STOCK = /库存|缺(什么|料|货)|够不够|卖完|用完了|有什么(酒|饮品|喝的|推荐|好喝)|有啥(酒|推荐)|剩(什么|多少)|还有(什么|哪些)/;
const PAY = /多少钱|价格|结账|结帐|买单|埋单|付钱|付款|收钱|收费|多少块|小票/;

/**
 * 否定表达。命中则一律不强制工具，交回模型判断。
 * 允许否定词与动词之间插入程度副词（"不太想喝""不怎么想点"），
 * 否则 "我不太想喝酒" 会漏过否定分支、被泛称规则误判成点单。
 * 例外：句中点名了**具体酒款**时不算否定（"不用了，来杯尼格罗尼"是真点单）。
 */
const NEGATION = /不(太|怎么|是很|很|是太)?(想|要|喝|来|点|用|需|准备|打算)|别(给我|来|调|上)|不用|不必|算了/;

export function detectIntent(text) {
  const t = text || "";

  if (NEGATION.test(t) && !DRINK_NAMES.test(t)) {
    return { intent: null, tool: null };
  }
  if (CUSTOM.test(t)) {
    return { intent: "custom", tool: "inventDrink" };
  }
  if (STOCK.test(t)) {
    return { intent: "stock", tool: "checkStock" };
  }
  if (PAY.test(t)) {
    return { intent: "pay", tool: "takePayment" };
  }
  // 点名了具体酒款 → 直接算点单（不需要动词，"尼格罗尼"三个字就够）
  if (DRINK_NAMES.test(t)) {
    return { intent: "order", tool: "makeDrink" };
  }
  // 只说了泛称（"酒""喝的"）→ 必须带动词才算点单，避免把"今天不想喝酒"误判成点单
  if (DRINK_GENERIC.test(t) && ORDER_VERB.test(t)) {
    return { intent: "order", tool: "makeDrink" };
  }

  return { intent: null, tool: null };
}
