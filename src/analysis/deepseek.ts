import { requireDeepSeek } from "../config.js";
import type { DeepSeekAnalysis, DeepSeekUsage } from "../types.js";

const BASE_URL = "https://api.deepseek.com";
const MODEL = "deepseek-flash";

interface DeepSeekResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: DeepSeekUsage;
}

function parseJson(text: string): unknown {
  const fenced = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  const candidate = fenced?.[1]?.trim() ?? text.trim();

  try {
    return JSON.parse(candidate);
  } catch {}

  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");

  if (first >= 0 && last > first) {
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch {}
  }

  return { raw: text };
}

export async function analyzeWithDeepSeek(input: {
  address: string;
  contractName?: string;
  source: string;
  heuristicFindings: unknown[];
  maxSourceChars?: number;
}): Promise<DeepSeekAnalysis> {
  const apiKey = requireDeepSeek();

  // Keep the first AI pass economical. A later stage can analyze individual
  // functions more deeply after this screening pass.
  const source = input.source.slice(0, input.maxSourceChars ?? 60000);

  const system = [
    "You are a smart-contract security research assistant.",
    "This is authorized defensive code auditing.",
    "Analyze the supplied Solidity for concrete security weaknesses.",
    "Do not provide instructions for stealing funds from live protocols.",
    "Separate confirmed issues from hypotheses.",
    "Trace state changes, external calls, access control, accounting, oracle use, signatures, and upgradeability.",
    "Return a JSON object with exactly these top-level keys: summary, findings, manual_tests.",
    "findings must be an array of objects with: title, severity, confidence, functions, evidence, invariant_or_assumption, recommended_fix.",
    "manual_tests must be an array of strings.",
    "A suspicious pattern alone is not enough for a high-confidence finding."
  ].join(" ");

  const user = JSON.stringify({
    address: input.address,
    contractName: input.contractName ?? null,
    heuristicFindings: input.heuristicFindings,
    source
  });

  let response: Response;

  try {
    response = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: "low",
        thinking: { type: "enabled" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        max_tokens: 10000
      })
    });
  } catch (error) {
    throw new Error(
      "DeepSeek network request failed: " +
        (error instanceof Error ? error.message : String(error))
    );
  }

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      "DeepSeek request failed: HTTP " + response.status + " " + body
    );
  }

  let data: DeepSeekResponse;

  try {
    data = JSON.parse(body) as DeepSeekResponse;
  } catch {
    throw new Error("DeepSeek returned invalid JSON.");
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content;

  if (!content || !content.trim()) {
    const reasoningLength = choice?.message?.reasoning_content?.length ?? 0;
    throw new Error(
      "DeepSeek returned no final analysis content. finish_reason=" +
        (choice?.finish_reason ?? "unknown") +
        ", reasoning_chars=" +
        reasoningLength +
        ", raw_response=" +
        body.slice(0, 1500)
    );
  }

  return {
    result: parseJson(content),
    requestId: data.id,
    usage: data.usage
  };
}
