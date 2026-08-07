// ShrimpX V2 — Phase SAI-3A: 自動テストプレイCLI エントリポイント
//
// companyLab/cli/index.tsと同じ方針。scripts/sai3aAutoplay.ts だけがここから
// 直接importする（他のautoplay/配下モジュールからのバレル経由の再輸出はしない）。

export * from "./types";
export * from "./argParser";
export { runAutoplayCli } from "./runCli";
export type { AutoplayCliOptions } from "./runCli";
