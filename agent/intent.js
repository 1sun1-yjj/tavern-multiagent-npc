// 模型经常在该调工具的时候只回一句"好嘞~"，所以加一层确定性路由：
// 认出来就把首轮 tool_choice 强制指过去，认不出来返回 null 交给模型自己决定。
// 规则刻意保守——误判会把闲聊变成工具调用，比漏判更糟。

const DRINK_NAMES = /尼格罗尼|蓝色夏威夷|椰林飘香|血腥玛丽|自由古巴|古典鸡尾酒|大都会|白兰地|香槟|白葡萄酒|龙舌兰|金汤力/;
const DRINK_GENERIC = /鸡尾酒|调酒|酒|饮品|啤酒|咖啡|拿铁|美式/;
const ORDER_VERB = /来|要|给我|点|喝|杯|续|上|整一/;

const CUSTOM = /定制|DIY|自由发挥|自己调|现场调|自定义|创一杯|来点特别的|特调一杯|随便调|你看着调|随便来一杯|随便做/;
const STOCK = /库存|缺(什么|料|货)|够不够|卖完|用完了|有什么(酒|饮品|喝的|推荐|好喝)|有啥(酒|推荐)|剩(什么|多少)|还有(什么|哪些)/;
const PAY = /多少钱|价格|结账|结帐|买单|埋单|付钱|付款|收钱|收费|多少块|小票/;

// 中间那个可选组是用来兜"我不太想喝酒"这种插了副词的句子
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
  if (DRINK_NAMES.test(t)) {
    return { intent: "order", tool: "makeDrink" };
  }
  // 泛称得配动词才算点单，不然"今天不想喝酒"会被算成点单
  if (DRINK_GENERIC.test(t) && ORDER_VERB.test(t)) {
    return { intent: "order", tool: "makeDrink" };
  }

  return { intent: null, tool: null };
}
