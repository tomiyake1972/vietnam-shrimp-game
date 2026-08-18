// ShrimpX V2 — Phase SAI-4: 標準AI 5社異質化（経営性格プロファイル）
//
// 【目的・非目標（三宅さんの指示 §1・§6・closing remark）】
// 「5種類の別AI」を作るのではない。全社は引き続き同一の判断ロジック
// （policy.ts・decision/*.ts）・同一の情報境界・同一の安全ガードを共有する
// （＝標準AIが共有する「合理性」そのものは一切変えない）。変えるのは、
// その合理的な判断が「何を重視するか」「状況をどう知覚するか」を決める
// 入力パラメータ（StandardAiParameters）の値だけであり、しかもその変化幅は
// 基準値に対して小幅（原則±5%、最大でも±10%）に限定する。
//
// 【会社IDによる分岐の集約（§6）】会社IDに応じた分岐は、本ファイルの
// MANAGEMENT_PROFILE_BY_COMPANY_ID という「一か所の対応表」だけに存在する。
// policy.ts・decision/*.ts の内部には一切 companyId による分岐を追加しない
// （decision/*.tsは既存どおり params の値を素直に使うだけ）。
//
// 【会社性格 vs 役員性格（§7・将来の二層設計）】本ファイルが定義する
// ManagementProfileは「会社としての経営性格」であり、将来構想されている
// 「役員個人の性格（営業本部長・CFO・生産本部長・戦略担当・CEO）」とは
// 意図的に分離された、別レイヤーの概念である。今回は会社性格レイヤーだけを
// 実装し、役員性格レイヤーとは絶対に混同しない（design/officerPersonaMemo.md
// 参照）。
//
// 【安全ガードとの関係（§1・§6）】現金危機対応・赤字回避・容量/在庫/資金制約・
// デフォルト回避に直結するフィールド（cashBufferQuarters・
// minimumCashBufferFloorUsd・capexCashSafetyMultiple・capexMaxLoanToSizeRatio・
// severeCashPressureThreshold・cashConstrainedProcurementDampingAtSeverePressure・
// capexSustainedUtilizationThreshold・expectedAquacultureHarvestRatio・
// aquacultureIntensity・bioSecurityLevel）は、経営性格プロファイルの適用対象
// から意図的に除外している。バイアスを掛けるのは「目標・選好・反応ペース」に
// 類するフィールドだけであり、安全ガードそのものの閾値は全社で完全に同一の
// ままとする。

import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "./parameters";
import { CompanyId } from "../../sales/types";
import { Product } from "../../market/types";

/** 経営性格プロファイルの識別子。5種類固定（三宅さんの指示§1）。 */
export type ManagementProfileId = "balanced" | "growth" | "conservative" | "valueAdded" | "opportunistic";

/**
 * 1件のバイアス適用結果（診断・監査用。§8「基準値→バイアス後」の追跡に使う）。
 * `ratio`が定義されている項目は「基準値に対する比率バイアス」、`absoluteDelta`が
 * 定義されている項目は「0基準の絶対値バイアス」（比率では表現できない、あるいは
 * 既定値が0のフィールド向け）。
 */
export interface AppliedManagementBiasItem {
  /** バイアス対象のStandardAiParametersフィールド名（capexShortfallThresholdBiasByProductはproduct込みで表現）。 */
  readonly field: string;
  /** 人間向けの説明（このバイアスが何を意味するか）。 */
  readonly meaning: string;
  readonly baseValue: number;
  readonly biasedValue: number;
  readonly ratio?: number;
  readonly absoluteDelta?: number;
}

/**
 * 経営性格プロファイル1件の定義。フィールドは「比率バイアス」（基準値に対する
 * ±割合）と「絶対値バイアス」（基準値が0、またはratioでは表現しづらいフィールド）
 * の2種類に分かれる。値の意味・許容範囲は下記MAX_BIAS_RATIO等を参照。
 */
export interface ManagementProfile {
  readonly id: ManagementProfileId;
  readonly label: string;
  readonly description: string;

  // --- 比率バイアス（基準値 × (1 + ratio)）。0 = バイアスなし。 ---
  /** 販売積極性：能力に対する目標販売数量の比率（salesUtilizationTarget）。 */
  readonly salesAggressivenessRatio: number;
  /** 値引き許容度：在庫過剰時の最大値引き率（maxDiscountRatioForExcessStock）。 */
  readonly discountToleranceRatio: number;
  /** 調達構成の輸入依存度（importMixRatio）。 */
  readonly importRelianceRatio: number;
  /** 在庫是正の反応速度（inventoryCorrectionDamping）。大きいほど早く反応。 */
  readonly inventoryResponsivenessRatio: number;
  /** 正社員人数調整ペース（regularHeadcountAdjustmentDamping）。大きいほど早く増減。 */
  readonly headcountPaceRatio: number;
  /** 養殖自給選好（maxAquacultureShareOfRequirement）。 */
  readonly aquacultureSelfSufficiencyRatio: number;
  /**
   * 【Phase SP-Q2追加】設備投資の慎重さ（capexCurrentShortfallRatioThreshold）。
   * 正の値ほど、投資判断のしきい値（≒どれだけ供給不足が続けば投資するか）が
   * 引き上げられ、投資が発動しにくくなる（＝より慎重）。PD/VAP限定の
   * valueAddedCapexTimingAbsoluteとは異なり、HOSO/PD/VAP/Common Processingの
   * 全投資判断へ一律に効く「財務保守性」の軸として、SP-Q1監査で発見した
   * 「conservativeプロファイルにCAPEX慎重さの接続先が無い」という構造的
   * ギャップを埋めるために追加した（既存フィールドで表現不能だったため新設。
   * capexHurdleBiasRatioという名前は、既存のcapexShortfallThresholdBiasByProduct
   * （PD/VAP限定・前倒し方向）と意味が重複しないよう、「hurdle＝投資のハードル」
   * という一般的な財務用語を採用した）。
   */
  readonly capexHurdleBiasRatio: number;
  /**
   * 【Phase DIV-3追加】配当性向（dividendBasePayoutRatio）。正の値ほど、
   * 「配当してよい」と判断したTurnに分配可能利益のうち配当へ回す割合が高くなる
   * （＝再投資より株主還元をやや優先する経営性格）。負の値はその逆（再投資優先）。
   *
   * 【capexHurdleBiasRatioとの関係】投資判断のハードル（capexHurdleBiasRatio）と
   * 対になる「資本配分の向き」の軸として設計している。ただし両者は独立した
   * フィールドであり、片方から自動導出はしない（プロファイルごとに明示的に置く）。
   *
   * 【この軸が動かせるのは配当額だけ】発火条件そのもの（財務健全性=healthy・
   * 当期の新規CAPEX提案なし・分配可能利益>0）は全社完全に同一であり、
   * 経営性格による差は一切付けない（安全ガードは全社同一という既存の原則、
   * 本ファイル冒頭コメント参照）。
   */
  readonly dividendPropensityRatio: number;

  // --- 絶対値バイアス（基準値が0のフィールド向け）。0 = バイアスなし。 ---
  /** 高付加価値(PD/VAP)受注選好（valueAddedOrderFactorBoost、0〜1スケールへの直接加算）。 */
  readonly valueAddedPreferenceAbsolute: number;
  /** PD/VAP設備投資の前倒し度合い（capexShortfallThresholdBiasByProduct.pd/vapへの直接加算）。 */
  readonly valueAddedCapexTimingAbsolute: number;
}

/** 比率バイアスの許容範囲（実装指示: 原則±5%、最大でも±10%）。 */
export const TYPICAL_BIAS_RATIO = 0.05;
export const MAX_BIAS_RATIO = 0.1;

/**
 * 絶対値バイアスの「参照基準」。比率で表現できない0基準フィールドについても
 * 「参照基準に対して最大10%相当まで」という同じ考え方を適用するための分母。
 * - valueAddedOrderFactorBoostは0〜1スケールの受注量係数への加算なので、
 *   参照基準=1.0（フルスケール）とし、最大絶対値=0.10。
 * - capexShortfallThresholdBiasByProductはcapexCurrentShortfallRatioThreshold
 *   （既定1.05）への加算なので、参照基準=1.05とし、最大絶対値=0.105。
 */
const VALUE_ADDED_PREFERENCE_REFERENCE_SCALE = 1.0;
const VALUE_ADDED_CAPEX_TIMING_REFERENCE_SCALE = STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold;

function assertWithinRatioBound(field: string, ratio: number): void {
  if (Math.abs(ratio) > MAX_BIAS_RATIO + 1e-9) {
    throw new Error(
      `[managementProfile] ${field}のバイアス比率(${ratio})が許容範囲(±${MAX_BIAS_RATIO})を超えています。実装指示（小幅な経営性格差）違反のため修正してください。`
    );
  }
}

function assertWithinAbsoluteBound(field: string, absoluteDelta: number, referenceScale: number): void {
  const ratioEquivalent = absoluteDelta / referenceScale;
  if (Math.abs(ratioEquivalent) > MAX_BIAS_RATIO + 1e-9) {
    throw new Error(
      `[managementProfile] ${field}の絶対値バイアス(${absoluteDelta})が参照基準(${referenceScale})に対して` +
        `許容範囲(±${MAX_BIAS_RATIO}相当)を超えています。`
    );
  }
}

/**
 * A社=balanced＝管理性格プロファイル無効時（STANDARD_AI_PARAMETERS_V1そのまま）と
 * 完全に同値であることを保証するための「ゼロプロファイル」。他4プロファイルは
 * このゼロ値からの差分としてのみ定義する。
 */
const ZERO_PROFILE_BIASES: Omit<ManagementProfile, "id" | "label" | "description"> = {
  salesAggressivenessRatio: 0,
  discountToleranceRatio: 0,
  importRelianceRatio: 0,
  inventoryResponsivenessRatio: 0,
  headcountPaceRatio: 0,
  aquacultureSelfSufficiencyRatio: 0,
  capexHurdleBiasRatio: 0,
  dividendPropensityRatio: 0,
  valueAddedPreferenceAbsolute: 0,
  valueAddedCapexTimingAbsolute: 0,
};

/**
 * 5プロファイルの定義一覧（実装指示§6「一か所で確認できる」の実体）。
 * 各値の意味・基準値・許容範囲はManagementProfileインターフェースのdocコメントと
 * 上記MAX_BIAS_RATIO等を参照。
 */
export const MANAGEMENT_PROFILES: Readonly<Record<ManagementProfileId, ManagementProfile>> = {
  // A社相当：baseline。management-profiles有効時でも、STANDARD_AI_PARAMETERS_V1と
  // 完全に同一の判断になることを自動テストで保証する（実装指示§6・closing remark）。
  balanced: {
    id: "balanced",
    label: "バランス型（A社基準）",
    description: "経営性格バイアスなし。STANDARD_AI_PARAMETERS_V1をそのまま使用する基準プロファイル。",
    ...ZERO_PROFILE_BIASES,
  },
  // B社相当：成長・シェア重視。能力を積極的に売り切りにいき、在庫過剰時も値引きで
  // 数量を守り、必要人員の確保も早めに動く。
  //
  // 【Phase SP-Q2・指示§4-8修正】輸入依存度バイアス（importRelianceRatio、旧値+0.05）を
  // 0へ変更した（削除）。root cause: MASS（growth×chinaVolume）のPROFILE ON実測で
  // 一部シナリオ/シードにOP-19%/Cash-51%/Crisis quarters増という一方的悪化が
  // 発生していた。Turn-by-Turn監査（scripts/spq2MassTurnByTurn.ts、baseline/seed-1）で
  // Turn10-12にMASSの国内買付実績が一時的にゼロへ落ち込むタイミングで
  // importMixRatio+5%が重なり、procurementConstraint.scaleRatioが0に張り付く
  // 自己強化型の崩壊（CM-1監査で既知のdomesticPurchaseCashAllocationRatio由来の
  // boom-bust cycleが、僅かな輸入比率シフトだけで不可逆側へ倒れる）を誘発することを
  // 確認した。Ablation監査（scripts/spq2MassAblation.ts）でimportRelianceRatio単独が
  // 崩壊のほぼ全てを再現する一方、他の軸（market/product orientation・sales
  // aggressiveness・headcount pace）は穏やかで方向性のある効果に留まることを
  // 確認済み（詳細はdocs/standard_ai/benchmarks/strategy_profile_spq2_report.md参照）。
  // Financeのしきい値・boom-bust周期自体は変更していない（指示§29の禁止事項）。
  growth: {
    id: "growth",
    label: "成長・シェア重視型（B社）",
    description:
      "販売数量・市場シェアを重視する経営性格。能力に対する目標販売比率をやや高め、" +
      "値引き許容度をやや高め、人員増強のペースをやや早める（いずれも+5%）。",
    ...ZERO_PROFILE_BIASES,
    salesAggressivenessRatio: 0.05,
    discountToleranceRatio: 0.05,
    headcountPaceRatio: 0.05,
    // 【Phase DIV-3】成長・シェア重視＝稼いだ利益は再投資へ回したい経営性格のため、
    // 基準配当性向をやや低め（-5%）にする（DIV-3設計提案§3案C-2の割当てどおり）。
    dividendPropensityRatio: -0.05,
  },
  // C社相当：財務保守・CFO視点。過剰な販売コミットや値引き、輸入依存、性急な
  // 人員固定費増加、単一調達チャネルへの集中を避け、在庫是正も急がず慎重に行う。
  // 【Phase SP-Q2・指示§14-17修正】capexHurdleBiasRatio: 0.05を新規追加。
  // root cause: SP-Q1監査で「CONSVのPD志向（productOrientation）は方向として妥当だが、
  // financial conservatismがCAPEX判断へ未接続」という構造的ギャップが判明した
  // （既存のconservativeプロファイルはsales/inventory/headcount/importの各ペースだけを
  // 抑制し、CAPEX投資判断のしきい値そのものには一切触れていなかった）。
  // capexShortfallThresholdBiasByProduct（既存、valueAddedプロファイル用）はPD/VAP
  // 限定の「前倒し」方向の差し込み口であり、意味も方向も異なるため転用しなかった。
  // 既存フィールドで表現不能なため、指示§17に基づき最小の新フィールドを追加した
  // （capexCurrentShortfallRatioThreshold自体への一般比率バイアス。HOSO/PD/VAP
  // ライン・Common Processingの投資判断すべてへ一律に効く。Finance側の現金バッファ・
  // 借入健全性しきい値・承認ゲートは一切変更しない＝指示§18のFinance Gate不可侵）。
  conservative: {
    id: "conservative",
    label: "財務保守型・CFO視点（C社）",
    description:
      "利益率・資金繰りの安定を重視する経営性格。目標販売比率をやや低め、値引き許容度・" +
      "輸入依存度・養殖自給比率をやや低め（-5%）、人員調整と在庫是正のペースをやや緩やかに（-5%）する。" +
      "設備投資判断のしきい値をやや引き上げ（+5%）、供給不足がより明確になるまで投資を待つ。" +
      "安全ガード（現金バッファ・借入健全性しきい値等）そのものは他社と完全に同一のまま。",
    ...ZERO_PROFILE_BIASES,
    salesAggressivenessRatio: -0.03,
    discountToleranceRatio: -0.05,
    importRelianceRatio: -0.05,
    inventoryResponsivenessRatio: -0.05,
    headcountPaceRatio: -0.05,
    aquacultureSelfSufficiencyRatio: -0.05,
    capexHurdleBiasRatio: 0.05,
    // 【Phase DIV-3】投資へは慎重（capexHurdleBiasRatio: +0.05）である一方、
    // 手元に積み上がった分配可能利益は株主へ配る、というCFO視点の資本配分として
    // 基準配当性向をやや高め（+5%）にする（DIV-3設計提案§3案C-2の割当てどおり）。
    dividendPropensityRatio: 0.05,
  },
  // D社相当：高付加価値（PD/VAP）重視。受注量係数を直接押し上げ、PD/VAP能力への
  // 設備投資判断をやや前倒しし、原料の自給（品質管理）をやや重視する。
  valueAdded: {
    id: "valueAdded",
    label: "高付加価値(PD/VAP)重視型（D社）",
    description:
      "PD/VAPを重視する経営性格。PD/VAP受注量係数への上乗せ、PD/VAP設備投資判断の前倒し、" +
      "養殖自給比率のやや高めの選好（+5%相当）で表現する。",
    ...ZERO_PROFILE_BIASES,
    aquacultureSelfSufficiencyRatio: 0.05,
    valueAddedPreferenceAbsolute: 0.05,
    valueAddedCapexTimingAbsolute: 0.05,
    // 【Phase DIV-3】PD/VAP能力への設備投資を前倒しする経営性格であり、
    // 資本配分としては再投資優先。基準配当性向をやや低め（-5%）にする
    // （DIV-3設計提案§3案C-2の割当てどおり）。
    dividendPropensityRatio: -0.05,
  },
  // E社相当：機会追求・反応の速さ。ただし新しい状態管理（記憶・カウンタ等）は
  // 一切追加せず、既存の「在庫是正の反応速度（inventoryCorrectionDamping）」
  // という既存パラメータの範囲内でのみ「反応の速さ」を表現する（実装指示§6の
  // 「無理に新しい状態管理を追加しない」という制約への対応）。振り子的な
  // 挙動を避けるため、比率は最大10%のうち8%にとどめ、既存の値引き閾値
  // （excessInventoryRatioForDiscount等のヒステリシス）には一切手を加えない。
  opportunistic: {
    id: "opportunistic",
    label: "機会追求・速い反応型（E社）",
    description:
      "市場の変化に早めに反応する経営性格。在庫是正の反応速度をやや高め（+8%）、" +
      "販売積極性をわずかに高め（+3%）で表現する。新規の状態管理（記憶・カウンタ等）は追加せず、" +
      "既存の閾値・変更幅制限（ヒステリシス）はそのまま維持することで、四半期ごとの" +
      "配分の乱高下（振り子的挙動）を防ぐ。",
    ...ZERO_PROFILE_BIASES,
    inventoryResponsivenessRatio: 0.08,
    salesAggressivenessRatio: 0.03,
    // 【Phase DIV-3】配当性向バイアスは置かない（0＝基準どおり）。DIV-3設計提案
    // §3案C-2が符号方向を明示しているのはconservative（+）とgrowth/valueAdded（-）
    // の3社だけであり、E社の「機会追求・速い反応」という物語からは配当性向の
    // 向きが一意に決まらないため、設計上の根拠が無い値を発明しない。
    // （E社は「既存の在庫是正速度・販売積極性の2項目だけをバイアス対象とする」
    // という設計を維持する。managementProfile.test.tsのappliedBiasItems=2件の
    // アサーションはこの設計の明示である。）
  },
};

/**
 * 会社ID→経営性格プロファイルの対応表（実装指示§6「一か所に集約」の実体、
 * companyIdによる分岐はここだけに存在する）。
 *
 * 【対応の由来】BAL/MASS/JPQ/VAP/CONSVはPhase 6.2由来の会社IDラベルであり、
 * 現在は（SAI-2の"moderate-pressure"標準ベースライン複製により）5社とも
 * 初期条件が完全に同一である。BAL→balanced、CONSV→conservative、
 * VAP→valueAddedはPhase 6.2のarchetype名（balanced/conservative/vapSpecialist）
 * と自然に対応する。MASS（massMarket＝大量生産・価格競争）はB社の成長・
 * シェア重視像と対応させた。JPQ（Phase 6.2では"japanQuality"）だけは
 * 対応する性格が残っていなかったため、消去法でE社（機会追求・速い反応）を
 * 割り当てた（Phase 6.2時点の"品質重視"という意味合いは今回のプロファイルには
 * 一切引き継いでいない。単なる会社IDラベルの再利用である）。
 */
export const MANAGEMENT_PROFILE_BY_COMPANY_ID: Readonly<Record<CompanyId, ManagementProfileId>> = {
  BAL: "balanced",
  MASS: "growth",
  JPQ: "opportunistic",
  VAP: "valueAdded",
  CONSV: "conservative",
};

/**
 * プロファイルの比率/絶対値バイアスを、指定した基準パラメータ(base)に適用し、
 * 派生StandardAiParametersと、適用したバイアス項目一覧（§8の基準値→バイアス後の
 * 追跡用）を返す。
 *
 * 【純粋関数・決定論】外部状態・乱数を一切使わない。同一のbase・profileなら常に
 * 同一の結果を返す。
 */
export function deriveStandardAiParameters(
  base: StandardAiParameters,
  profile: ManagementProfile
): {
  readonly params: StandardAiParameters;
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
} {
  const appliedBiasItems: AppliedManagementBiasItem[] = [];

  const applyRatio = (field: string, meaning: string, baseValue: number, ratio: number): number => {
    assertWithinRatioBound(field, ratio);
    const biasedValue = baseValue * (1 + ratio);
    if (ratio !== 0) {
      appliedBiasItems.push({ field, meaning, baseValue, biasedValue, ratio });
    }
    return biasedValue;
  };

  const applyAbsolute = (field: string, meaning: string, baseValue: number, absoluteDelta: number, referenceScale: number): number => {
    assertWithinAbsoluteBound(field, absoluteDelta, referenceScale);
    const biasedValue = baseValue + absoluteDelta;
    if (absoluteDelta !== 0) {
      appliedBiasItems.push({ field, meaning, baseValue, biasedValue, absoluteDelta });
    }
    return biasedValue;
  };

  const salesUtilizationTarget = applyRatio(
    "salesUtilizationTarget",
    "販売積極性（能力に対する目標販売比率）",
    base.salesUtilizationTarget,
    profile.salesAggressivenessRatio
  );
  const maxDiscountRatioForExcessStock = applyRatio(
    "maxDiscountRatioForExcessStock",
    "値引き許容度（在庫過剰時の最大値引き率）",
    base.maxDiscountRatioForExcessStock,
    profile.discountToleranceRatio
  );
  const importMixRatio = applyRatio(
    "importMixRatio",
    "調達構成の輸入依存度",
    base.importMixRatio,
    profile.importRelianceRatio
  );
  const inventoryCorrectionDamping = applyRatio(
    "inventoryCorrectionDamping",
    "在庫是正の反応速度",
    base.inventoryCorrectionDamping,
    profile.inventoryResponsivenessRatio
  );
  const regularHeadcountAdjustmentDamping = applyRatio(
    "regularHeadcountAdjustmentDamping",
    "正社員人数調整ペース",
    base.regularHeadcountAdjustmentDamping,
    profile.headcountPaceRatio
  );
  const maxAquacultureShareOfRequirement = applyRatio(
    "maxAquacultureShareOfRequirement",
    "養殖自給選好",
    base.maxAquacultureShareOfRequirement,
    profile.aquacultureSelfSufficiencyRatio
  );
  const valueAddedOrderFactorBoost = applyAbsolute(
    "valueAddedOrderFactorBoost",
    "高付加価値(PD/VAP)受注選好",
    base.valueAddedOrderFactorBoost,
    profile.valueAddedPreferenceAbsolute,
    VALUE_ADDED_PREFERENCE_REFERENCE_SCALE
  );
  /**
   * 【Phase SP-Q2追加】設備投資の慎重さ。capexCurrentShortfallRatioThreshold
   * （HOSO/PD/VAPライン・Common Processingの投資判断すべてが読む、単一の基準しきい値）
   * へ比率バイアスを適用する。正の値ほどしきい値が上がり、投資が発動しにくくなる
   * （＝より慎重）。capexShortfallThresholdBiasByProduct（PD/VAP限定・前倒し方向の
   * 既存フィールド）とは意味も適用対象も異なる、独立した軸。
   */
  const capexCurrentShortfallRatioThreshold = applyRatio(
    "capexCurrentShortfallRatioThreshold",
    "設備投資の慎重さ（投資判断しきい値）",
    base.capexCurrentShortfallRatioThreshold,
    profile.capexHurdleBiasRatio
  );

  /**
   * 【Phase DIV-3追加】基準配当性向（dividendBasePayoutRatio）への比率バイアス。
   * 既存の各バイアスとまったく同じapplyRatio（±10%の自動チェックつき）を通す。
   * 配当の発火条件・上限（computeMaxDividendUsd）には一切影響しない。
   */
  const dividendBasePayoutRatio = applyRatio(
    "dividendBasePayoutRatio",
    "配当性向（分配可能利益のうち配当へ回す割合）",
    base.dividendBasePayoutRatio,
    profile.dividendPropensityRatio
  );

  // 【重要】バイアスが0（=A社balancedを含む大半のプロファイル）の場合は、baseの
  // capexShortfallThresholdBiasByProductをキー単位でも一切書き換えない（{}のままにする）。
  // 「0を明示的に書き込む」と、STANDARD_AI_PARAMETERS_V1（{}）とは値として同値でも
  // 構造的に異なるオブジェクトになり、A社=基準値と完全に同一という保証（deepEqual）が
  // 崩れてしまうため。
  const capexBiasProducts: readonly Product[] = ["pd", "vap"];
  const capexShortfallThresholdBiasByProduct: Partial<Record<Product, number>> = { ...base.capexShortfallThresholdBiasByProduct };
  if (profile.valueAddedCapexTimingAbsolute !== 0) {
    for (const product of capexBiasProducts) {
      const baseProductBias = base.capexShortfallThresholdBiasByProduct[product] ?? 0;
      capexShortfallThresholdBiasByProduct[product] = applyAbsolute(
        `capexShortfallThresholdBiasByProduct.${product}`,
        "PD/VAP設備投資の前倒し度合い",
        baseProductBias,
        profile.valueAddedCapexTimingAbsolute,
        VALUE_ADDED_CAPEX_TIMING_REFERENCE_SCALE
      );
    }
  }

  const params: StandardAiParameters = {
    ...base,
    salesUtilizationTarget,
    maxDiscountRatioForExcessStock,
    importMixRatio,
    inventoryCorrectionDamping,
    regularHeadcountAdjustmentDamping,
    maxAquacultureShareOfRequirement,
    valueAddedOrderFactorBoost,
    capexShortfallThresholdBiasByProduct,
    capexCurrentShortfallRatioThreshold,
    dividendBasePayoutRatio,
  };

  return { params, appliedBiasItems };
}

/**
 * 会社IDから、経営性格プロファイル適用後のStandardAiParametersを直接解決する
 * ヘルパー（policy.ts・capture.ts等の呼び出し元向け）。
 */
export function resolveManagementProfileParameters(
  companyId: CompanyId,
  base: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): {
  readonly profileId: ManagementProfileId;
  readonly profile: ManagementProfile;
  readonly params: StandardAiParameters;
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
} {
  // 【安全側フォールバック】未知のcompanyId（将来会社が追加された場合等）は
  // balanced（バイアスなし）にフォールバックする。5社構成である限りこの分岐は
  // 通らない。
  const profileId = MANAGEMENT_PROFILE_BY_COMPANY_ID[companyId] ?? "balanced";
  const profile = MANAGEMENT_PROFILES[profileId];
  const { params, appliedBiasItems } = deriveStandardAiParameters(base, profile);
  return { profileId, profile, params, appliedBiasItems };
}

/**
 * policy.ts の createStandardAiProvider({ resolveParams }) にそのまま渡せる形の
 * リゾルバを作る。会社IDによる分岐は、この関数が内部で呼ぶ
 * resolveManagementProfileParameters（＝MANAGEMENT_PROFILE_BY_COMPANY_IDという
 * 一か所の対応表）だけに存在し、policy.ts側には一切持ち込まない。
 */
export function createManagementProfileParamsResolver(
  base: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): (companyId: CompanyId) => {
  readonly params: StandardAiParameters;
  readonly profileId: ManagementProfileId;
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
} {
  return (companyId: CompanyId) => resolveManagementProfileParameters(companyId, base);
}
