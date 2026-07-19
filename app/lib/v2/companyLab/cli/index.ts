// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） CLI エントリポイント
//
// 画面（app/v2/company-lab）とは別の名前空間として独立させている。
// app/lib/v2/companyLab/index.ts（画面向けバレル）からは意図的に
// re-exportしない — CLI固有のNode向けエントリ（scripts/v2CompanySimulate.ts）
// だけがここから直接importする。

export * from "./types";
export * from "./argParser";
export * from "./output";
export { runCompanyLabCli } from "./runCli";
