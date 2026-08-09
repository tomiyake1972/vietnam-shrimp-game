// ShrimpX V2 — 工場スペース制約（Phase 8D-3新設）
//
// 【このモジュールが存在する理由】
//   Phase 8D以前、設備投資は「資金さえあればいくらでも増設できる」構造だった。
//   実際の工場には床面積という物理的な上限があり、「どの能力を増やすか」を選ぶ
//   ことが投資判断の中心になる。工場スペースを導入することで、能力・人員・
//   スペースの三者関係を通じた経営判断を学べるようにする。
//
// 【設計方針】
//   1. **係数はこのファイル1箇所に集約する。** 案件種別ごとのスペース所要量を
//      Reactコンポーネントやビューモデルへ散在させない。
//   2. **スペース総量は永続化を必須にしない。** Factory.totalFactorySpaceUnits が
//      設定されていればそれを使い、無ければ基礎能力と係数から決定論的に導出する。
//      これにより、Phase 8D以前に作成された既存ラボもそのまま読み込める。
//   3. **使用量・空き・使用率・警告は派生値であり保存しない。** 毎回この
//      ファイルの純粋関数から再計算する（実装指示§11「派生値を過剰に保存しない」）。
//   4. **二重予約を防ぐ。** 稼働中設備の使用量／建設中案件の予約量／今回選択した
//      案件、の3つを別々に数え、同じ案件を2回数えない。判定条件は
//      capex/capacityEffect.ts の isCapexProjectOperationalAt をそのまま使い、
//      「稼働開始済みか否か」の判定ロジックを複製しない。
//
// 【禁止事項】
//   - 既存設備の能力を、スペース不足を理由に遡って減らさない
//     （不足は警告と新規案件の承認拒否だけで表現する）。
//   - スペース係数をこのファイル以外へハードコードしない。
//   - スペース不足を理由に生産量を勝手に減らさない（生産エンジンは変更しない）。
//
// 【単位】
//   スペース単位（space unit）は「工場の設置床面積 1 m² 相当」とみなす抽象単位。
//   実在の工場の設計を再現するものではなく、ゲーム上「増設には場所が要る」ことを
//   一貫した数値で表現するための暫定値である（要校正）。

import { unwrapUnit } from "../core/units";
import { CompanyId } from "../sales/types";
import { Factory } from "./types";
import { resolveFactoryColdStorageCapacityTons } from "./coldStorage";

// ---------------------------------------------------------------------
// 1. スペースを占有する能力プール
// ---------------------------------------------------------------------

/**
 * スペースを占有する能力プール。capex の FutureCapacityEffectPlaceholder.targetProduct と
 * 完全に同じキー集合であり、投資案件の増強対象からそのままスペース所要量を導ける。
 */
export type SpaceConsumingPoolKey = "commonProcessing" | "hoso" | "pd" | "vap" | "freezingPackaging" | "coldStorage";

export const SPACE_CONSUMING_POOL_KEYS: readonly SpaceConsumingPoolKey[] = [
  "commonProcessing",
  "hoso",
  "pd",
  "vap",
  "freezingPackaging",
  "coldStorage",
];

// ---------------------------------------------------------------------
// 2. パラメータ（唯一の集約地点）
// ---------------------------------------------------------------------

export interface FactorySpaceParameters {
  readonly parametersVersion: string;
  /**
   * 能力1トンあたりのスペース所要量（スペース単位）。
   *
   * commonProcessing / hoso / pd / vap / freezingPackaging は「トン／四半期」あたり、
   * coldStorage だけは「同時保管トン」あたりである（フローとストックで基準量の
   * 意味が異なるため、係数の水準も直接比較できない）。
   *
   * 【値の根拠（暫定値・要校正）】既存fixtureの能力構成（BAL: 共通22,000／
   * HOSO 10,000／PD 8,000／VAP 6,000／凍結包装20,000）に対して、
   * 「工程が複雑なほど、同じ数量を処理するのに広い場所が要る」という順序関係
   * （VAP > PD > HOSO > 共通前処理 > 凍結・包装）が出るように設定した。
   * 保管は棚・通路を含めて床を大きく占有するため、単位あたりの係数を最も高くしている。
   */
  readonly spaceUnitsPerCapacityTon: Readonly<Record<SpaceConsumingPoolKey, number>>;
  /**
   * 能力を増やさない案件（品質管理設備・排水環境設備）の固定スペース所要量。
   * 能力あたりの係数では表現できないため、案件種別ごとの固定値として持つ。
   * キーは capex の CapitalProjectType 文字列だが、capex/ を import すると
   * 循環参照になるため string キーとして保持する（未登録の種別は0）。
   */
  readonly fixedSpaceUnitsByProjectType: Readonly<Record<string, number>>;
  /**
   * Factory.totalFactorySpaceUnits が未設定のときに、基礎能力から総量を導出する
   * 余裕率。総量 ＝ 基礎能力の占有スペース × (1 + この値)。
   *
   * 【値の根拠（暫定値・要校正）】0.05（5%）。既存fixtureのBALでは基礎占有
   * 約87,400スペース単位に対し空き約4,370スペース単位となり、標準的な案件
   * （HOSO増設500t＝500、VAP増設250t＝625、冷凍保管増設1,250t＝2,500）を
   * 2〜3件は実行できるが、無制限には増設できない水準になる。同時進行中案件数の
   * 上限（capexのmaxConcurrentActiveProjectsPerCompany＝3）とおおむね釣り合う。
   */
  readonly defaultSpaceHeadroomRatio: number;
  /** この使用率を超えたら「逼迫」警告を出す（0〜1）。 */
  readonly tightUtilizationThreshold: number;
  /** 面積比較に使う許容誤差（浮動小数点誤差の吸収用）。 */
  readonly epsilonSpaceUnits: number;
}

export const FACTORY_SPACE_PARAMETERS_V1: FactorySpaceParameters = {
  parametersVersion: "factorySpace-v0.1",
  spaceUnitsPerCapacityTon: {
    commonProcessing: 0.8,
    // 【2026-08-09・Test16】商品別の床面積負荷を HOSO : PD : VAP = 1 : 2 : 3 にする。
    //   HOSO … 低加工度・単純ライン。単位能力あたりの必要スペースが最も小さい
    //   PD   … 中加工度。HOSOよりスペースを使う
    //   VAP  … 高加工度・多工程。最もスペースを使う
    // 係数は「能力1トンあたりのスペース単位」なので、この値そのものが
    // 1,000tあたりへ正規化した比率になっている（1,000 : 2,000 : 3,000）。
    // 旧値は 1.0 / 1.6 / 2.5 で、意図した比率より PD・VAP が軽かった。
    hoso: 1.0,
    pd: 2.0,
    vap: 3.0,
    freezingPackaging: 0.6,
    coldStorage: 2.0,
  },
  fixedSpaceUnitsByProjectType: {
    qualityControlEquipment: 600,
    environmentalEquipment: 900,
  },
  // 【2026-08-09・Test16】0.05 → 0.15。
  //
  // 総スペースは「初期能力が占める面積 × (1 + この比率)」で決まる。5%では
  // MASS の空きが 5,180 単位しかなく、HOSOライン増設1件（+4,000t × 係数1.0 =
  // 4,000単位）を1回入れた時点で満杯になっていた。その結果、HOSO能力の明示上限
  // 24,000t に対して**既存工場では16,000tまでしか到達できない**という、
  // 上限設計とスペース制約の不整合が生じていた（実測: docs/standard_ai/
  // TEST16_STAGE_E_FINAL_REPORT.md §5）。
  //
  // MASS が初期12,000tから24,000tへ到達するには HOSO増設3回 = 12,000スペース単位が
  // 要る。新係数での MASS の初期使用量は 108,000 単位なので、必要な比率は
  //   12,000 / 108,000 = 11.1%
  // が下限になる。品質管理設備（600）・排水環境設備（900）等の固定スペース案件や
  // 進行中案件の予約と併存できる余裕を見て 15% とした。
  //
  // 【新工場の価値を消していないこと】この比率は工場1棟あたりの余裕であり、
  // 棟を増やさなければ増えない。VAP は係数3.0のため、同じ能力を積むのに
  // HOSO の3倍の面積を要し、既存工場だけでは早期に頭打ちになる。
  defaultSpaceHeadroomRatio: 0.15,
  tightUtilizationThreshold: 0.9,
  epsilonSpaceUnits: 1e-6,
};

// ---------------------------------------------------------------------
// 3. 能力 → スペース使用量
// ---------------------------------------------------------------------

/** 工場の各能力プールの数量（トン）。coldStorageだけは同時保管トン。 */
export interface CapacityQuantitiesByPool {
  readonly commonProcessing: number;
  readonly hoso: number;
  readonly pd: number;
  readonly vap: number;
  readonly freezingPackaging: number;
  readonly coldStorage: number;
}

/**
 * Factory の**名目**能力からプール別数量を取り出す。
 * 実効能力（基準稼働率・設備利用可能率適用後）ではなく名目能力を使うのは、
 * 設備が占有する床面積は稼働率で増減しないためである。
 */
export function readCapacityQuantities(factory: Factory): CapacityQuantitiesByPool {
  return {
    commonProcessing: unwrapUnit(factory.commonProcessingCapacity),
    hoso: unwrapUnit(factory.hosoCapacity),
    pd: unwrapUnit(factory.pdCapacity),
    vap: unwrapUnit(factory.vapCapacity),
    freezingPackaging: unwrapUnit(factory.freezingPackagingCapacity),
    coldStorage: resolveFactoryColdStorageCapacityTons(factory),
  };
}

/** プール別の能力数量から、占有スペース（スペース単位）を求める。 */
export function computeSpaceUnitsForCapacities(
  quantities: CapacityQuantitiesByPool,
  params: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): number {
  let total = 0;
  for (const pool of SPACE_CONSUMING_POOL_KEYS) {
    const qty = quantities[pool];
    if (!Number.isFinite(qty) || qty <= 0) continue;
    total += qty * params.spaceUnitsPerCapacityTon[pool];
  }
  return total;
}

/** 1工場が現在占有しているスペース（スペース単位）。 */
export function computeFactoryUsedSpaceUnits(factory: Factory, params: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1): number {
  return computeSpaceUnitsForCapacities(readCapacityQuantities(factory), params);
}

/**
 * Factory.totalFactorySpaceUnits が未設定のときの工場スペース総量（スペース単位）。
 * 基礎能力の占有スペース × (1 + 余裕率) として決定論的に導出する。
 *
 * 【必ず「基礎」Factoryを渡すこと】設備投資で能力が増えたあとのFactoryを渡すと
 * 総量まで一緒に増えてしまい、スペース制約が意味を失う。呼び出し側は
 * CompanyFixture.factories（capex加算前）を渡す。
 */
export function deriveDefaultFactorySpaceUnits(baseFactory: Factory, params: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1): number {
  const baseUsed = computeFactoryUsedSpaceUnits(baseFactory, params);
  return baseUsed * (1 + params.defaultSpaceHeadroomRatio);
}

/** 工場スペース総量（スペース単位）。明示値があればそれを、なければ既定値を返す。 */
export function resolveFactoryTotalSpaceUnits(baseFactory: Factory, params: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1): number {
  if (baseFactory.totalFactorySpaceUnits !== undefined) {
    const explicit = baseFactory.totalFactorySpaceUnits;
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  }
  return deriveDefaultFactorySpaceUnits(baseFactory, params);
}

// ---------------------------------------------------------------------
// 4. 投資案件のスペース所要量
// ---------------------------------------------------------------------

/**
 * 1件の投資案件が必要とするスペース（スペース単位）。
 *   - 能力を増やす案件: 増加能力量 × プール別係数
 *   - 能力を増やさない案件（品質・環境設備）: 案件種別ごとの固定値
 * 案件のスペース所要量を、承認済み案件（スナップショット）と候補（テンプレート）の
 * どちらからでも同じ式で求められるよう、増強対象と増加量だけを引数に取る。
 */
export function computeProjectRequiredSpaceUnits(
  input: {
    readonly projectType: string;
    readonly targetPool?: SpaceConsumingPoolKey;
    readonly capacityIncreaseTons?: number;
  },
  params: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): number {
  const increase = input.capacityIncreaseTons ?? 0;
  if (input.targetPool !== undefined && Number.isFinite(increase) && increase > 0) {
    return increase * params.spaceUnitsPerCapacityTon[input.targetPool];
  }
  return params.fixedSpaceUnitsByProjectType[input.projectType] ?? 0;
}

// ---------------------------------------------------------------------
// 5. 1工場・1社ぶんのスペース状態
// ---------------------------------------------------------------------

/** 建設中・完成準備中の案件1件ぶんの予約情報（呼び出し側が組み立てて渡す）。 */
export interface PendingSpaceReservation {
  readonly projectId: string;
  readonly projectType: string;
  readonly requiredSpaceUnits: number;
}

export interface FactorySpaceState {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  /** 工場スペース総量。 */
  readonly totalSpaceUnits: number;
  /**
   * 稼働中設備が使用しているスペース。能力プール由来のスペース（currentFactoryの
   * 能力から算出）に加え、稼働開始済みの「能力増加を伴わない固定スペース案件」
   * （品質管理設備・排水環境設備等）の固定スペースも含む（Phase 8D監査M-1修正。
   * buildCompanyFactorySpaceStateがcomputeOperationalFixedSpaceUnitsで算出して渡す）。
   */
  readonly usedByOperationalSpaceUnits: number;
  /** 建設中・完成準備中の案件が予約しているスペース。 */
  readonly reservedByPendingSpaceUnits: number;
  /**
   * 現在の空きスペース（＝総量 − 稼働中設備の使用スペースのみ。建設中案件の予約は
   * 含めない。負にはしない）。「今すぐ他の用途に転用できる余地」ではなく
   * 「現時点で物理的に空いている床面積」を表す（Phase 8D監査L-2修正）。
   */
  readonly freeSpaceUnits: number;
  /** 投資完成後の使用量（稼働中 ＋ 予約）。 */
  readonly usedAfterPendingSpaceUnits: number;
  /**
   * 投資完成後の空きスペース（＝総量 − 稼働中設備の使用スペース − 建設中案件の
   * 予約スペース。負にはしない）。新規案件の承認判定はこちら（＝usedAfterPendingSpaceUnits
   * 経由）を使う。表示上は freeSpaceUnits と区別すること（Phase 8D監査L-2修正）。
   */
  readonly freeAfterPendingSpaceUnits: number;
  /** 使用率（総量が0のときはundefined。0で埋めない）。 */
  readonly utilizationRate: number | undefined;
  /** 投資完成後の使用率（総量が0のときはundefined）。 */
  readonly utilizationRateAfterPending: number | undefined;
  /** 不足量（投資完成後の使用量が総量を超えるぶん。超えていなければ0）。 */
  readonly shortfallSpaceUnits: number;
  readonly isShortage: boolean;
  readonly isTight: boolean;
  readonly pendingReservations: readonly PendingSpaceReservation[];
}

export interface BuildFactorySpaceStateInput {
  /** 基礎Factory（CompanyFixture.factories。capex加算前）。総量の導出に使う。 */
  readonly baseFactory: Factory;
  /** 当期の実効Factory（applyCapexCapacityToFactories 適用後）。稼働中使用量の算出に使う。 */
  readonly currentFactory: Factory;
  /** この工場に紐づく、建設中・完成準備中の案件の予約一覧。 */
  readonly pendingReservations: readonly PendingSpaceReservation[];
  /**
   * 稼働開始済みの「能力増加を伴わない固定スペース案件」（品質管理設備・排水環境
   * 設備等）が占有している固定スペースの合計（スペース単位）。
   *
   * 【Phase 8D監査M-1】computeFactoryUsedSpaceUnits(currentFactory) は能力プール由来の
   * スペースしか合算できない。能力を増やさない案件は、稼働開始した瞬間に
   * pendingReservations から外れる（isCapexProjectOperationalAtがtrueになるため）
   * 一方で、能力プールにも反映されないため、何もしなければ占有スペースが消失する。
   * これを防ぐため、呼び出し側（capex/factorySpace.tsのbuildCompanyFactorySpaceState）
   * が稼働開始済み・取消以外の固定スペース案件の所要量を合算してここへ渡し、
   * usedByOperationalSpaceUnits へ加算する。能力増設案件はこの値に含めない
   * （能力プール経由で既に数えられているため、含めると二重計上になる）。
   * 省略時は0（Phase 8D以前の呼び出し元との後方互換）。
   */
  readonly operationalFixedSpaceUnits?: number;
  readonly params?: FactorySpaceParameters;
}

/**
 * 1工場ぶんのスペース状態を組み立てる。
 *
 * 【二重計上を防ぐ考え方】
 *   稼働中使用量は「当期の実効Factoryの能力」から求める。稼働開始済みの案件は
 *   すでにこの能力へ反映されているため、案件としては数えない。予約量は
 *   「まだ稼働開始していない案件」だけを数える。したがって、同じ案件が
 *   稼働中と予約の両方に現れることはない（振り分けは呼び出し側が
 *   isCapexProjectOperationalAt で行い、その判定ロジックは複製しない）。
 */
export function buildFactorySpaceState(input: BuildFactorySpaceStateInput): FactorySpaceState {
  const params = input.params ?? FACTORY_SPACE_PARAMETERS_V1;
  const totalSpaceUnits = resolveFactoryTotalSpaceUnits(input.baseFactory, params);
  const operationalFixedSpaceUnits = Math.max(0, input.operationalFixedSpaceUnits ?? 0);
  const usedByOperationalSpaceUnits = computeFactoryUsedSpaceUnits(input.currentFactory, params) + operationalFixedSpaceUnits;
  const reservedByPendingSpaceUnits = input.pendingReservations.reduce((sum, r) => sum + Math.max(0, r.requiredSpaceUnits), 0);

  const usedAfterPendingSpaceUnits = usedByOperationalSpaceUnits + reservedByPendingSpaceUnits;
  // 【Phase 8D監査L-2修正】freeSpaceUnits（現在の空き）は予約を差し引かない。
  // 予約まで差し引いた値は freeAfterPendingSpaceUnits として別に持つ。
  const freeSpaceUnits = Math.max(0, totalSpaceUnits - usedByOperationalSpaceUnits);
  const freeAfterPendingSpaceUnits = Math.max(0, totalSpaceUnits - usedAfterPendingSpaceUnits);
  const shortfallSpaceUnits = Math.max(0, usedAfterPendingSpaceUnits - totalSpaceUnits);

  return {
    factoryId: input.baseFactory.factoryId,
    companyId: input.baseFactory.companyId,
    totalSpaceUnits,
    usedByOperationalSpaceUnits,
    reservedByPendingSpaceUnits,
    freeSpaceUnits,
    usedAfterPendingSpaceUnits,
    freeAfterPendingSpaceUnits,
    utilizationRate: totalSpaceUnits > 0 ? usedByOperationalSpaceUnits / totalSpaceUnits : undefined,
    utilizationRateAfterPending: totalSpaceUnits > 0 ? usedAfterPendingSpaceUnits / totalSpaceUnits : undefined,
    shortfallSpaceUnits,
    isShortage: shortfallSpaceUnits > params.epsilonSpaceUnits,
    isTight: totalSpaceUnits > 0 && usedAfterPendingSpaceUnits / totalSpaceUnits >= params.tightUtilizationThreshold,
    pendingReservations: input.pendingReservations,
  };
}

/** 1社ぶん（全工場合計）のスペース状態。 */
export interface CompanyFactorySpaceState {
  readonly companyId: CompanyId;
  readonly factories: readonly FactorySpaceState[];
  readonly totalSpaceUnits: number;
  readonly usedByOperationalSpaceUnits: number;
  readonly reservedByPendingSpaceUnits: number;
  /** 現在の空き（総量 − 稼働中設備の使用スペースのみ）を全工場合計したもの。 */
  readonly freeSpaceUnits: number;
  readonly usedAfterPendingSpaceUnits: number;
  /** 投資完成後の空き（総量 − 稼働中 − 予約）を全工場合計したもの。 */
  readonly freeAfterPendingSpaceUnits: number;
  readonly utilizationRate: number | undefined;
  readonly utilizationRateAfterPending: number | undefined;
  readonly shortfallSpaceUnits: number;
  readonly isShortage: boolean;
  readonly isTight: boolean;
}

export function aggregateCompanyFactorySpaceState(
  companyId: CompanyId,
  factories: readonly FactorySpaceState[],
  params: FactorySpaceParameters = FACTORY_SPACE_PARAMETERS_V1
): CompanyFactorySpaceState {
  const totalSpaceUnits = factories.reduce((s, f) => s + f.totalSpaceUnits, 0);
  const usedByOperationalSpaceUnits = factories.reduce((s, f) => s + f.usedByOperationalSpaceUnits, 0);
  const reservedByPendingSpaceUnits = factories.reduce((s, f) => s + f.reservedByPendingSpaceUnits, 0);
  const usedAfterPendingSpaceUnits = usedByOperationalSpaceUnits + reservedByPendingSpaceUnits;
  // 不足は工場ごとに判定した合計を使う（全社合計では、ある工場の余りが別の工場の
  // 不足を打ち消してしまい、実際には設置できないのに「余裕あり」に見えてしまうため）。
  const shortfallSpaceUnits = factories.reduce((s, f) => s + f.shortfallSpaceUnits, 0);

  return {
    companyId,
    factories,
    totalSpaceUnits,
    usedByOperationalSpaceUnits,
    reservedByPendingSpaceUnits,
    freeSpaceUnits: factories.reduce((s, f) => s + f.freeSpaceUnits, 0),
    usedAfterPendingSpaceUnits,
    freeAfterPendingSpaceUnits: factories.reduce((s, f) => s + f.freeAfterPendingSpaceUnits, 0),
    utilizationRate: totalSpaceUnits > 0 ? usedByOperationalSpaceUnits / totalSpaceUnits : undefined,
    utilizationRateAfterPending: totalSpaceUnits > 0 ? usedAfterPendingSpaceUnits / totalSpaceUnits : undefined,
    shortfallSpaceUnits,
    isShortage: shortfallSpaceUnits > params.epsilonSpaceUnits,
    isTight: factories.some((f) => f.isTight),
  };
}

/** 画面・Excelが共通で使う、工場スペースの説明文。 */
export const FACTORY_SPACE_EXPLANATION_TEXT =
  "工場スペースは、設備を設置できる床面積の総枠です。稼働中の設備が使用しているぶんと、建設中の投資案件が予約しているぶんの合計が総量を超える投資案件は承認されません。" +
  "資金があっても場所が無ければ増設できないため、「どの能力を増やすか」を選ぶ必要があります。";

export const FACTORY_SPACE_UNIT_LABEL = "スペース単位";
