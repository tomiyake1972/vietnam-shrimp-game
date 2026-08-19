// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 閾値・設定パラメータ
//
// すべての閾値・重みをこのファイルへ集約する（実装指示: 「閾値・重み・優先順位を
// 後から1箇所で調整できること」）。5社すべてに同一の値を適用する（会社IDに
// よる分岐は存在しない）。将来の校正フェーズでの調整対象であることを明示する。
//
// 【SAI-4追記】STANDARD_AI_PARAMETERS_V1は引き続き「全社同一」の既定値であり、
// 本ファイル自体は一切変更していない（既存のSAI-1〜SAI-3Bの全テスト・成果物に
// 影響を与えない）。5社異質モデル（小幅な経営性格差）は、このデフォルトを会社ID
// ごとに小さくバイアスした別の`StandardAiParameters`インスタンスを、companyLab/
// standardAi/managementProfile.tsが生成して差し替えるだけであり、ここで会社IDに
// よる分岐を持ち込むわけではない。

import { CompanyFixture } from "../types";
import { unwrapUnit } from "../../core/units";
import { computeQuarterlyLaborCost } from "../workforce";
import { DemandMarketId, Product } from "../../market/types";
import type { GrowthPressureParameters } from "./growth/growthPressure";

export interface StandardAiParameters {
  // --- 在庫目標（生産・調達共通） ---
  /** 完成品在庫の目標水準（今期生産希望量に対する四半期数）。これを超えると過剰。 */
  readonly finishedGoodsTargetQuarters: number;
  /** 原料在庫の目標水準（今期必要原料量に対する四半期数）。 */
  readonly rawMaterialTargetQuarters: number;
  /** 在庫補正の減衰係数（目標との乖離のうち1四半期で埋めにいく比率）。 */
  readonly inventoryCorrectionDamping: number;

  // --- 販売 ---
  /** 完成品在庫過剰とみなす比率（在庫/目標在庫がこれを超えたら値引き）。 */
  readonly excessInventoryRatioForDiscount: number;
  /** 在庫過剰時の最大値引き率（基準価格に対する比率）。 */
  readonly maxDiscountRatioForExcessStock: number;
  /** 供給余力が薄いときの値引き回避しきい値（能力使用率）。 */
  readonly highUtilizationRatioForNoDiscount: number;
  /** 【SAI-4追加】商品別能力に対する目標販売数量の比率（会社×商品ごとの目標稼働率）。
   *  従来はdecision/sales.tsに`BASE_UTILIZATION_TARGET = 0.8`としてハードコードされて
   *  いた定数をパラメータ化しただけで、既定値0.8は変更していない（全社一律の
   *  数値が変わっていないため、既存の全テスト・成果物への影響はゼロ）。5社異質
   *  モデルのsalesVolumeBias/marketShareBias（B社が少し高め・C社が少し低めにする等）
   *  の差し込み口として使う。 */
  readonly salesUtilizationTarget: number;
  /** 【SAI-4追加】PD/VAPの受注量係数（premiumPolicy.tsのorderQuantityFactor、
   *  0〜1）に加算する上乗せ・割引（±0〜0.1程度を想定）。既定0（無補正、premiumPolicy.ts
   *  の計算式は一切変更しない）。5社異質モデルのvalueAddedBias（D社がPD/VAPを
   *  少し優先する）の差し込み口。加算後は[0, 1.1]にクランプする
   *  （decision/sales.ts参照、捏造的な値を作らないための上限）。 */
  readonly valueAddedOrderFactorBoost: number;

  // --- 【SAI-5A追加】市場・商品志向（orientationProfile.tsが会社別に注入） ---
  /** 市場志向倍率（市場ごとの魅力度補正、許容範囲0.80〜1.25）。既定は空
   *  オブジェクト（=全市場1.0、志向なし）。空のときdecision/sales.tsは
   *  再配分コードパス自体をスキップするため、既定値での浮動小数点結果は
   *  従来とビット単位で一致する。値の意味・会社別の設定は
   *  orientationProfile.tsに一箇所集約（ここでは会社IDによる分岐を持たない）。 */
  readonly marketOrientationMultipliers: Readonly<Partial<Record<DemandMarketId, number>>>;
  /** 商品志向倍率（商品ごとの魅力度補正、許容範囲0.85〜1.20）。既定は空
   *  オブジェクト（=全商品1.0）。商品別の目標販売数量（能力×目標稼働率）に
   *  乗算する。上限1.20×既定稼働率0.8=0.96のため能力超過は構造上起きない。 */
  readonly productOrientationMultipliers: Readonly<Partial<Record<Product, number>>>;
  /** 【SAI-5F】成長トレンド応答度（0〜1）。公開のライフサイクル構成比トレンド
   *  （前期差分）が正のとき、PD/VAP設備投資の入口しきい値をどの程度前倒し
   *  するかの係数。既定0（無効。orientation有効時のみ会社別に設定される）。 */
  readonly growthTrendResponsiveness: number;
  /** 【SAI-5F】過剰供給リトリート感度（0〜1）。公開の商品別供給圧力が高い
   *  とき、PD/VAP設備投資をどの程度強く見送るか。既定0（無効）。 */
  readonly oversupplyRetreatSensitivity: number;
  /** 【SAI-5F】Standard AIの拡張設備投資判断（suspended案件のresume提案・
   *  ライフサイクル成長エントリ・過剰供給リトリート）の有効化。既定false
   *  （decision/capex.tsの既存判断と完全に同一の挙動）。 */
  readonly standardAiCapexExtensionsEnabled: boolean;
  /** 【SAI-5F】成長エントリの最低前期稼働率（通常のcapex条件0.92より低い入口。
   *  ライフサイクル成長局面では能力逼迫の「手前」で投資判断するための緩和値。
   *  資金・在庫・借入の安全条件は通常capexと完全に同一のまま）。 */
  readonly capexGrowthEntryUtilizationThreshold: number;
  /** 【SAI-5F】成長エントリとみなす公開ライフサイクルトレンドの下限
   *  （構成比pt/四半期。0.004 = 年率約1.6ptの構成比シフト）。 */
  readonly capexGrowthEntryTrendPerQuarterThreshold: number;
  /** 【SAI-5F】これを超える公開供給圧力のEWMAではPD/VAPの設備投資を見送る
   *  （CAPEX_DEFERRED_OVERSUPPLY / VAP_OVERSUPPLY_RETREAT）。
   *  【監査指摘B後に再測定】供給圧力の定義を completed_supply
   *  （= 1 + 売れ残り提示量/対象需要）へ構造修正したため、旧定義（0.2〜0.5の
   *  レンジ）を前提にした1.15は意味を失った。4seed×32Q実測のEWMA分布は
   *  PD 1.000〜1.044（中央値1.021）、VAP 1.070〜1.318（中央値1.106、p75 1.141、
   *  p90 1.279）。設備投資の見送りは販売抑制より重い判断のため、VAPで上位2割
   *  程度の局面だけが該当する水準に置く。 */
  readonly capexOversupplyPressureThreshold: number;
  /** 【SAI-5F】ライフサイクル成長トレンドによる販売数量ブーストの上限
   *  （比率。成長市場でも希望量の増加は最大+5%までの小幅な前傾）。 */
  readonly lifecycleGrowthSalesBoostCap: number;
  /** 【SAI-5F】トレンド（構成比pt/四半期）→販売ブースト比率への変換係数。 */
  readonly lifecycleGrowthSalesBoostScale: number;
  /** 【SAI-5F】これを超える公開供給圧力のEWMAで当該商品の販売希望量を抑制し始める。
   *  【監査指摘B後に再測定】上記と同じ実測分布に基づき、VAPの上位25%程度
   *  （p75=1.141付近）から緩やかに抑制が効き始める水準に置く。PD側は実測レンジの
   *  上限が1.044のため通常運転では発火しない（＝PDは本シナリオで供給過剰に
   *  ならない、という測定結果。発火させるための本体ロジックの追加はしない）。 */
  readonly supplyPressureRetreatThreshold: number;
  /** 【SAI-5F】供給圧力リトリートによる販売希望量縮小の下限倍率（最大-15%）。 */
  readonly supplyPressureRetreatFloor: number;
  /** 【監査指摘H】PD能力が「稼働中（＝維持する価値がある）」とみなす稼働率の下限。
   *  PD_CAPACITY_MAINTAINED は、遊休のPD能力を維持していると称さないために
   *  この水準を超えている場合にのみ発火する。 */
  readonly capexPdInUseUtilizationThreshold: number;

  // --- 労働 ---
  /** ワーカー不足が「持続的」とみなす連続四半期しきい値（ヒステリシス）。 */
  readonly sustainedShortageQuarterThreshold: number;
  /** ワーカー過剰が「持続的」とみなす連続四半期しきい値。 */
  readonly sustainedExcessQuarterThreshold: number;
  /** 一時的な不足に対して認める最大残業率。 */
  readonly maxOvertimeRateForTransientShortage: number;
  /** 一時的な不足に対して認める、必要人数に対する臨時ワーカー比率上限。 */
  readonly maxTemporaryRatioForTransientShortage: number;
  /** 正社員の増減は必要人数とのギャップのうち、この比率だけを1四半期で埋める（過剰反応防止）。 */
  readonly regularHeadcountAdjustmentDamping: number;

  // --- 資金繰り ---
  /** 最低現金バッファの目安となる四半期数（会社規模連動の推定四半期支出に対する倍率）。 */
  readonly cashBufferQuarters: number;
  /** 現金がこの倍率（対最低バッファ）を超えたら任意期限前返済を検討する。 */
  readonly voluntaryPrepaymentMultiple: number;
  /** 最低現金バッファの絶対下限（USD）。会社規模が極端に小さい場合の安全弁。 */
  readonly minimumCashBufferFloorUsd: number;
  /** 通常融資の希望期間（四半期）。 */
  readonly desiredTermQuarters: number;
  /** 原料調達に想定する暫定原料価格（前期実績が無い場合のフォールバック、USD/HOSO換算kg）。 */
  readonly defaultExpectedRawPriceUsdPerKg: number;
  /** 想定臨時ワーカー比率（現金バッファ試算に使う簡易な人件費見積り用）。 */
  readonly typicalTemporaryHeadcountRatio: number;
  /** 想定稼働率（現金バッファ試算・原料コスト見積りに使う）。 */
  readonly typicalUtilizationForCashEstimate: number;

  // --- 設備投資（capex） ---
  /** これ以上の設備稼働率（前期実績）が続けば「持続的ボトルネック」とみなす。 */
  readonly capexSustainedUtilizationThreshold: number;
  /** 当四半期の必要量が能力を超える比率（capexを検討する最低条件）。 */
  readonly capexCurrentShortfallRatioThreshold: number;
  /** 設備投資後も安全に維持できる現金の、最低バッファに対する倍率（これ未満なら見送り）。 */
  readonly capexCashSafetyMultiple: number;
  /**
   * 【Test16】設備投資の現金ゲートの方式。
   *   "costBased"      … 最低現金バッファ ＋ 投資額 ＋ 投資額×capexCostSafetyRatio
   *   "legacyMultiple" … 最低現金バッファ × capexCashSafetyMultiple（旧方式）
   * 旧方式は投資額と無関係に会社規模だけで必要現金を決めるため、
   * 8M USDの投資に45〜60M USDの現金保有を要求していた。
   */
  readonly capexCashGateMode: "costBased" | "legacyMultiple";
  /**
   * 【Test16】投資額に対する追加安全余裕の比率（costBasedのときのみ使用）。
   * 「投資後に最低現金バッファを割らない」ぶん（投資額そのもの）は
   * この比率とは別に必ず確保するため、必要現金は
   *   targetMinimumCash + cost × (1 + capexCostSafetyRatio)
   * となる。
   */
  readonly capexCostSafetyRatio: number;
  /** 借入残高が会社規模推定に対してこの比率を超えたら、財務健全性を理由にcapexを見送る。 */
  readonly capexMaxLoanToSizeRatio: number;
  /**
   * 【CE-1新設】PD機械化（pdMechanization）案件の投資判断に使う、許容回収期間（四半期）。
   * 「投資額 ÷ 想定四半期人件費削減額」がこの期間以内であれば経済性ありと判定する
   * 基準しきい値。既存のcapexCurrentShortfallRatioThreshold等とは独立した、
   * 労務生産性投資（機械化）専用の1つのしきい値。productOrientationMultipliers.pd
   * とcapexCurrentShortfallRatioThresholdの比率（既存のFinancial Conservatism
   * 由来）で会社ごとに実効的に加減されるため、この値自体は全社一律の基準値
   * （初期値は校正前の暫定値、CE-1ベンチマーク実施前は変更しない）。
   */
  readonly pdMechanizationMaxPaybackQuarters: number;
  /**
   * 【CE-2新設】VAP商品開発費（vapProductDevelopmentSpendUsd）の投資判断に使う、
   * 許容「affordability」期間（四半期）。VAP商品開発の効果は
   * companyLab/productDevelopmentState.tsのスコア（→sales/allocation.tsの
   * 非価格競争力ウェイトへの間接効果）であり、CAPEXのような直接的な$回収額の
   * 式が既存コードに存在しない（想像で新しい弾力性係数を作らない・指示§2/§39）。
   * そのため「投資額 ÷ 直近四半期の実際のVAP貢献利益（既存のtargetMarginUsdPerHosoEqKg
   * ×実績VAP生産量から算出、新しい効果値ではない）」を、投資額が現在のVAP事業
   * 規模に対して"身の丈に合っているか"を測るaffordability指標として使う
   * （文字通りのROI paybackではないことを明示するため、コード内コメントでは
   * 一貫して"affordability"と呼ぶ）。この値以下のtierだけを経済的に妥当とみなす。
   */
  readonly vapProductDevelopmentMaxAffordabilityQuarters: number;
  /**
   * 【CE-2新設】VAP商品開発スコア（0〜100、companyLab/productDevelopmentState.ts）の
   * ヘッドルーム（= 1 − score/100、既存の飽和型スコア更新式にそのまま存在する量）が
   * この比率を下回ったら「これ以上投資しても得られる伸びがほぼ無い」とみなし、
   * 新規支出を見送る（指示§18 saturation guard）。新しい効果値ではなく、既存の
   * ヘッドルーム式へ判断しきい値を1つ足すだけ。
   */
  readonly vapProductDevelopmentMinHeadroomRatio: number;
  /**
   * 【Standard AI Investment Portfolio Calibration・Phase PC-2A新設】VAP商品開発の
   * Investment Intensity（0〜1、headroom・VAP事業規模・affordabilityの単純平均。
   * decision/vapProductDevelopment.ts参照）がこの値以上ならHIGH intensity（$500k候補）、
   * 下回ればMEDIUM/LOW判定へ進む。PC-1.5監査で判明した「affordabilityが通れば必ず
   * 最大tierになる」bang-bang挙動（指示§2-3）を解消するため、tier選定を
   * affordability単独ではなくIntensity（3要素の合成）で決めるように変更した
   * （指示§9「最大tierがaffordableなら必ず最大tierにはしない」）。
   */
  readonly vapProductDevelopmentIntensityHighThreshold: number;
  /**
   * 【Phase PC-2A新設】同上のIntensityがこの値以上ならMEDIUM intensity（$250k候補）、
   * 下回ればLOW intensity（$100k候補）。
   */
  readonly vapProductDevelopmentIntensityMediumThreshold: number;
  /**
   * 【Phase PC-2A新設・BEFORE/AFTER比較用ablationスイッチ】省略時（=undefined）は
   * 新方式（Investment Intensity）。falseのときだけPC-2A以前の挙動（常に最高tierから
   * affordability・財務ゲートを満たす最初のtierを選ぶ）を再現する。
   */
  readonly vapDevelopmentTierIntensityEnabled?: boolean;
  /**
   * 【Standard AI Capability Expansion・Phase CE-3新設】品質管理設備
   * （qualityControlEquipment）投資の合成Quality Needスコア（0〜1程度、
   * decision/capex.tsのcomputeQualityNeedScore参照）に対するしきい値。
   * このスコアがしきい値を超えたFactoryだけが候補になる。PD機械化の
   * pdMechanizationMaxPaybackQuarters・VAP開発のvapProductDevelopment
   * MaxAffordabilityQuartersと同じく、productOrientationMultipliers（既存の
   * 商品志向、PD/VAP対HOSOの比）とcapexCurrentShortfallRatioThreshold由来の
   * financialConservatismRatioで会社ごとに実効的に加減される（新しいStrategy
   * Profile型は作らない・指示§13）。この値自体は全社一律の基準値（初期値は
   * 校正前の暫定値、CE-3ベンチマーク実施前は変更しない）。
   */
  readonly qualityEquipmentNeedThreshold: number;
  /**
   * 【Standard AI CE-3A新設・監査専用】品質管理設備の候補生成そのものを無効化する
   * ためのablation switch。省略時（undefined）は有効（＝CE-3までの挙動と完全に
   * 同一）。falseを明示的に渡した場合のみ、decision/capex.tsのQuality Equipment
   * 候補ブロックを丸ごとスキップする（PD Mechanization・VAP Product Development・
   * Line CAPEX・New Factory等、他の判断ロジックは一切変更しない）。
   * Customer Trust Attribution監査（CE-3A）のcontrolled ablation benchmark
   * （品質管理設備ONとの比較用）だけに使う注入口であり、既定挙動・既存の
   * 全呼び出し元・全既存テストには一切影響しない。
   */
  readonly qualityEquipmentCapabilityEnabled?: boolean;
  /**
   * 【Standard AI Factory Activation・Phase FA-1新設・監査専用ablation】
   * falseを明示的に渡した場合だけ、decision/labor.tsの新設Factoryぶん労働
   * baseline合成（FA-1で修正した既存バグの修正部分）を無効化し、修正前の
   * 挙動（新設Factoryへ一切WorkerAssignmentが生成されない）を再現する。
   * 省略時（undefined）は必ず有効＝FA-1後の正しい挙動。
   */
  readonly factoryActivationLaborFixEnabled?: boolean;

  // --- 養殖 ---
  /** 養殖の期待収穫比率（池入れ量→収穫量の目安）。 */
  readonly expectedAquacultureHarvestRatio: number;
  /** 養殖強度（0〜1、固定・全社一律）。 */
  readonly aquacultureIntensity: number;
  /** バイオセキュリティ水準（0〜1、固定・全社一律）。 */
  readonly bioSecurityLevel: number;

  // --- 調達構成 ---
  /** 輸入に振り向ける比率の目安（構成比ベース）。 */
  readonly importMixRatio: number;
  /** 国内買付需要の下限（基礎需要に対する比率）。ゼロへ一斉に落ちるのを防ぐ。 */
  readonly minDomesticPurchaseRatioOfBase: number;
  /**
   * 自社養殖だけで必要原料量を完全自給しないための上限（必要原料量に対する比率）。
   * 養殖能力が大きい会社でも、この比率を超えて自給せず、国内買付・輸入の需要を
   * 恒常的に残す（全社一律の上限。会社ごとの違いは実際の養殖能力の差だけから生じる）。
   */
  readonly maxAquacultureShareOfRequirement: number;
  /** 現金圧力が高いときに調達希望量を抑える度合い（0〜1、大きいほど強く抑制）。 */
  readonly cashConstrainedProcurementDampingAtSeverePressure: number;
  /** これを超える現金圧力を「深刻」とみなし、調達を必要最小限へ寄せる。 */
  readonly severeCashPressureThreshold: number;

  /** 【SAI-4追加】設備投資しきい値（capexCurrentShortfallRatioThreshold）の、
   *  商品別の追加バイアス（比率。正の値＝そのぶんしきい値を下げて投資判断を早める、
   *  負の値＝遅らせる）。既定は空オブジェクト（全商品バイアスなし＝既存の
   *  capex.tsの計算式と完全に同じ結果になる）。5社異質モデルのD社（高付加価値型）
   *  が「PD・VAP能力不足が継続した場合の設備投資判断を少し早める」を、HOSOには
   *  影響させずPD/VAPだけに適用するための差し込み口。 */
  readonly capexShortfallThresholdBiasByProduct: Readonly<Partial<Record<Product, number>>>;

  // --- 【2026-08-05新設】Strategic Intent / Target Scale Band ---
  /**
   * 成長姿勢（strategicIntent.tsのStrategicGrowthPosture）ごとの、Target Scale Bandの
   * 算定倍率。基準（currentSustainableScaleTons、targetScale.ts参照）に対する
   * min/preferred/maxの倍率。8期先市場を精密予測しての決定ではなく、「経営感覚」
   * としての幅を表す（三宅さんご指示§4「だいたい16,000〜20,000t程度」のイメージ）。
   * 明示パラメータ化・文書化（STANDARD_AI_STRATEGIC_INTENT_AND_TARGET_SCALE.md）・
   * テスト（targetScale.test.ts）を必須とする（新しい恣意的なmagic numberの
   * 多用を避けるため、この1箇所に集約する）。
   */
  readonly targetScaleGrowthBandMultiplierByPosture: Readonly<
    Record<"DEFENSIVE" | "BALANCED_GROWTH" | "AGGRESSIVE_GROWTH", { readonly min: number; readonly preferred: number; readonly max: number }>
  >;
  /**
   * Target Scale算定時、当期実現売上（lastQuarterActualProductionByProduct等）と
   * 現在の実効生産能力のどちらを「現在の持続可能規模」の基準にするかを決める、
   * 生産能力側への重み（0〜1。0=実績のみ、1=能力のみ）。実績は変動が大きく
   * （新設会社のturn1は0等）、能力は据え置き型のため、両者を混合して急激な
   * ブレを避ける。
   */
  readonly targetScaleCapacityWeightInBaseline: number;
  /**
   * Target Scaleに対する現四半期の実効営業能力（realistic salesの総量換算）を、
   * 「Target Scale帯の範囲内」とみなす許容乖離（比率）。この範囲内であれば
   * SALES_CAPACITY_WITHIN_TARGET_BANDとし、追加の採用/減員提案は行わない
   * （三宅さんご指示§23 capacity bufferに対応する簡易版）。
   */
  readonly targetScaleWithinBandTolerance: number;

  // --- 【Phase DIV-3新設・DIV-4で意味を変更】Standard AI配当ポリシー ---
  /**
   * 【Phase DIV-4】基準配当性向。Standard AIが「配当してよい」と判断した年度末（Q4）に、
   * **直近確定四半期の当期純利益（flow）** の何割を配当するかの比率。
   *
   * 【DIV-3からの変更】DIV-3ではこの比率を`distributableEarnings`（game-start以降の
   * 累計利益stock）へ掛けていた。それは「過去利益を毎四半期一定割合ずつ繰り返し
   * 取り崩す」挙動になり、period payout policyの基準として正しくない（DIV-3
   * ベンチマークでratio=10%以上が会社の運転資金を枯渇させることも実測された）。
   * DIV-4では算定baseを当期純利益へ変更し、`distributableEarnings`は
   * `computeMaxDividendUsd`経由の **上限** としてのみ使う。
   *
   * 【値の由来】DIV-4実装指示§6「Flow + annual frequencyへ変更後、15%を中心値として
   * 再benchmark」に従い、10/15/20/25%（＋0%と、DIV-3暫定値5%のcontrol）を
   * scripts/tsvLeaderboardBenchmark.ts（Benchmark 3〜5）で比較した。15%は
   * 既存頑健性回帰CCI-9と同一条件の4seedすべてでPASSし、TSVもpayout ratioに対して
   * 全社一様には上昇しない（支配戦略化していない）ことを確認した中心値である。
   *
   * 【この値は「配当額の上限」ではない】実際の配当額は、必ず
   * finance/dividend.tsのcomputeMaxDividendUsd（＝min(Cash, distributableEarnings)、
   * Playerとまったく同じ単一の会計ソース）でクランプされる。AI専用の上限は作らない。
   *
   * 【経営性格バイアスの適用先】ManagementProfile.dividendPropensityRatioは、
   * 既存の他の比率バイアスとまったく同じ枠組み（±5%、最大±10%）で、この値に
   * 乗算される（managementProfile.tsのderiveStandardAiParameters参照）。
   *
   * 【0にすると配当ポリシー自体が無効化される】ベンチマークのAI配当OFF側は、
   * この値を0にすることで実現する（別のフラグ・別の分岐を増やさない）。
   */
  readonly dividendBasePayoutRatio: number;

  /**
   * 【Phase SAI-GROW-2】Growth Pressure / Adaptive Opportunity Share のパラメータ。
   * 未指定なら GROWTH_PRESSURE_PARAMETERS_V1（＝adaptive share有効）。
   * `adaptiveShareEnabled: false` を渡すと、機会shareが現行値に固定され
   * GROW-1以前と完全に同一のCommercial判断になる（ベンチマーク比較用）。
   */
  readonly growthPressure?: GrowthPressureParameters;
}

/**
 * SAI-1の既定パラメータ。値はいずれも実運用開始後の校正対象（暫定値）。
 * 5社すべてに同一の値を適用する。
 */
export const STANDARD_AI_PARAMETERS_V1: StandardAiParameters = {
  finishedGoodsTargetQuarters: 0.35,
  rawMaterialTargetQuarters: 0.4,
  inventoryCorrectionDamping: 0.5,

  excessInventoryRatioForDiscount: 1.3,
  maxDiscountRatioForExcessStock: 0.12,
  highUtilizationRatioForNoDiscount: 0.95,
  salesUtilizationTarget: 0.8,
  valueAddedOrderFactorBoost: 0,

  marketOrientationMultipliers: {},
  productOrientationMultipliers: {},
  growthTrendResponsiveness: 0,
  oversupplyRetreatSensitivity: 0,
  standardAiCapexExtensionsEnabled: false,
  capexGrowthEntryUtilizationThreshold: 0.85,
  capexGrowthEntryTrendPerQuarterThreshold: 0.004,
  capexOversupplyPressureThreshold: 1.2,
  lifecycleGrowthSalesBoostCap: 0.05,
  lifecycleGrowthSalesBoostScale: 10,
  supplyPressureRetreatThreshold: 1.14,
  supplyPressureRetreatFloor: 0.85,
  capexPdInUseUtilizationThreshold: 0.5,

  sustainedShortageQuarterThreshold: 2,
  sustainedExcessQuarterThreshold: 2,
  maxOvertimeRateForTransientShortage: 0.2,
  maxTemporaryRatioForTransientShortage: 0.35,
  regularHeadcountAdjustmentDamping: 0.5,

  cashBufferQuarters: 0.6,
  voluntaryPrepaymentMultiple: 2.5,
  minimumCashBufferFloorUsd: 5_000_000,
  desiredTermQuarters: 4,
  defaultExpectedRawPriceUsdPerKg: 2.5,
  typicalTemporaryHeadcountRatio: 0.15,
  typicalUtilizationForCashEstimate: 0.75,

  capexSustainedUtilizationThreshold: 0.92,
  capexCurrentShortfallRatioThreshold: 1.05,
  capexCashSafetyMultiple: 1.75,
  capexCashGateMode: "costBased",
  capexCostSafetyRatio: 0.5,
  capexMaxLoanToSizeRatio: 1.5,
  pdMechanizationMaxPaybackQuarters: 12,
  vapProductDevelopmentMaxAffordabilityQuarters: 3,
  vapProductDevelopmentMinHeadroomRatio: 0.1,
  // 【Phase PC-2A新設】Intensity（0〜1）を単純に三分割（tertile）するしきい値。
  // 実測データへの事後calibrationではなく、3要素平均という設計の対称性に基づく
  // 素朴な既定値（指示§43相当「初回calibration禁止」の精神を踏襲）。
  vapProductDevelopmentIntensityHighThreshold: 2 / 3,
  vapProductDevelopmentIntensityMediumThreshold: 1 / 3,
  qualityEquipmentNeedThreshold: 0.3,

  expectedAquacultureHarvestRatio: 0.9,
  aquacultureIntensity: 0.6,
  bioSecurityLevel: 0.6,

  importMixRatio: 0.15,
  minDomesticPurchaseRatioOfBase: 0.2,
  maxAquacultureShareOfRequirement: 0.35,
  cashConstrainedProcurementDampingAtSeverePressure: 0.5,
  severeCashPressureThreshold: 0.7,

  capexShortfallThresholdBiasByProduct: {},

  targetScaleGrowthBandMultiplierByPosture: {
    DEFENSIVE: { min: 0.9, preferred: 1.0, max: 1.1 },
    BALANCED_GROWTH: { min: 1.0, preferred: 1.15, max: 1.35 },
    AGGRESSIVE_GROWTH: { min: 1.1, preferred: 1.35, max: 1.6 },
  },
  // 【2026-08-05・三宅さんご指示§18対応】当初0.5（実績と能力の折半）としていたが、
  // 実績側（lastQuarterActualProductionByProduct）は四半期ごとの変動が大きく、
  // Target Scale Bandが毎期大きく動いてしまう（三宅さんご指示§18「Target Scaleは
  // 毎期激しく変えない」に抵触する挙動が実測で確認された）。実効生産能力
  // （effectiveCapacityByProduct）はcapex完了時以外変化しないため、これを基準の
  // 主軸とすることでTarget Scale Bandの粘着性を構造的に確保する（1.0=能力のみ）。
  targetScaleCapacityWeightInBaseline: 1.0,
  targetScaleWithinBandTolerance: 0.05,


  // 【Phase DIV-4】実装指示§6の中心値15%。Flow基準＋年1回へ変更したうえで
  // 10/15/20/25%を再benchmarkし、CCI-9頑健性・支配戦略診断ともに問題ないことを確認済み。
  dividendBasePayoutRatio: 0.15,
};

// ---------------------------------------------------------------------
// 会社規模の推定（現金バッファ・借入健全性しきい値の分母に使う）
// ---------------------------------------------------------------------

/**
 * 【SAI-1固有の設計判断・実装指示で明示要求】最低現金バッファは会社規模・四半期
 * 支出に連動させ、全社一律の絶対額（例: companyLab/parameters.tsの
 * AUTO_FINANCING_POLICY_PARAMETERS_V1.targetMinimumCashUsd = 40,000,000固定）を
 * 使わない。
 *
 * ここでは「会社の総処理能力（HOSO/PD/VAP合計）× 想定稼働率 × 想定原料単価」＋
 * 「常用ワーカー人件費（想定臨時ワーカー込み）」を、1四半期あたりの典型的な
 * 現金支出の目安として推定し、その定数倍（cashBufferQuarters）を最低現金バッファ
 * とする。会社の工場規模・人員規模が異なれば、この推定値も自然に異なる
 * （会社IDによる分岐ではなく、fixtureの実際の規模差に連動する）。
 *
 * 借入健全性の分母（capexMaxLoanToSizeRatio等）にも同じ推定値を再利用する。
 */
export function estimateQuarterlyScaleUsd(
  fixture: CompanyFixture,
  expectedRawPriceUsdPerKg: number,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): number {
  const totalCapacity = fixture.factories.reduce(
    (sum, f) => sum + unwrapUnit(f.hosoCapacity) + unwrapUnit(f.pdCapacity) + unwrapUnit(f.vapCapacity),
    0
  );
  const estimatedRawMaterialSpendUsd = totalCapacity * params.typicalUtilizationForCashEstimate * expectedRawPriceUsdPerKg * 1000;
  // HosoEqTons -> kg換算(*1000)してからUSD/kgで単価をかける（既存の数量・単価規約に合わせる）。

  const regularHeadcountTotal = fixture.workerBaseline.reduce((sum, w) => sum + w.regularHeadcount, 0);
  const typicalTemporaryHeadcount = regularHeadcountTotal * params.typicalTemporaryHeadcountRatio;
  // 人件費単価はfinance/parameters.tsが唯一の情報源（workforce.tsのcomputeQuarterlyLaborCostが
  // 内部でFINANCE_PARAMETERS_V1を参照する）。ここへ独自の単価を持ち込まない。
  const estimatedLaborCostUsd = computeQuarterlyLaborCost(regularHeadcountTotal, typicalTemporaryHeadcount).totalCostUsd;

  return estimatedRawMaterialSpendUsd + estimatedLaborCostUsd;
}

/** 会社規模に連動した最低現金バッファ（絶対下限つき）。 */
export function estimateTargetMinimumCashUsd(
  fixture: CompanyFixture,
  expectedRawPriceUsdPerKg: number,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): number {
  const scale = estimateQuarterlyScaleUsd(fixture, expectedRawPriceUsdPerKg, params);
  return Math.max(params.minimumCashBufferFloorUsd, scale * params.cashBufferQuarters);
}
