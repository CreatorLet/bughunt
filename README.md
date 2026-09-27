# Bughunt

Bughunt is a BSC-first smart-contract security research assistant.

The first version combines DeFiLlama for protocol discovery, Etherscan V2 for verified source and ABI, GoPlus for security signals, local Solidity heuristics, and DeepSeek V4.1-Flash for deeper code reasoning.

## Setup

1. Clone the repository.
2. Run npm install.
3. Copy .env.example to .env.
4. Add your Etherscan, GoPlus, and DeepSeek credentials.
5. Run npm run typecheck.

## Commands

Discover small BSC protocols:

npm run dev -- discover --min-tvl 50000 --max-tvl 1000000 --limit 20

Inspect a DeFiLlama protocol:

npm run dev -- protocol <slug>

Analyze a BSC contract using source, ABI, GoPlus, and local heuristics:

npm run dev -- analyze --address 0xYOUR_CONTRACT

Add DeepSeek analysis after the inexpensive screening stages:

npm run dev -- analyze --address 0xYOUR_CONTRACT --ai

## Pipeline

DeFiLlama → BSC candidate discovery → Etherscan source/ABI → local heuristics → GoPlus security signals → optional DeepSeek analysis.

The design deliberately keeps the AI step last so the DeepSeek credit is used on contracts that have already passed cheaper filters.

## Current scope

This version is reconnaissance and defensive auditing only. It does not send transactions, interact with wallets, or execute exploit logic against live contracts.

The AI output should be treated as a research hypothesis until a finding is independently reproduced and validated in an authorized test environment.

## Next stages

Automatic contract discovery from protocol metadata; proxy implementation resolution; transaction/token-transfer graphs; Slither or Aderyn integration; protocol-specific invariant checks; Foundry fork tests; caching and a small web dashboard.
