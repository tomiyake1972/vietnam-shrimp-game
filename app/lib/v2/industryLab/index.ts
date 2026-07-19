// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） エントリポイント
//
// Redis・API Route・外部サービスに一切依存しない純粋なTypeScriptモジュール。
// Client Componentから直接importして問題ない（"../market"・"../scenario"の
// 安全な公開口のみに依存し、app/lib/v2/index.ts の一括importは使わない）。

export * from "./types";
export * from "./assumptions";
export { findScenarioDefinition, initializeIndustrySimulation, advanceIndustrySimulation, runIndustrySimulation } from "./simulationRunner";
export * from "./ui";
