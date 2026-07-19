// ShrimpX V2 — 業界シミュレーション CLI（差分） エントリポイント
//
// 画面（app/v2/industry-lab）とは別の名前空間として独立させている。
// app/lib/v2/industryLab/index.ts（画面向けバレル）からは意図的に
// re-exportしない — CLI固有のNode向けエントリ（scripts/v2Simulate.ts）
// だけがここから直接importする。

export * from "./types";
export * from "./scenarioAliases";
export * from "./argParser";
export * from "./output";
export { runCli } from "./runCli";
