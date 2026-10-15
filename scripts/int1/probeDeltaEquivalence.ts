/**
 * 【FOT-1 前提の検証】差分追記（append）で積み上げた dataset / pack が、
 * 毎回全量を送って保存した場合と**完全に同一**になることを確かめる。
 *
 * これが成り立たないと、AI Analysis Pack の出力が改修前と変わってしまう
 * （依頼書の受け入れ条件）。設計の前提なので、クライアント実装の前に確認する。
 *
 * 共有 Redis へは接続しない。
 */
import { createSimulationSession, advanceSimulationTurn } from "../../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../../app/lib/v2/companyLab/simulation/analytics/dataset";
import {
  maxTurnOfSimulationRunPart,
  mergeSimulationRunPart,
  sliceSimulationRunPartAfterTurn,
} from "../../app/lib/v2/companyLab/simulation/persistence/partWire";
import type { CompanyControlMode } from "../../app/lib/v2/companyLab/simulation/types";

const AT = "2026-10-15T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const MODES: Readonly<Record<string, CompanyControlMode>> = Object.fromEntries(
  COMPANIES.map((c) => [c, "PLAYER" as CompanyControlMode])
);
const TOTAL_TURNS = 32;

function main(): void {
  let session = createSimulationSession({
    simulationRunId: "fot1-delta",
    scenarioId: "baseline",
    seed: "fot1-delta",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
    sourceCommit: "FOT1",
    companyControlModes: MODES,
    salesModelId: "tiered-v200-crowding-v1",
  });

  // サーバー側に「公開済み」として積み上がっていく値。
  let publishedDataset: unknown = undefined;
  let publishedPack: unknown = undefined;
  let publishedMaxDatasetTurn = -1;
  let publishedMaxPackTurn = -1;

  let firstDatasetMismatch: number | null = null;
  let firstPackMismatch: number | null = null;

  for (let turn = 1; turn <= TOTAL_TURNS; turn += 1) {
    const outcome = advanceSimulationTurn(session, AT, {}, "FOT1");
    if (!outcome.session) {
      console.log(`# Turn ${turn} で進行が止まった: ${outcome.error?.message ?? "理由不明"}`);
      return;
    }
    session = outcome.session;

    const fullDataset = buildDatasetFromSession(session);
    const fullPack = { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns };

    // --- dataset ---
    if (publishedDataset === undefined) {
      publishedDataset = fullDataset; // 初回は全量送信（クライアントも同じ判断をする）
    } else {
      const delta = sliceSimulationRunPartAfterTurn("dataset", fullDataset, publishedMaxDatasetTurn);
      publishedDataset = mergeSimulationRunPart("dataset", publishedDataset, delta);
    }
    publishedMaxDatasetTurn = maxTurnOfSimulationRunPart("dataset", publishedDataset);
    if (firstDatasetMismatch === null && JSON.stringify(publishedDataset) !== JSON.stringify(fullDataset)) {
      firstDatasetMismatch = turn;
    }

    // --- pack ---
    if (publishedPack === undefined) {
      publishedPack = fullPack;
    } else {
      const delta = sliceSimulationRunPartAfterTurn("pack", fullPack, publishedMaxPackTurn);
      publishedPack = mergeSimulationRunPart("pack", publishedPack, delta);
    }
    publishedMaxPackTurn = maxTurnOfSimulationRunPart("pack", publishedPack);
    if (firstPackMismatch === null && JSON.stringify(publishedPack) !== JSON.stringify(fullPack)) {
      firstPackMismatch = turn;
    }
  }

  console.log("# FOT-1 差分追記の等価性（JSON文字列として完全一致するか）");
  console.log(`dataset: ${firstDatasetMismatch === null ? "全32Turnで一致" : `Turn ${firstDatasetMismatch} で初めて不一致`}`);
  console.log(`pack   : ${firstPackMismatch === null ? "全32Turnで一致" : `Turn ${firstPackMismatch} で初めて不一致`}`);

  if (firstDatasetMismatch !== null) {
    const full = buildDatasetFromSession(session) as unknown as Record<string, unknown>;
    const merged = publishedDataset as Record<string, unknown>;
    console.log("");
    console.log("# dataset のフィールド別比較（T32）");
    for (const key of Object.keys(full)) {
      const same = JSON.stringify(full[key]) === JSON.stringify(merged[key]);
      const lenFull = Array.isArray(full[key]) ? (full[key] as unknown[]).length : "-";
      const lenMerged = Array.isArray(merged[key]) ? (merged[key] as unknown[]).length : "-";
      console.log(`${same ? "OK  " : "DIFF"} ${key}\tfull=${lenFull}\tmerged=${lenMerged}`);
    }
  }
}

main();
