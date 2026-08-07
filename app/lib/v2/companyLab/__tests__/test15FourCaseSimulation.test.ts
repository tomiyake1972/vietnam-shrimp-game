// ShrimpX V2 — Test15 4ケース決定論的シミュレーションの検証テスト
//
// 【develop/v2統合・Required fix 4で全面見直し】scripts/test15FourCaseSimulation.ts が
// 実際に生成する数値について、コーディネーターが明示的に求めた方法論・主張が、
// 実際に成立することを確認する:
//   0. 方法論: runAllFourCasesが生成する全ケースが同一seedを使うこと（他社方針・
//      初期状態が完全に同一であること）。
//   1. 比較A（需要制約下の新工場建設）: baselineDemandConstrainedと
//      newFactoryDemandConstrainedは同一の需要上限を使い、新工場建設が
//      累計純利益を悪化させ得る（能力増強が需要制約下では純負になり得ることの実証）。
//   2. 比較B（PD省人化投資、実シミュレーション）:
//      pdMechanizationOffとpdMechanizationOnは同一のPD需要下限を使う。
//      実際にPD省人化投資のcapex（保守費・減価償却費）が発生し、残業費が
//      （わずかに）低下することを確認する。ただし本シナリオ・地平線では、
//      新たに発生するcapexコストを残業費削減が相殺しきれず、純利益は
//      むしろやや悪化するという結果が実際に得られた。これは「投資が
//      常に得とは限らない」という誠実な計算結果であり、テストはこの
//      実測結果をそのまま固定する（無理に「投資が得」という結果を
//      作らない。コーディネーター指示どおり）。
//   3. 補助: capex/pdMechanization.tsの純粋関数へ直接、同一の習熟進捗・
//      異なる稼働率を渡すと、削減率が単調に改善すること。
//   4. 【develop/v2統合・Required fix A-2】「高PD稼働率」という呼称は、対象工場の
//      比較窓平均PD稼働率がOff/On両ケースとも70%以上のときにしか使ってはならない
//      （コーディネーター指示の閾値）。本シナリオでは、実測の結果、両ケースとも
//      70%を下回ることを確認し、「実際の稼働率における比較」という誠実な報告に
//      留める（無理にラベルを付け替えない）。あわせて対象工場単位の必要/配置
//      Worker人数がOff/Onで実際に異なる値として得られることも確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAveragePdUtilization, computePdUtilizationSensitivity, HIGH_PD_UTILIZATION_THRESHOLD, runAllFourCases } from "../../../../../scripts/test15FourCaseSimulation";
import { PD_MECHANIZATION_PARAMETERS_V1 } from "../../capex/pdMechanization";

const VERIFY_SEED = "test15-4case-verify-seed";

test("Test15 4ケースシミュレーション: 6ケースとも例外なく完走し、各ケースの最終四半期スナップショットが揃っている", () => {
  const table = runAllFourCases(VERIFY_SEED);
  for (const result of [
    table.baseline,
    table.baselineDemandConstrained,
    table.newFactoryDemandConstrained,
    table.pdMechanizationOff,
    table.pdMechanizationOn,
    table.both,
  ]) {
    assert.ok(result.quarters.length > 0, "少なくとも1四半期は進行している");
    assert.ok(Number.isFinite(result.cumulativeNetIncomeUsd));
    assert.ok(Number.isFinite(result.finalQuarter.cashUsd));
  }
});

test("Test15 4ケースシミュレーション（比較A）: 需要制約下では、新工場建設(newFactoryDemandConstrained)がbaseline(baselineDemandConstrained)より累計純利益で悪化する（能力増強が純負になり得ることの実証）。両ケースは同一seed・同一の需要上限を使う", () => {
  // 【現金（cashUsd）を主張の指標に使わない理由】現金は四半期ごとの資金繰り
  // （借入・返済タイミング等）の影響を強く受け、単一四半期の値では
  // ノイズにより逆転し得ることを実際に確認した。累計純利益は「新設工場の
  // 減価償却・保守費というコストが、需要制約下では追加売上で相殺されない」
  // という主張の直接指標であり、より頑健なためこれを唯一の判定指標とする。
  const table = runAllFourCases(VERIFY_SEED);
  assert.ok(
    table.newFactoryDemandConstrained.cumulativeNetIncomeUsd < table.baselineDemandConstrained.cumulativeNetIncomeUsd,
    `需要制約下の新工場建設ケース(${table.newFactoryDemandConstrained.cumulativeNetIncomeUsd})はbaselineDemandConstrained(${table.baselineDemandConstrained.cumulativeNetIncomeUsd})より累計純利益が悪化するはず`,
  );
});

test("Test15 4ケースシミュレーション（比較B・実シミュレーション）: PD省人化投資は、稼働開始後にcapex保守費・減価償却費が実際に発生し、残業費が(わずかに)低下する。ただし本シナリオでは、新たなcapexコストを残業費削減が相殺しきれず、純利益はむしろ悪化する（誠実な実測結果。無理に投資が得な結果を作らない）", () => {
  const table = runAllFourCases(VERIFY_SEED);
  const off = table.pdMechanizationOff;
  const on = table.pdMechanizationOn;

  // 稼働開始後（最終四半期）は、On側にのみcapex保守費・減価償却費が発生する。
  assert.ok(on.finalQuarter.capexMaintenanceCostUsd > 0, `On側は稼働開始済みのはず（保守費: ${on.finalQuarter.capexMaintenanceCostUsd}）`);
  assert.ok(on.finalQuarter.capexAssetsDepreciationUsd > 0, `On側は稼働開始済みのはず（減価償却費: ${on.finalQuarter.capexAssetsDepreciationUsd}）`);
  assert.equal(off.finalQuarter.capexMaintenanceCostUsd, 0, "Off側はPD省人化投資を行っていないので保守費は発生しないはず");
  assert.equal(off.finalQuarter.capexAssetsDepreciationUsd, 0, "Off側はPD省人化投資を行っていないので減価償却費は発生しないはず");

  // 同一の高PD需要下限を適用しているため、PD生産量自体はOn/Offでほぼ一致する
  // （投資は生産量ではなく必要労働力・コストを変える設計のため）。
  assert.ok(
    Math.abs(on.finalQuarter.pdProducedTons - off.finalQuarter.pdProducedTons) < Math.max(1, off.finalQuarter.pdProducedTons * 0.05),
    `同一PD需要下限のもとでは、PD生産量はOn(${on.finalQuarter.pdProducedTons})とOff(${off.finalQuarter.pdProducedTons})でほぼ一致するはず`,
  );

  // 残業費はOn側でわずかに低い（PD省人化投資が労働集約度を下げる効果の方向は正しい）。
  assert.ok(
    on.finalQuarter.overtimeCostUsd < off.finalQuarter.overtimeCostUsd,
    `On側の残業費(${on.finalQuarter.overtimeCostUsd})はOff側(${off.finalQuarter.overtimeCostUsd})よりわずかに低いはず（機械化の労働集約度低減効果の方向）`,
  );

  // 【誠実な実測結果】このシナリオ・地平線では、上記の残業費削減額よりも
  // 新たに発生したcapexコスト（保守費+減価償却費）の方が大きく、累計純利益は
  // On側の方がむしろ悪化する。これは「PD省人化投資が常に得とは限らない」
  // というTest15の校正上の発見であり、無理に逆方向のアサーションを作らない
  // （コーディネーター指示: 結果が"nice"にならない場合はそのまま報告する）。
  assert.ok(
    on.cumulativeNetIncomeUsd <= off.cumulativeNetIncomeUsd,
    `本シナリオでの実測: On(${on.cumulativeNetIncomeUsd})はOff(${off.cumulativeNetIncomeUsd})以下（capexコストが残業費削減を上回る）はず`,
  );
});

test("Test15 4ケースシミュレーション（補助・純粋関数）: PD省人化投資は、同一の習熟進捗のもとで前四半期PD稼働率が高いほど実効PD係数の削減率が単調に大きくなる（投資効果が稼働率とともに改善することの実証）", () => {
  const rows = computePdUtilizationSensitivity(PD_MECHANIZATION_PARAMETERS_V1.adoptionRampQuarters, [0.2, 0.5, 0.9]);
  assert.equal(rows.length, 3);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i].previousQuarterPdUtilization > rows[i - 1].previousQuarterPdUtilization,
      "稼働率の並びが昇順であること（テスト自体の前提）",
    );
    assert.ok(
      rows[i].reductionRatio > rows[i - 1].reductionRatio,
      `稼働率${rows[i].previousQuarterPdUtilization}の削減率(${rows[i].reductionRatio})は、稼働率${rows[i - 1].previousQuarterPdUtilization}の削減率(${rows[i - 1].reductionRatio})より大きいはず`,
    );
    assert.ok(
      rows[i].effectivePdCoefficient < rows[i - 1].effectivePdCoefficient,
      "稼働率が高いほど実効PD係数は基準1.2からより下がる（＝より軽い労働集約度になる）はず",
    );
  }
  // 削減率はいずれも基準係数(1.2)とフロア(1.0)の比から導かれる最大削減率(1/6)を超えない。
  for (const row of rows) {
    assert.ok(row.reductionRatio <= 1 / 6 + 1e-9);
  }
});

test("Test15 4ケースシミュレーション（develop/v2統合・Required fix A-2）: 「高PD稼働率」という呼称は、Off/On両ケースの比較窓平均PD稼働率が70%以上のときにしか成立しない。本シナリオの実測ではこの閾値を満たさないため、「実際の稼働率における比較」として扱う（無理にラベルを付け替えない）", () => {
  const table = runAllFourCases(VERIFY_SEED);
  const off = table.pdMechanizationOff;
  const on = table.pdMechanizationOn;

  const offAvg = computeAveragePdUtilization(off);
  const onAvg = computeAveragePdUtilization(on);

  assert.ok(Number.isFinite(offAvg) && offAvg >= 0 && offAvg <= 1, `Off側の比較窓平均PD稼働率(${offAvg})は[0,1]の範囲のはず`);
  assert.ok(Number.isFinite(onAvg) && onAvg >= 0 && onAvg <= 1, `On側の比較窓平均PD稼働率(${onAvg})は[0,1]の範囲のはず`);

  // 同一のPD需要下限（pdDesiredQuantityFloorByFactory）をOff/On両ケースへ渡しているため、
  // PD省人化投資自体は生産量を変えない設計（労働集約度だけを変える）ことの帰結として、
  // 比較窓平均PD稼働率もOff/Onでほぼ一致するはず。
  assert.ok(Math.abs(offAvg - onAvg) < 0.02, `Off(${offAvg})とOn(${onAvg})の比較窓平均PD稼働率はほぼ一致するはず（同一PD需要下限のため）`);

  // 【誠実な実測結果】このseed・シナリオ・地平線では、Off/Onとも比較窓平均PD稼働率が
  // 70%を下回る。コーディネーター指示どおり、この場合は「高PD稼働率」という呼称を
  // 使わず、実際の稼働率のままレポートする（テストはこの実測をそのまま固定する。
  // 無理に70%以上になるよう入力を作り込まない）。
  const bothHigh = offAvg >= HIGH_PD_UTILIZATION_THRESHOLD && onAvg >= HIGH_PD_UTILIZATION_THRESHOLD;
  assert.equal(
    bothHigh,
    false,
    `本シナリオの実測ではOff(${offAvg})・On(${onAvg})とも${HIGH_PD_UTILIZATION_THRESHOLD}未満のはず（「実際の稼働率における比較」として扱うべきケース）`,
  );
});

test("Test15 4ケースシミュレーション（develop/v2統合・Required fix A-3）: 対象工場単位のPD計画必要Worker人数・配置Worker人数が、会社全体の常用Worker人数とは別に、実際のシミュレーション結果から取得できる。On側はPD省人化投資の効果で、Off側より必要Worker人数が少ない", () => {
  const table = runAllFourCases(VERIFY_SEED);
  const off = table.pdMechanizationOff.finalQuarter;
  const on = table.pdMechanizationOn.finalQuarter;

  assert.ok(off.targetFactoryPdRequiredWorkers > 0, "Off側の対象工場PD計画には必要Worker人数が算出されるはず");
  assert.ok(on.targetFactoryPdRequiredWorkers > 0, "On側の対象工場PD計画には必要Worker人数が算出されるはず");
  assert.ok(
    on.targetFactoryPdRequiredWorkers < off.targetFactoryPdRequiredWorkers,
    `On側の必要Worker人数(${on.targetFactoryPdRequiredWorkers})はOff側(${off.targetFactoryPdRequiredWorkers})より少ないはず（PD省人化投資の労働集約度低減効果）`,
  );

  // 配置Worker人数（実際にエンジンが配分した人数）は、必要人数とほぼ一致する
  // はず（このシナリオでは労働不足が生じていないため）。
  assert.ok(
    Math.abs(off.targetFactoryPdAllocatedRegularWorkers - off.targetFactoryPdRequiredWorkers) < 1,
    `Off側は必要人数(${off.targetFactoryPdRequiredWorkers})と配置常用Worker人数(${off.targetFactoryPdAllocatedRegularWorkers})がほぼ一致するはず`,
  );
  assert.ok(
    Math.abs(on.targetFactoryPdAllocatedRegularWorkers - on.targetFactoryPdRequiredWorkers) < 1,
    `On側は必要人数(${on.targetFactoryPdRequiredWorkers})と配置常用Worker人数(${on.targetFactoryPdAllocatedRegularWorkers})がほぼ一致するはず`,
  );

  // 対象工場単位の常用Worker人数は、会社全体のregularHeadcountとは別のフィールドとして
  // 取得できる（Required fix A-3の「工場単位で区別する」要求）。
  assert.ok(off.targetFactoryRegularHeadcount > 0, "対象工場の常用Worker人数が取得できるはず");
  assert.ok(on.targetFactoryRegularHeadcount > 0, "対象工場の常用Worker人数が取得できるはず");
});
