const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 2);
const RETRY_BASE_MS = Number(process.env.LLM_RETRY_BASE_MS || 400);

function getApiKey() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY。请复制 .env.example 为 .env 并填入你的 Key。");
  }
  return apiKey;
}

function modelName() {
  return process.env.DEEPSEEK_MODEL || "deepseek-chat";
}

function buildBody({ messages, tools, toolChoice, stream }) {
  const body = { model: modelName(), messages };
  if (stream) {
    body.stream = true;
    // 不开这个的话流末尾不会回传 usage，token 统计会一直是 0
    body.stream_options = { include_usage: true };
  }
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  }
  return body;
}

function isRetryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, apiKey) {
  return fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

export async function chatWithModel({ messages, tools, toolChoice }) {
  const apiKey = getApiKey();
  const body = buildBody({ messages, tools, toolChoice, stream: false });

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const t0 = Date.now();
    try {
      const res = await post(body, apiKey);
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`DeepSeek 接口返回 ${res.status}：${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      return {
        content: msg.content ?? "",
        tool_calls: msg.tool_calls,
        usage: data.usage ?? null,
        latencyMs: Date.now() - t0,
        model: body.model,
        attempts: attempt + 1,
      };
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || isRetryable(e.status);
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function* chatStream({ messages, tools, toolChoice }) {
  const apiKey = getApiKey();
  const body = buildBody({ messages, tools, toolChoice, stream: true });

  const t0 = Date.now();
  const res = await post(body, apiKey);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek 接口返回 ${res.status}：${text.slice(0, 300)}`);
  }
  const headersMs = Date.now() - t0;

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let ttftMs = null;
  let usage = null;
  let finishReason = null;
  const toolMap = new Map();

  const markFirstOutput = () => {
    if (ttftMs === null) ttftMs = Date.now() - t0;
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }

      // usage 单独占一个 choices 为空的块，得在判断 choice 之前取走，否则被下面的 continue 掉了
      if (data.usage) usage = data.usage;

      const choice = data.choices && data.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        markFirstOutput();
        content += delta.content;
        yield { kind: "delta", text: delta.content };
      }

      if (delta.tool_calls) {
        markFirstOutput();
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur =
            toolMap.get(idx) || {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            };
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.function.name = cur.function.name || tc.function.name;
          if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
          toolMap.set(idx, cur);
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  const tool_calls = toolMap.size ? [...toolMap.values()] : undefined;
  // 结果得等流结束再发，usage 是最后一个块才到的
  yield {
    kind: "result",
    message: { role: "assistant", content, tool_calls },
    usage,
    ttftMs,
    headersMs,
    latencyMs: Date.now() - t0,
    finishReason,
    model: body.model,
  };
}
