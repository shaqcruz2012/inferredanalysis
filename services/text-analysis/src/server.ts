/**
 * Text Analysis API - Backend service on port 9000
 *
 * Handles:
 *   POST /summarize       → $0.25  High-volume summarization (Haiku)
 *   POST /brief           → $2.50  Structured brief (Haiku)
 *   POST /brief-premium   → $15.00 Deep-dive analysis (Sonnet)
 *   POST /analyze         → $0.01  Sentiment/entity/keyword extraction (Haiku)
 *   GET  /health          → Health check
 *
 * The x402 gateway on port 7402 handles payment verification and proxies here.
 * This service only does inference — no payment logic.
 *
 * Supports Anthropic and OpenAI. Set one of:
 *   ANTHROPIC_API_KEY=... npx tsx src/server.ts
 *   OPENAI_API_KEY=...   npx tsx src/server.ts
 */
import http from "http";
import { ulid } from "ulid";

const PORT = parseInt(process.env.TEXT_ANALYSIS_PORT ?? "9000", 10);
const startTime = Date.now();

// ── Types ────────────────────────────────────────────────────────────

interface TierConfig {
  systemPrompt: string;
  model: string;
  maxOutputTokens: number;
  maxInputTokens: number;
}

interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

// ── Provider Detection ───────────────────────────────────────────────

type Provider = "anthropic" | "openai";

function detectProvider(): { provider: Provider; apiKey: string } {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) return { provider: "anthropic", apiKey: anthropicKey };

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) return { provider: "openai", apiKey: openaiKey };

  throw new Error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY");
}

// Model mapping: Anthropic → OpenAI equivalents
const OPENAI_MODEL_MAP: Record<string, string> = {
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
  "claude-sonnet-4-20250514": "gpt-4o",
};

// ── Tier Definitions ─────────────────────────────────────────────────

const TIERS: Record<string, TierConfig> = {
  "/summarize": {
    systemPrompt:
      "You are a concise summarizer. Produce a clear, structured summary of the provided content. " +
      "Use bullet points for key takeaways. Keep it under 500 words.",
    model: "claude-haiku-4-5-20251001",
    maxOutputTokens: 2048,
    maxInputTokens: 4000,
  },
  "/brief": {
    systemPrompt:
      "You are a business analyst. Produce a structured brief with these sections:\n" +
      "## Key Findings\n## Risks & Concerns\n## Recommendations\n\n" +
      "Be thorough but concise. Support findings with evidence from the source material.",
    model: "claude-haiku-4-5-20251001",
    maxOutputTokens: 4096,
    maxInputTokens: 16000,
  },
  "/brief-premium": {
    systemPrompt:
      "You are a senior strategy consultant. Produce a comprehensive deep-dive analysis with these sections:\n" +
      "## Executive Summary\n## Key Findings\n## Competitive Landscape\n" +
      "## Risk Assessment\n## Strategic Recommendations\n## Action Items\n\n" +
      "Be thorough, cite specific evidence, and provide actionable insights.",
    model: "claude-sonnet-4-20250514",
    maxOutputTokens: 8192,
    maxInputTokens: 64000,
  },
  "/analyze": {
    systemPrompt:
      "You are a text analyst. Analyze the provided text and return a JSON object with these fields:\n" +
      '  "sentiment": "positive" | "negative" | "neutral" | "mixed",\n' +
      '  "confidence": 0.0-1.0,\n' +
      '  "entities": [{"name": "...", "type": "person|org|place|product|other"}],\n' +
      '  "keywords": ["..."],\n' +
      '  "summary": "One-sentence summary"\n\n' +
      "Return ONLY valid JSON, no markdown fences.",
    model: "claude-haiku-4-5-20251001",
    maxOutputTokens: 1024,
    maxInputTokens: 2000,
  },
};

// ── LLM Callers ──────────────────────────────────────────────────────

const llmConfig = detectProvider();

async function callLLM(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<LLMResponse> {
  if (llmConfig.provider === "openai") {
    const resolvedModel = OPENAI_MODEL_MAP[model] ?? "gpt-4o-mini";
    return callOpenAI(resolvedModel, systemPrompt, userContent, maxTokens);
  }
  return callAnthropic(model, systemPrompt, userContent, maxTokens);
}

async function callOpenAI(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<LLMResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const text = (message?.content as string | undefined)?.trim() ?? "";

    if (!text) throw new Error("Empty response from OpenAI");

    const usage = data.usage as Record<string, number> | undefined;
    return {
      content: text,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      model,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<LLMResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": llmConfig.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    type ContentBlock = { type: string; text?: string };
    const blocks = Array.isArray(data.content)
      ? (data.content as ContentBlock[])
      : [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
      .trim();

    if (!text) throw new Error("Empty response from Anthropic");

    const usage = data.usage as Record<string, number> | undefined;
    return {
      content: text,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      model,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── HTTP Helpers ─────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; req.destroy(); reject(new Error("Body read timeout")); }
    }, 15_000);
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > 1_048_576) { done = true; clearTimeout(timer); req.destroy(); reject(new Error("Body too large")); return; }
      body += chunk;
    });
    req.on("end", () => { if (!done) { done = true; clearTimeout(timer); resolve(body); } });
    req.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}

function log(level: string, msg: string, ctx?: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), level, module: "text-analysis", message: msg, ...ctx }) + "\n",
  );
}

// ── Server ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const urlPath = (req.url ?? "/").split("?")[0];
  const requestId = ulid();

  if (method === "OPTIONS") { json(res, 204, ""); return; }

  // Health check
  if (urlPath === "/health" && method === "GET") {
    json(res, 200, {
      status: "healthy",
      service: "text-analysis",
      port: PORT,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Tier endpoints
  const tier = TIERS[urlPath];
  if (!tier) { json(res, 404, { error: "Unknown endpoint", request_id: requestId }); return; }
  if (method !== "POST") { json(res, 405, { error: "Use POST", request_id: requestId }); return; }

  // Parse body
  let content: string;
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw);
    content = typeof parsed.content === "string" ? parsed.content : "";
  } catch {
    json(res, 400, { error: "Invalid JSON body. Expected { \"content\": \"...\" }", request_id: requestId });
    return;
  }

  if (!content.trim()) {
    json(res, 400, { error: "content field is required and must be non-empty", request_id: requestId });
    return;
  }

  // Token limit check (rough estimate: 1 token ≈ 4 chars)
  const estimatedTokens = Math.ceil(content.length / 4);
  if (estimatedTokens > tier.maxInputTokens) {
    json(res, 413, {
      error: `Input too large: ~${estimatedTokens} tokens exceeds ${tier.maxInputTokens} limit`,
      request_id: requestId,
    });
    return;
  }

  log("info", `Request ${urlPath}`, { request_id: requestId, estimated_tokens: estimatedTokens });

  // Call LLM
  try {
    const result = await callLLM(tier.model, tier.systemPrompt, content, tier.maxOutputTokens);

    log("info", "Success", {
      request_id: requestId,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
    });

    json(res, 200, {
      result: result.content,
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      request_id: requestId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "LLM call failed", { request_id: requestId, error: msg });
    json(res, 502, { error: "Inference failed. Please try again.", request_id: requestId });
  }
});

server.headersTimeout = 10_000;
server.requestTimeout = 120_000;

server.listen(PORT, () => {
  log("info", `Text Analysis API listening on port ${PORT}`);
  log("info", `Endpoints: ${Object.keys(TIERS).join(", ")}`);
  log("info", `LLM: ${llmConfig.provider} (key set)`);
});

server.on("error", (err) => {
  log("error", `Server error: ${err.message}`);
  process.exit(1);
});

process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT", () => { server.close(() => process.exit(0)); });

export { server };
