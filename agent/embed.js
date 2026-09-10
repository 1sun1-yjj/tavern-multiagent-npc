const EMBED_URL = "https://api.siliconflow.cn/v1/embeddings";

export async function embedTexts(texts) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey || apiKey.includes("xxxx")) {
    throw new Error("缺少 SILICONFLOW_API_KEY（向量记忆未启用）。");
  }
  const model = process.env.SILICONFLOW_EMBED_MODEL || "BAAI/bge-m3";

  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`SiliconFlow embedding 返回 ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export function vectorEnabled() {
  const k = process.env.SILICONFLOW_API_KEY;
  return Boolean(k && !k.includes("xxxx"));
}
