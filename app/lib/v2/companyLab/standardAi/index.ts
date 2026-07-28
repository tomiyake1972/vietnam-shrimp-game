// ShrimpX V2 — 標準AI（SAI-1）公開エントリポイント
//
// 外部（CLI・将来のUI・テスト）からはこのファイル経由で参照する。
// standardAi/ 配下の各ファイルへの直接importは、テストコード以外では避ける。

export type {
  StandardAiReasonCode,
  StandardAiReasonEntry,
  StandardAiDecisionDiagnostics,
  StandardAiDecisionResult,
  StandardAiConfig,
} from "./types";
export { DEFAULT_STANDARD_AI_CONFIG_V1 } from "./config";
export type { StandardAiObservation, StandardAiFactoryObservation } from "./observation";
export { buildStandardAiObservation } from "./observation";
export { computeStandardAiDecision } from "./policy";
export { generateStandardAiDecision, createStandardAiDecisionProviderWithDiagnostics } from "./provider";
