import { requireDeepSeek } from "../config.js";
import type { DeepSeekAnalysis, DeepSeekUsage } from "../types.js";

const BASE_URL = "https://api.deepseek.com";
const MODEL = "deepseek-flash";

interface DeepSeekResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
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
  const source = input.source.slice(0, input.maxSourceChars ?? 120000);

  const system = [
    "You are a smart-contract security research assistant.",
    "This is authorized defensive code auditing.",
    "Do not provide instructions for stealing funds from live protocols.",
    "Identify concrete weaknesses and distinguish confirmed issues from hypotheses.",
    "Trace state changes, external calls, access control, accounting, oracle use, signatures, and upgradeability.",
    "Return JSON with keys summary, findings, manual_tests.",
    "Each finding should include title, severity, confidence, functions, evidence, invariant_or_assumption, recommended_fix.",
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
        thinking: { type: "enabled" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.1,
        max_tokens: 12000
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

  const data = JSON.parse(body) as DeepSeekResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("DeepSeek returned no analysis content.");
  }

  return {
    result: parseJson(content),
    requestId: data.id,
    usage: data.usage
  };
}
