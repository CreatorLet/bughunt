import { requireDeepSeek } from "../config.js";
import type { DeepSeekAnalysis, DeepSeekUsage } from "../types.js";

const BASE_URL = "https://api.deepseek.com";
const MODEL = "deepseek-flash";
const DEFAULT_MAX_SOURCE_CHARS = 600000;
const MAX_OUTPUT_TOKENS = 6500;

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
        "This is a compact retry because the previous JSON was truncated.",
        "Return at most 4 findings and 2 manual_tests.",
        "Keep every field to one or two short sentences.",
        "Do not quote or repeat source code."
      ]
    : [
        "Perform a focused but deep defensive review.",
        "Prioritize concrete, externally reachable bugs supported by the supplied evidence."
      ];

  return [
    "You are Bughunt's smart-contract security researcher.",
    "Target chain: BSC (chainId 56).",
    "Review only the supplied source excerpt and runtime context.",
    "The supplied source may contain several related contracts and may be a focused excerpt when it exceeds the source budget; do not infer omitted code as fact.",
    "Treat cross-contract interactions as first-class evidence when the supplied bundle supports them.",
    ...mode,
    "Reason about authorization, state transitions, accounting, token transfers, callbacks, external calls, oracle assumptions, signatures, upgradeability, initialization, rounding, precision, price manipulation, MEV-sensitive logic, denial of service, governance, and cross-function interactions.",
    "For every direct vulnerability, identify an attacker path that does not assume control of an already-privileged account.",
    "Separate confirmed code behavior from assumptions requiring runtime or fork validation.",
    "Do not report a privileged capability as an unprivileged exploit. Classify it as privileged-risk when appropriate.",
    "Do not execute transactions or provide secrets/private keys. Manual tests must be local/fork-only.",
    "Return JSON only.",
    "Top-level keys: summary, findings, manual_tests.",
    "summary keys: overall_assessment, key_risk_areas, source_coverage.",
    "Each finding keys: title, finding_type, category, severity, confidence, affected_functions, evidence, root_cause, attacker_capabilities, prerequisites, exploit_path, violated_invariant_or_assumption, impact, exploitability_assessment, recommended_fix.",
    "finding_type must be vulnerability, privileged-risk, deployment-risk, known-standard, informational, or false-positive.",
    "severity must be critical, high, medium, low, or informational.",
    "confidence must be high, medium, or low.",
    "manual_tests must describe safe local/fork validation ideas only.",
    "Do not invent market statistics; use only the supplied market fields.",
    "Include false-positive notes when a heuristic can be misleading."
  ].join(" ");
}

remove comment strippingfunction buildFocusedSource(
  source: string,
  context: Record<string, unknown> | undefined,
  maxChars: number
): { source: string; coverage: string } {
  const cleaned = source;

  if (cleaned.length <= maxChars) {
    return {
      source: cleaned,
      coverage: "complete source within configured character limit"
    };
  }

  const surfaceNames = Array.isArray(context?.functionSurfaces)
    ? context.functionSurfaces
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object")
        )
        .map((item) => item.name)
        .filter((name): name is string => typeof name === "string")
    : [];

  const lines = cleaned.split(/\r?\n/);
  const selected = new Set<number>();

  // Keep the beginning because it usually contains imports, interfaces,
  // libraries, structs, state variables, events, modifiers, and headers.
  let baseChars = 0;
  for (
    let i = 0;
    i < lines.length && baseChars < Math.min(12000, maxChars);
    i++
  ) {
    selected.add(i);
    baseChars += (lines[i]?.length ?? 0) + 1;
  }

  for (const name of surfaceNames.slice(0, 8)) {
    const safeName = name.replace(/[^A-Za-z0-9_]/g, "\\$&");
    const matcher = new RegExp("\\bfunction\\s+" + safeName + "\\b");
    const index = lines.findIndex((line) => matcher.test(line));

    if (index < 0) continue;

    for (
      let i = Math.max(0, index - 2);
      i <= Math.min(lines.length - 1, index + 70);
      i++
    ) {
      selected.add(i);
    }
  }

  const ordered = [...selected].sort((a, b) => a - b);
  const chunks: string[] = [];
  let size = 0;

  for (const index of ordered) {
    const line = lines[index] ?? "";
    if (size + line.length + 1 > maxChars) break;
    chunks.push(line);
    size += line.length + 1;
  }

  return {
    source: chunks.join("\n"),
    coverage:
      "focused excerpt: contract header/state declarations plus selected public/interesting functions; omitted functions were not reviewed directly"
  };
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
    throw new Error(
      "DeepSeek returned no final analysis content. finish_reason=" +
        (choice?.finish_reason ?? "unknown") +
        ", reasoning_chars=" +
        (choice?.message?.reasoning_content?.length ?? 0)
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
  const maxSourceChars =
    input.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS;

  const focused = buildFocusedSource(
    input.source,
    input.context,
    maxSourceChars
  );

  const context = {
    ...(input.context ?? {}),
    sourceCoverage: focused.coverage,
    sourceCharactersSent: focused.source.length
  };

  const user = JSON.stringify({
    chain: "BSC",
    chainId: "56",
    address: input.address,
    contractName: input.contractName ?? null,
    heuristicFindings: input.heuristicFindings,
    context,
    source: focused.source
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
    if (
      !(error instanceof Error) ||
      !error.message.includes("incomplete or invalid JSON")
    ) {
      throw error;
    }
  }

  // Retry only when malformed/truncated JSON makes the result unusable.
  const retry = await requestAnalysis(apiKey, user, true);

  return {
    result: retry.result,
    requestId: retry.requestId,
    usage: retry.usage
  };
}
