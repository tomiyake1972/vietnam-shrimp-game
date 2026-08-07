// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 暫定前提の集約
//
// 市場・シナリオモジュールの計算に必要だが、会社側の調達意思決定モジュールが
// まだ実装されていないために「今のゲームからは取得できない」入力を、この
// 1ファイルへ集約する（実装指示 §5「暫定値を計算ロジック内へ散在させないこと」）。
//
// 実際には、必要な暫定値の大半（前期HOSO価格の初期値・初期需要・過去4Qの
// 国内買付平均・PD/VAP需要構成の按分比率）はPhase1市場モジュール・Phase2
// シナリオモジュールがすでに前史（ScenarioPrehistory）・パラメータ
// （scenario/parameters.ts の SCENARIO_ENGINE_PARAMETERS_V1）として定義済みで
// あり、本ファイルで重複定義はしない（実装指示 §4「実際の既存型を再利用し、
// 似た型を不必要に重複定義しないこと」）。ここに置くのは、シナリオ・市場
// モジュールのどちらの責務にも入らない、Phase3固有の橋渡し1点だけである。
//
// 橋渡しが必要な理由:
//   市場モジュールの入力 PreviousMarketContext.domesticProcurementIntent は
//   「5社＋NPCの国内買付希望量（業界集計値）」であり、これは将来の調達
//   意思決定モジュールが計算する値である。ターン1に限っては、シナリオ
//   モジュールが ScenarioInitialStateOverrides.initialDomesticProcurementIntentHosoEqTons
//   として初期値を用意しているためそれをそのまま使う（simulationRunner.ts側の
//   配線であり、ここでの暫定値ではない）。しかしターン2以降は会社側の意思決定が
//   まだ存在しないため、何らかの仮定を置かないと計算が進められない。
//
//   本Phaseでは、シナリオモジュールがすでに実際のフィードバック
//   （advanceScenarioTurnで記録されるrealizedMarketResult）から算出する
//   「直近実績の移動平均（vietnamTrailingAverageDomesticPurchase）」に対する
//   比率として、国内買付希望量を仮置きする。すなわち「会社は直近の実勢
//   買付水準とおおむね同じ量を今期も買うつもりでいる」という最も単純な
//   仮定であり、実際の会社の意思決定ロジックが実装されるまでの代替に過ぎない
//   （画面にも「会社意思決定未接続の暫定前提」である旨を表示する）。
export interface IndustryLabAssumptions {
  readonly parametersVersion: string;
  /**
   * ベトナム国内調達希望量(HosoEqTons) = trailingAverageDomesticPurchase × この比率。
   * 1.0 = 直近実績と同水準を買うつもりでいる、という仮置き（校正前）。
   */
  readonly domesticProcurementIntentToTrailingAverageRatio: number;
}

/**
 * Phase3の暫定前提セット。すべて「校正前の仮置き」であり、実データ・
 * 会社側の意思決定モジュールが実装され次第、この値ではなく実際の入力へ
 * 差し替える（docs/v2/INDUSTRY_SIMULATOR_ARCHITECTURE_v0.1.md に明記）。
 */
export const INDUSTRY_LAB_ASSUMPTIONS_V1: IndustryLabAssumptions = {
  parametersVersion: "industry-lab-assumptions-v0.1",
  domesticProcurementIntentToTrailingAverageRatio: 1.0,
};
