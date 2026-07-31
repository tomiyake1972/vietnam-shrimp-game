// ShrimpX V2 — SAI-6 Phase 1A-2: 資金調達→原料調達の因果接続を結果レベルで検証する。
//
// 【背景】Phase 1A-2の因果接続監査（scripts/sai6Phase1A2CausalConnectionAudit.ts）で、
// 実際の破綻前後の窓（4 seed×5社、80四半期）のうち78/80四半期で「承認額＝借入余力」
// （銀行の与信上限が常に完全に使い切られている）ことが確認された。つまり、AIの
// 希望借入額をどれだけ是正しても、承認額・実行額はほぼ変わらない
// （遮断点B。詳細はdocs/v2/reports/sai6_phase1a2_*.md参照）。
//
// 本ファイルは、その"遮断点B"という結論を作り話にしないため、次の2つを両方とも
// 結果レベルで検証する:
//   1. 借入余力が「希望額を上回っている」条件では、承認額が増えれば当期の
//      原料調達の現金制約が実際に緩和されることを、pure functionレベルで確認する
//      （＝メカニズム自体は正しく機能する）。
//   2. 実際のゲームデータ（破綻直前の会社）では、借入余力が希望額を常に下回って
//      おり、是正の有無にかかわらず承認額が借入余力に張り付くことを、回帰
//      ピン留めテストとして残す（＝無理に成功させない診断テスト）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons } from "../../../../core/units";
import { computeProcurementConstraint, ProcurementConstraintInput } from "../../../../financing/liquidityClose";
import { FINANCING_PARAMETERS_V1 } from "../../../../financing/parameters";
import { runAutoplayCase } from "../../../standardAi/autoplay/runCase";
import { ALL_COMPANY_IDS } from "../../../standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../../../standardAi/report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

// ---------------------------------------------------------------------
// 1. メカニズム自体は接続していることの確認（pure function、runner.tsが
//    computeProcurementConstraintへ渡す入力の型そのものを直接使う）。
// ---------------------------------------------------------------------
test("Phase1A-2-機構: 借入余力が希望額を上回る条件では、承認額の増加が当期の原料調達制約を緩和する（決定順序は問題にならない）", () => {
  const base: ProcurementConstraintInput = {
    companyId: "BAL" as ProcurementConstraintInput["companyId"],
    period: "2016Q1" as ProcurementConstraintInput["period"],
    originalDomesticPurchaseQuantityTons: 5000,
    expectedDomesticPriceUsdPerKg: 2.5,
    prevCashUsd: 1_000_000, // 現金は少なく設定し、承認額の差が調達量へそのまま効くようにする
    approvedNormalLoanDrawUsd: 0,
    severeArrearsOrInsolvent: false,
  };

  const withoutExtraLoan = computeProcurementConstraint(base, FINANCING_PARAMETERS_V1);
  const withExtraLoan = computeProcurementConstraint({ ...base, approvedNormalLoanDrawUsd: 8_000_000 }, FINANCING_PARAMETERS_V1);
  const withEvenMoreLoan = computeProcurementConstraint({ ...base, approvedNormalLoanDrawUsd: 20_000_000 }, FINANCING_PARAMETERS_V1);

  assert.ok(
    withExtraLoan.constrainedDomesticPurchaseQuantityTons > withoutExtraLoan.constrainedDomesticPurchaseQuantityTons,
    "承認額が増えれば、同じ四半期の実行可能な国内買付数量も増えなければならない（＝finance→procurementの接続自体は同一四半期内で機能する）"
  );
  assert.ok(withExtraLoan.scaleRatio > withoutExtraLoan.scaleRatio, "承認額が増えれば、調達スケール比も改善しなければならない");
  assert.ok(
    withEvenMoreLoan.constrainedDomesticPurchaseQuantityTons <= base.originalDomesticPurchaseQuantityTons + 1e-6,
    "承認額をさらに増やしても、実行数量は希望数量を超えてはならない（scaleRatioは1で頭打ち）"
  );
  assert.equal(withEvenMoreLoan.scaleRatio, 1, "希望額を十分に上回る承認額があれば、制約は完全に解消される（scaleRatio=1）");

  // 【意思決定順序への反論】computeProcurementConstraintはrunner.ts側で
  // 「銀行の与信判断（planQuarterFinancing、当期のturnResultより前に確定）」の
  // 直後・同一ループ内で呼ばれ、その承認額をそのまま引数として受け取る
  // （runner.ts:857-869）。したがって、standardAi/policy.tsのAI意思決定生成順序
  // （sales→production→procurement→labor→finance→capex）とは独立に、
  // 「finance承認→procurement実行制約」という順序はrunner.ts側で既に
  // 保証されている。順序変更（procurementをfinanceより後にする等）は不要である。
});

// ---------------------------------------------------------------------
// 2. 実際のゲームデータでの回帰ピン留め（診断テスト。改善を無理に主張しない）。
// ---------------------------------------------------------------------
test("Phase1A-2-実データ: 破綻直前の窓では、承認額が常に借入余力に張り付き、資金見通し是正の有無で実行額はほぼ変わらない（診断のためのピン留め）", () => {
  const off = runAutoplayCase({ scenarioId: "baseline", seed: "sai5-ab-001", quarters: 24, companyIds: ALL_COMPANY_IDS, candidate });
  const on = runAutoplayCase({
    scenarioId: "baseline",
    seed: "sai5-ab-001",
    quarters: 24,
    companyIds: ALL_COMPANY_IDS,
    candidate,
    fundingOutlookEnabled: true,
  });

  // sai5-ab-001/BALは因果監査で「A類型（仮説どおり）」と当初分類されたケース。
  // ここで承認額と借入余力の関係を直接確認する。
  const turns = [21, 22, 23, 24];
  let boundCount = 0;
  let drawDeltaTotalUsd = 0;
  for (const turn of turns) {
    const offRec = off.history.find((h) => h.turn === turn);
    const onRec = on.history.find((h) => h.turn === turn);
    const offFin = offRec?.financingResults.find((f) => f.companyId === "BAL");
    const onFin = onRec?.financingResults.find((f) => f.companyId === "BAL");
    assert.ok(offFin && onFin, `turn ${turn} のfinancingResultsが取得できる必要がある`);
    const offBound = Math.abs(offFin!.underwriting.approvedAmountUsd - offFin!.borrowingCapacity.availableAdditionalCapacityUsd) < 1000;
    const onBound = Math.abs(onFin!.underwriting.approvedAmountUsd - onFin!.borrowingCapacity.availableAdditionalCapacityUsd) < 1000;
    if (offBound && onBound) boundCount += 1;
    drawDeltaTotalUsd += onFin!.loanDrawUsd - offFin!.loanDrawUsd;
  }

  // 【診断のためのピン留め】現状のこのケースでは、4四半期すべてで承認額が
  // 借入余力に完全一致する（＝銀行の与信上限が常に律速）。このテストは
  // 「改善している」ことを主張するテストではなく、「この制約構造が今も
  // 存在する」ことを固定して検知するための回帰ピン留めである。将来、
  // Phase 1B（借入余力超過時の計画縮小）やcapex/初期資本構成側の変更で
  // この前提が崩れたら、このテストが失敗して気づけるようにする。
  assert.equal(boundCount, turns.length, "破綻直前の窓では、承認額が借入余力に常に一致する（capacity-bound）という現状の制約構造をピン留めする");
  assert.ok(
    Math.abs(drawDeltaTotalUsd) < 100_000,
    `資金見通し是正だけでは、この4四半期の合計借入実行額はほとんど変化しない（現状の差: ${drawDeltaTotalUsd.toFixed(0)} USD）。原因は借入余力そのものの不足であり、希望額の算定式ではない。`
  );
});

void hosoEqTons;
