import { createHash } from "node:crypto";
import type {
  ContractAddressCandidate,
  ContractSourceBundle,
  ContractResearch
} from "../types.js";

export interface SourceBundleInput {
  address: string;
  contractName?: string;
  role?: ContractAddressCandidate["role"];
  relation?: ContractAddressCandidate["relation"];
  report?: Pick<ContractResearch, "sourceCode" | "sourceQuality" | "sourceFiles">;
  source?: string;
  sourceQuality?: ContractResearch["sourceQuality"];
  sourceFiles?: string[];
}

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function buildSourceBundle(
  inputs: SourceBundleInput[],
  maxChars = 1_200_000
): ContractSourceBundle | undefined {
  const contracts: ContractSourceBundle["contracts"] = [];
  const files = new Set<string>();
  const contractNames = new Set<string>();
  const seenAddresses = new Set<string>();
  const seenSources = new Set<string>();
  const chunks: string[] = [];
  let size = 0;

  for (const input of inputs) {
    const address = input.address.trim();
    const source = input.source ?? input.report?.sourceCode ?? "";
    if (!/^0x[a-fA-F0-9]{40}$/.test(address) || !source.trim()) continue;

    const addressKey = address.toLowerCase();
    if (seenAddresses.has(addressKey)) continue;

    const hash = sourceHash(source);
    const sourceFiles = input.sourceFiles ?? input.report?.sourceFiles ?? [];

    contracts.push({
      address,
      contractName: input.contractName,
      role: input.role,
      relation: input.relation,
      sourceQuality: input.sourceQuality ?? input.report?.sourceQuality,
      sourceFiles
    });
    seenAddresses.add(addressKey);

    if (seenSources.has(hash)) continue;

    const header =
      "// ===== CONTRACT " +
      address +
      " " +
      (input.contractName ?? "") +
      " =====\n";
    const block = header + source.trim() + "\n";

    if (size + block.length > maxChars) {
      return chunks.length
        ? {
            source: chunks.join("\n"),
            sourceCharacters: size,
            coverage: "partial",
            contracts,
            files: [...files],
            contractNames: [...contractNames]
          }
        : undefined;
    }

    chunks.push(block);
    size += block.length;
    seenSources.add(hash);

    for (const file of sourceFiles) files.add(file);
  }

  if (!chunks.length) return undefined;

  return {
    source: chunks.join("\n"),
    sourceCharacters: size,
    coverage: "complete",
    contracts,
    files: [...files],
    contractNames: [...contractNames]
  };
}
