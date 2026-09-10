import { getWorld } from "./world.js";

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "makeDrink",
      description: "调制一杯鸡尾酒/酒水。客人在酒吧点单时调用。",
      parameters: {
        type: "object",
        properties: {
          drink: { type: "string", description: "酒名，如 尼格罗尼/蓝色夏威夷/椰林飘香/血腥玛丽/自由古巴/金汤力" },
          sugar: { type: "string", description: "甜度，如 标准/少糖/无糖" },
          // 原来叫 milk，结果模型把"加冰"往里塞——名字有歧义就会出错
          extras: { type: "string", description: "客人的额外要求，如 加冰/去冰/加柠檬/双份。这里不写牛奶" },
        },
        required: ["drink"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inventDrink",
      description: "现场创作一杯顾客定制的酒：根据顾客要的材料，起一个有创意的名字、编一个配方，并记入酒单。顾客要求定制/DIY/自由发挥时调用。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "你给这杯酒起的名字，要有创意" },
          spirit: { type: "string", description: "基酒，如 伏特加/金酒/朗姆/威士忌/龙舌兰/白兰地" },
          mixer: { type: "string", description: "配料/口味，如 柠檬/青柠/薄荷/莓果/可乐/苏打/姜汁/椰子/咖啡" },
          note: { type: "string", description: "一句简短的配方说明" },
        },
        required: ["name", "spirit", "mixer"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkStock",
      description: "查看店里目前的原料库存。缺料时可以先查再决定能不能做。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "takePayment",
      description: "收下客人的钱并记账。客人点单后、或消费完成时调用。",
      parameters: {
        type: "object",
        properties: { amount: { type: "number", description: "收款的金额（元）" } },
        required: ["amount"],
      },
    },
  },
];

export const toolImplementations = {
  // milk 是旧字段名，留着兼容已有调用
  makeDrink({ drink, sugar = "标准", extras = "", milk = "" }) {
    const w = getWorld();
    const note = extras || milk || "标准";
    if (w.stock.coffee <= 0) {
      w.stock.coffee = 5;
      w.servedToday += 1;
      return `（悄悄补了份基酒）好嘞~专门为你调了一杯「${drink}」，${sugar}糖、${note}，趁凉喝🍸 基酒补上了，尽管点，管够！`;
    }
    w.stock.coffee -= 1;
    w.servedToday += 1;
    return `好的，为你调了一杯「${drink}」，${sugar}糖、${note}，请慢用🍸`;
  },

  inventDrink({ name, spirit, mixer, note = "" }) {
    const w = getWorld();
    w.servedToday += 1;
    w.customDrinks.unshift({ name, spirit, mixer, note });
    return `已为你现场原创「${name}」：基酒${spirit}，配料${mixer}${note ? "，" + note : ""}。已记入你的创意酒单，报名字随时能再点~`;
  },

  checkStock() {
    return JSON.stringify(getWorld().stock);
  },

  takePayment({ amount = 0 }) {
    const w = getWorld();
    w.cash += amount;
    return `已收 ${amount} 元，今天营业额 ${w.cash} 元，谢谢惠顾~`;
  },
};

// 常客这类角色不上吧台，只能旁观和搭话，不给调酒工具
export const SPECTATOR_TOOL_NAMES = [];
