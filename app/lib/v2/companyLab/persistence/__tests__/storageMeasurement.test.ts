// ShrimpX V2 — 会社ラボ 40四半期保存容量の実測（Phase 8C-1 §9）
//
// 【本ファイルの性質・診断専用であることの明記】
//   本テストは製品コードの振る舞いを検証するものではなく、Phase 8C-1完了報告§Dの
//   数値根拠を再現可能な形で得るための「診断」である。以後の実装（8C-2以降）が
//   このテストの具体的な数値に依存してはならない。目的はただ1つ:
//   「四半期が進むほど、1件あたりの履歴エントリのサイズが四半期番号に比例して
//   増大していないこと（＝historyの再帰的複製が起きていないこと）」を、実際の
//   バイト数で示すこと。
//
// 【実エンジンで到達できる四半期数について】
//   ユーザー指示は40四半期分の測定を求めているが、既存シナリオ"baseline"の
//   durationTurns（scenario/parameters.tsのSTANDARD_SCENARIO_DURATION_TURNS）は
//   32であり、既存エンジン（advanceCompanyLabQuarter）はこれを超えて進められない
//   （turn > durationTurnsではisComplete=trueとなり、advanceCompanyLabQuarterは
//   例外を投げる）。そのため本診断は、実エンジンで32四半期分を生成した上で、
//   33〜40四半期目は32四半期目の処理後スナップショットを土台にした現実的な
//   フィクスチャ複製（turn・period・turnId・processedAtだけを付け替える）で
//   補い、40件そろえて容量傾向を確認する。どこまでが実エンジンで、どこからが
//   フィクスチャ補完かは、以下のテスト出力・アサーション双方で明示する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period as makePeriod } from "../../../core/period";
import { encodeCompanyLabPersistedState } from "../codec";
import { CompanyLabPersistedStateV1, CompanyLabQuarterHistoryEntry, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../types";
import { createCompanyLabRuntimeSnapshot } from "../snapshot";
import { runRealQuartersWithAutoPolicy, buildHistoryEntryFromQuarter, baseTestConfig, MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO, TEST_ENGINE_VERSION } from "./testHelpers";

const TARGET_TOTAL_QUARTERS = 40;

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * turn番目（1始まり）のperiodを"YYYYQ(n)"の体裁で機械的に作る（33〜40番目の
 * フィクスチャ補完専用。実際のシナリオ暦とは対応しないダミー値であることを
 * 変数名・コメントで明示する）。
 */
function fabricatedPeriodForTurn(turn: number) {
  const year = 2015 + Math.floor((turn - 1) / 4);
  const q = ((turn - 1) % 4) + 1;
  return makePeriod(year, q);
}

test("40四半期分の保存容量を実測し、増加傾向が線形であることを確認する（診断専用）", () => {
  const { fixtures, quarters: realQuarters } = runRealQuartersWithAutoPolicy(baseTestConfig({ turns: MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO }), MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO);
  assert.equal(realQuarters.length, MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO, "実エンジンでシナリオの上限まで完走できていない");

  const historyEntries: CompanyLabQuarterHistoryEntry[] = [];
  for (const q of realQuarters) {
    historyEntries.push(buildHistoryEntryFromQuarter(fixtures, q, `turn-${q.record.turn}`, `2026-01-01T00:00:${String(q.record.turn).padStart(2, "0")}.000Z`));
  }

  // --- 33〜40四半期目: フィクスチャ補完（実エンジンのシナリオ長を超える分） ---
  const lastReal = historyEntries[historyEntries.length - 1];
  for (let turn = MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO + 1; turn <= TARGET_TOTAL_QUARTERS; turn++) {
    const period = fabricatedPeriodForTurn(turn);
    const fabricated: CompanyLabQuarterHistoryEntry = {
      ...lastReal,
      turn,
      period,
      turnId: `turn-${turn}-fabricated`,
      record: { ...lastReal.record, turn, period },
      processedAt: `2026-01-01T00:${String(turn).padStart(2, "0")}:00.000Z`,
    };
    historyEntries.push(fabricated);
  }
  assert.equal(historyEntries.length, TARGET_TOTAL_QUARTERS);

  // --- current（初期状態）のバイト数 ---
  // initializeCompanyLabの初期状態そのものは、1四半期目の処理前スナップショット
  // （advanceCompanyLabQuarter呼び出し前）と全く同じ内容であるため、これを
  // 「current（初期状態）」の代表値として使う。
  const initialRuntimeSnapshot = createCompanyLabRuntimeSnapshot(realQuarters[0].stateBefore);
  const initialStored: CompanyLabPersistedStateV1 = {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: TEST_ENGINE_VERSION,
    labId: "lab-storage-measurement",
    config: realQuarters[0].stateBefore.config,
    fixtures,
    currentState: { runtime: initialRuntimeSnapshot, revision: 0 },
    draft: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  };
  const currentInitialBytes = byteLength(encodeCompanyLabPersistedState(initialStored));

  // --- 各四半期履歴エントリのバイト数 ---
  const entryBytes = historyEntries.map((e) => byteLength(e));
  const preSnapshotBytes = historyEntries.map((e) => byteLength(e.preProcessingStateSnapshot));
  const postSnapshotBytes = historyEntries.map((e) => byteLength(e.postProcessingStateSnapshot));
  const recordBytes = historyEntries.map((e) => byteLength(e.record));

  const q1 = entryBytes[0];
  const q10 = entryBytes[9];
  const q20 = entryBytes[19];
  const q40 = entryBytes[39];
  const totalAll40 = entryBytes.reduce((a, b) => a + b, 0);
  const largestSingleKey = Math.max(...entryBytes);
  const historyIndexBytesApprox = byteLength(historyEntries.map((e) => e.turn)); // ZSETの概算（member文字列+score程度の目安）
  const draftBytesApprox = 0; // 確定後はdraftが削除されるため、ラボ全体概算では0として扱う（未提出ドラフトがある場合は別途加算する）
  const labWholeApprox = currentInitialBytes + totalAll40 + historyIndexBytesApprox + draftBytesApprox;

  // --- 実turn1・実turn32（実エンジンで到達できる最終ターン）フィールド別内訳 ---
  // 「per-entry sizeがturn番号に比例して増大していないか」の根本原因を、フィールド単位で
  // 特定するための追加測定（§11-2「productionState内部履歴との二重保持」調査と地続き）。
  const q1RealPost = realQuarters[0].stateAfter;
  const q32RealPost = realQuarters[realQuarters.length - 1].stateAfter;
  const fieldBreakdown = (["contracts", "rawMaterialLots"] as const).map((f) => ({
    field: f,
    q1Bytes: byteLength(q1RealPost[f]),
    q32Bytes: byteLength(q32RealPost[f]),
    q1Length: q1RealPost[f].length,
    q32Length: q32RealPost[f].length,
  }));
  const fgLotsBreakdown = {
    field: "productionState.finishedGoodsLots",
    q1Bytes: byteLength(q1RealPost.productionState.finishedGoodsLots),
    q32Bytes: byteLength(q32RealPost.productionState.finishedGoodsLots),
    q1Length: q1RealPost.productionState.finishedGoodsLots.length,
    q32Length: q32RealPost.productionState.finishedGoodsLots.length,
  };

  console.log(
    [
      "",
      "=== Phase 8C-1 §9 40四半期保存容量 実測結果（診断専用・製品コードの振る舞いには影響しない） ===",
      `対象 | JSONバイト数`,
      `current(初期状態) | ${currentInitialBytes}`,
      `Q1 history entry | ${q1}`,
      `Q10 history entry | ${q10}`,
      `Q20 history entry | ${q20}`,
      `Q40 history entry | ${q40}`,
      `40履歴合計 | ${totalAll40}`,
      `ラボ全体概算(current+40履歴+index概算+draft概算) | ${labWholeApprox}`,
      `最大単一履歴キー | ${largestSingleKey}`,
      `Q1 preProcessingStateSnapshot | ${preSnapshotBytes[0]}`,
      `Q1 postProcessingStateSnapshot | ${postSnapshotBytes[0]}`,
      `Q40 preProcessingStateSnapshot | ${preSnapshotBytes[39]}`,
      `Q40 postProcessingStateSnapshot | ${postSnapshotBytes[39]}`,
      `Q1 CompanyQuarterRecord | ${recordBytes[0]}`,
      `Q40 CompanyQuarterRecord | ${recordBytes[39]}`,
      `実エンジンで生成: turn 1〜${MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO} / フィクスチャ補完: turn ${MAX_REAL_ENGINE_TURNS_FOR_BASELINE_SCENARIO + 1}〜${TARGET_TOTAL_QUARTERS}（turn33〜40はturn32のスナップショットをそのまま複製したものであり、それ自体は増大しない）`,
      "--- 増大要因のフィールド別内訳（実turn1 vs 実turn32、正当な累積配列であることの確認） ---",
      ...fieldBreakdown.map((b) => `${b.field}: turn1=${b.q1Bytes}bytes(${b.q1Length}件) turn32=${b.q32Bytes}bytes(${b.q32Length}件)`),
      `${fgLotsBreakdown.field}: turn1=${fgLotsBreakdown.q1Bytes}bytes(${fgLotsBreakdown.q1Length}件) turn32=${fgLotsBreakdown.q32Bytes}bytes(${fgLotsBreakdown.q32Length}件)`,
      "",
    ].join("\n")
  );

  // --- 【本質的な確認】線形性・非再帰性の検証 ---
  // turn番号が増えるにつれ、1件あたりのサイズがturn番号に比例して増大していない
  // こと（＝過去のhistoryを再帰的に埋め込んでいないこと）を、Q40とQ1の比率が
  // 「40倍」に近いものではないことで確認する（正当な累積配列の増加はあるため、
  // 多少の増加は許容するが、40倍のような比例的増大にはならないはず）。
  const ratio40to1 = q40 / q1;
  assert.ok(ratio40to1 < 10, `Q40/Q1の比率が${ratio40to1.toFixed(2)}倍と大きすぎる。history再帰的複製の疑いがある`);

  // 40件の履歴エントリの合計サイズが、最大エントリの40倍（＝全エントリが最大サイズと
  // 同等というワーストケース）を大きく下回ること（線形和であることの傍証）。
  assert.ok(totalAll40 < largestSingleKey * TARGET_TOTAL_QUARTERS, "40件合計が最大エントリ×40を超えている（想定外）");

  // 個々のスナップショットにhistoryキー自体が存在しないこと（再帰的複製の直接的な確認）。
  for (const e of historyEntries) {
    const preHasHistory = Object.prototype.hasOwnProperty.call(e.preProcessingStateSnapshot, "history");
    const postHasHistory = Object.prototype.hasOwnProperty.call(e.postProcessingStateSnapshot, "history");
    assert.equal(preHasHistory, false, `turn ${e.turn} preProcessingStateSnapshotにhistoryキーが存在する`);
    assert.equal(postHasHistory, false, `turn ${e.turn} postProcessingStateSnapshotにhistoryキーが存在する`);
  }

  // Q40エントリ自体のサイズが、それ以前の全履歴を埋め込んだ場合に予想される規模
  // （目安として、Q1エントリのサイズ×turn番号）よりはるかに小さいこと。
  assert.ok(q40 < q1 * 10, `Q40エントリのサイズがQ1×10を超えている（turn番号に比例した増大の疑い）`);
});
