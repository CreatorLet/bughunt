import { requireDeepSeek } from "../config.js";
import type { DeepSeekAnalysis, DeepSeekUsage } from "../types.js";

const BASE_URL = "https://api.deepseek.com";
const MODEL = "deepseek-flash";
const MAX_SOURCE_CHARS = 100000;
const MAX_OUTPUT_TOKENS = 12000;

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

function parseJson(text: string): Record<string, unknown> {
  const fenced = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  const candidate = fenced?.[1]?.trim() ?? text.trim();

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {}

  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");

  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(candidate.slice(first, last + 1)) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }

  throw new Error("DeepSeek returned incomplete or invalid JSON.");
}

function buildSystemPrompt(compactRetry: boolean): string {
  const mode = compactRetry
    ? [
        "This is a compact retry because a previous response was truncated.",
        "Keep every field concise.",
        "Return at most 8 findings and at most 3 manual_tests.",
        "Do not repeat the source code in evidence.",
        "Use one or two sentences per finding field."
      ]
    : [
        "Perform a systematic and comprehensive defensive review.",
        "Look for as many concrete bugs as the supplied code supports."
      ];

  return [
    "You are Bughunt's deep smart-contract security researcher.",
    "Target chain: BSC (chainId 56). All runtime assumptions and manual tests must be BSC-specific.",
    "Review only the supplied contract/source and the supplied runtime context.",
    ...mode,
    "Reason about permissions, state transitions, accounting, token transfers, callbacks, external calls, oracle assumptions, signatures, upgradeability, initialization, rounding, precision, price manipulation, MEV-sensitive logic, denial of service, governance, and cross-function interactions.",
    "For each finding, trace how the issue could become financially exploitable or otherwise materially impactful.",
    "Separate confirmed code behavior from assumptions that require runtime verification.",
    "Do not call something a vulnerability merely because a privileged role can cause harm when compromised or because a standard ERC20 behavior is known. Classify those separately.",
    "Each finding must include finding_type: vulnerability, privileged-risk, deployment-risk, known-standard, informational, or false-positive.",
    "For direct vulnerabilities, explain an attacker path that does not assume the attacker already controls a privileged account unless the privilege itself is improperly obtainable.",
    "For privileged-risk or deployment-risk findings, explicitly state why they are not unprivileged contract exploits.",
    "Describe exploit paths at protocol-logic level only: attacker capability, prerequisites, relevant contract operations, violated invariant, and impact.",
    "Do not execute transactions or provide secrets/private keys. Manual tests must be local/fork-only and must not instruct the user to send transactions to a live RPC.",
    "Return JSON only.",
    "Top-level keys: summary, findings, manual_tests.",
    "summary must contain overall_assessment, key_risk_areas, source_coverage.",
    "Each finding must contain title, finding_type, category, severity, confidence, affected_functions, evidence, root_cause, attacker_capabilities, prerequisites, exploit_path, violated_invariant_or_assumption, impact, exploitability_assessment, recommended_fix.",
    "Severity must be one of critical, high, medium, low, informational.",
    "Confidence must be high, medium, or low.",
    "manual_tests must be concrete local/fork validation ideas and must use BSC chainId 56.",
    "Include false-positive notes when the heuristic layer is misleading."
  ].join(" ");
}

async function requestAnalysis(
  apiKey: string,
  user: string,
  compactRetry: boolean
): Promise<{
  result: Record<string, unknown>;
  requestId?: string;
  usage?: DeepSeekUsage;
  finishReason?: string | null;
}> {
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
          { role: "system", content: buildSystemPrompt(compactRetry) },
          { role: "user", content: user }
        ],
        max_tokens: MAX_OUTPUT_TOKENS
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
    throw new Error("DeepSeek returned invalid response JSON.");
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
    usage: data.usage,
    finishReason: choice?.finish_reason
  };
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
  const source = input.source.slice(0, input.maxSourceChars ?? MAX_SOURCE_CHARS);

  const user = JSON.stringify({
    chain: "BSC",
    chainId: "56",
    address: input.address,
    contractName: input.contractName ?? null,
    heuristicFindings: input.heuristicFindings,
    context: input.context ?? {},
    source
  });

  try {
    const first = await requestAnalysis(apiKey, user, false);

    if (first.finishReason !== "length") {
      return {
        result: first.result,
        requestId: first.requestId,
        usage: first.usage
      };
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("incomplete or invalid JSON")) {
      throw error;
    }
  }

  const retry = await requestAnalysis(apiKey, user, true);

  return {
    result: retry.result,
    requestId: retry.requestId,
    usage: retry.usage
  };
}
