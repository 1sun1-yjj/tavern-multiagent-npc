
const DRINK_NAMES = /尼格罗尼|蓝色夏威夷|椰林飘香|血腥玛丽|自由古巴|古典鸡尾酒|大都会|白兰地|香槟|白葡萄酒|龙舌兰|金汤力/;
const DRINK_GENERIC = /鸡尾酒|调酒|酒|饮品|啤酒|咖啡|拿铁|美式/;
const ORDER_VERB = /来|要|给我|点|喝|续|上|整一/;

const CUSTOM = /定制|DIY|自由发挥|自己调|现场调|自定义|创一杯|特调一杯|你看着调|看着办|随便.{0,4}(调|来|做|上|弄)|(来|要|调|做|上).{0,4}特别的|特别一点的/;
const STOCK = /库存|缺(什么|料|货)|够不够|卖完|用完了|有什么(酒|饮品|喝的|推荐|好喝)|有啥(酒|推荐)|剩(什么|多少)|还有(什么|哪些)/;
const PAY = /多少钱|价格|结账|结帐|买单|埋单|付钱|付款|收钱|收费|多少块|小票/;

const ASKING = /怎么样|好喝吗|好不好喝|好喝么|好喝不|好喝(?!的)|是什么|为什么|为啥|推荐吗|值不值/;

const FOLLOW_ORDER = /(我|咱|俺|给我|给咱)(也|再|还要|也要)?(要|来|点|喝|续|上|整)(一|两|同|这|那|个|份|杯|瓶|壶|款)|(再|又)来(一|两)?(杯|瓶|壶|份)|续(一|两)?(杯|瓶|壶)|(跟|和|同)(他|她|你|那位|这位|老板|胡桃|钟离)(点|要|来)?(一样|同款)|同款|来(一|两)?杯(跟|和)?(他|她)?一样的/;

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
  if (ASKING.test(t)) {
    return { intent: null, tool: null };
  }
  if (DRINK_NAMES.test(t)) {
    return { intent: "order", tool: "makeDrink" };
  }
  if (DRINK_GENERIC.test(t) && ORDER_VERB.test(t)) {
    return { intent: "order", tool: "makeDrink" };
  }
  if (FOLLOW_ORDER.test(t)) {
    return { intent: "order", tool: "makeDrink" };
  }

  return { intent: null, tool: null };
}
