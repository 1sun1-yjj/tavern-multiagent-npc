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

const LIGHT_MOODS = new Set(["超开心", "开心", "平静"]);

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
      hint: "顾客向你表白了。这一条不能顺——明确婉拒，别给希望也别伤人；婉拒之后把话头自然带走。具体措辞按你自己的性格来。",
    };
  }

  const level = getLevel(profile.affinity || 0);
  if ((/隐藏菜单|特调|隐藏饮品|秘密菜单/.test(t))) {
    if (level.min >= 50) {
      return {
        triggered: "secret",
        hint: `顾客是${level.name}，问起了隐藏菜单——今天可以为他破例。别报酒单上的常规款，用你压箱底的基酒和他记得的口味，现场调一杯没写进酒单的东西：名字你自己起，做法你自己编，端上去的时候让他感到这一杯不是谁都能点到的。`,
      };
    }
    return {
      triggered: "lockedSecret",
      hint: "顾客问起了隐藏菜单，但你们还不太熟。这一杯现在不给：别真的做，也别点破门槛具体是多少，把话岔开就好。",
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
    `- 你此刻心情：${mood.name}，所以${LIGHT_MOODS.has(mood.name) ? "说话更轻快" : "情绪外露、措辞受影响"}。`,
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
