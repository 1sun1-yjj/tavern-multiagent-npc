export const LEVELS = [
  { min: 100, name: "挚友", tone: "无话不谈、会为你破例" },
  { min: 50,  name: "熟客", tone: "记得你爱喝的、语气热络" },
  { min: 20,  name: "眼熟", tone: "开始记住你的偏好、更主动" },
  { min: 0,   name: "生客", tone: "客气而礼貌、一视同仁" },
];

export const MOODS = [
  { min: 60,  name: "超开心", emoji: "😄" },
  { min: 20,  name: "开心",   emoji: "😊" },
  { min: -20, name: "平静",   emoji: "😌" },
  { min: -60, name: "有点低落", emoji: "😔" },
  { min: -999, name: "心情很差", emoji: "😞" },
];

export function getLevel(affinity) {
  return LEVELS.find((l) => affinity >= l.min) || LEVELS[LEVELS.length - 1];
}
export function getMood(mood) {
  return MOODS.find((m) => mood >= m.min) || MOODS[MOODS.length - 1];
}

export function hearts(affinity) {
  return Math.max(0, Math.min(5, Math.floor((affinity || 0) / 20)));
}

export function updateGameState(profile, s) {
  let aff = 0;
  let mood = 0;

  if (s.ordered) { aff += 5; mood += 8; }
  if (s.paid)    { aff += 3; mood += 3; }
  if (s.saidName){ aff += 8; mood += 4; }
  if (s.friendly){ aff += 2; mood += 5; }
  if (s.rude)    { aff -= 6; mood -= 12; }
  if (profile.orderCount > 1) mood += 1;

  const before = getLevel(profile.affinity || 0);
  profile.affinity = (profile.affinity || 0) + aff;
  profile.mood = Math.max(-100, Math.min(100, (profile.mood || 0) + mood));
  const after = getLevel(profile.affinity);

  return {
    levelUp: after.min > before.min,
    levelName: after.name,
    moodName: getMood(profile.mood).name,
    moodEmoji: getMood(profile.mood).emoji,
    hearts: hearts(profile.affinity),
  };
}

export function detectEasterEgg(userText, profile) {
  const t = userText || "";

  if (/我喜欢你|做我女朋友|做我对象|嫁给我|结婚|交往|表白|当你的人/.test(t)) {
    return {
      triggered: "confession",
      hint: "顾客突然向你表白了。请你温柔而坚定地婉拒：感谢他的心意，但你们是酒吧老板和客人的关系，把话题自然拉回调酒/天气，别给希望也别伤人。",
    };
  }

  const level = getLevel(profile.affinity || 0);
  if ((/隐藏菜单|特调|隐藏饮品|秘密菜单/.test(t))) {
    if (level.min >= 50) {
      return {
        triggered: "secret",
        hint: `顾客是${level.name}，点了隐藏特调。今天破例为他调一杯「老板娘特调」：用店里最好的基酒加一点私藏配方，随口编一句不常见的做法，并俏皮地说“这杯可不轻易给外人”。`,
      };
    }
    return {
      triggered: "lockedSecret",
      hint: "顾客问起了隐藏菜单，但你们还不太熟。你笑着卖个关子：要多来几次、成为熟客才能解锁。别真的做，也别点破具体门槛。",
    };
  }

  return { triggered: null, hint: "" };
}

export function buildGameRules(profile) {
  const level = getLevel(profile.affinity || 0);
  const mood = getMood(profile.mood || 0);
  const lines = [
    "【你的游戏状态】",
    `- 好感度：${level.name}（${level.tone}）。`,
    `- 你此刻心情：${mood.name}，所以${mood.name === "平靜" || mood.name === "开心" ? "说话更轻快" : "情绪外露、措辞受影响"}。`,
  ];
  if (level.min >= 100) lines.push("- 达成「挚友」：你可以给这位顾客一点特殊优待，比如小折扣或偶尔的隐藏特调。");
  else if (level.min >= 50) lines.push("- 达成「熟客」：当他问起隐藏菜单，你可以松口做一杯特调。");
  else lines.push("- 关系尚浅：隐藏菜单先卖个关子，别轻易解锁。");
  lines.push("- 若顾客表白：温柔坚定地婉拒，把话题拉回调酒。");
  return lines.join("\n");
}

export function snapshot(profile) {
  const level = getLevel(profile.affinity || 0);
  const mood = getMood(profile.mood || 0);
  return {
    affinity: profile.affinity || 0,
    levelName: level.name,
    moodName: mood.name,
    moodEmoji: mood.emoji,
    hearts: hearts(profile.affinity || 0),
  };
}
