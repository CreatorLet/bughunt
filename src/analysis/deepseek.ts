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
  context?: Record<string, unknown>;
}): Promise<DeepSeekAnalysis> {
  const apiKey = requireDeepSeek();

  // Keep the first AI pass economical. A later stage can analyze individual
  // functions more deeply after this screening pass.
  const source = input.source.slice(0, input.maxSourceChars ?? 60000);

  const system = [
    "You are Bughunt's deep smart-contract security researcher.",
    "Perform a systematic defensive review of the supplied Solidity contract.",
    "Look for as many concrete bugs as the code supports, not merely the obvious pattern matches.",
    "Reason about permissions, state transitions, accounting, token transfers, callbacks, external calls, oracle assumptions, signatures, upgradeability, initialization, rounding, precision, price manipulation, MEV-sensitive logic, denial of service, governance, and cross-function interactions.",
    "For each finding, trace how the bug could become financially exploitable or otherwise materially impactful.",
    "Separate confirmed code behavior from assumptions that require runtime verification.",
    "Describe an exploit path at the protocol-logic level: attacker capability, prerequisites, relevant contract operations, violated invariant, and impact.",
    "Do not execute transactions or provide secrets/private keys. This is authorized defensive research and local/fork testing.",
    "Do not claim a pattern is a vulnerability without tracing reachability and impact.",
    "Return JSON only.",
    "Top-level keys: summary, findings, manual_tests.",
    "summary must contain overall_assessment, key_risk_areas, source_coverage.",
    "Each finding must contain title, category, severity, confidence, affected_functions, evidence, root_cause, attacker_capabilities, prerequisites, exploit_path, violated_invariant_or_assumption, impact, exploitability_assessment, recommended_fix.",
    "Severity must be one of critical, high, medium, low, informational.",
    "Confidence must be high, medium, or low.",
    "manual_tests must be concrete local/fork validation ideas.",
    "Include false-positive notes when the heuristic layer is misleading."
  ].join(" ");

  const user = JSON.stringify({
    address: input.address,
    contractName: input.contractName ?? null,
    heuristicFindings: input.heuristicFindings,
    context: input.context ?? {},
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
