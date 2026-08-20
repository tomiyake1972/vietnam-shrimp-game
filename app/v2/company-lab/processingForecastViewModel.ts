// ShrimpX V2 — 会社経営統合テスト環境 「現在の入力に基づく処理見込み」表示用データ層
//
// 意思決定画面（生産計画の希望量・優先度・ワーカー配置を編集中）とExcel Exportの
// 両方が、同一の導出でプレイヤーへ「この入力のままなら各商品がどれだけ処理される
// 見込みか」を示すための唯一の表示用データ層である。
//
// 【この層が独自計算を持たない理由（最重要）】
//   処理見込みは、生産処理エンジンの純粋関数 allocateProductionPlans
//   （app/lib/v2/production/allocation.ts）を、状態を変更せずそのまま呼んで得る。
//   allocateProductionPlansは「入力（plans/factories/workerAssignments/
//   rawMaterialLots）は一切変更しない」純粋関数であり（同ファイル冒頭のコメント）、
//   四半期処理本体（production/runner.ts:62）が呼ぶのと同じ関数・同じ引数順である。
//   したがって、UI側に「簡易的な先着配分」などの別計算を新設してはならない。
//   優先順位の解釈・同順位の解決・能力プールの適用順序・歩留まりの適用箇所は、
//   すべてエンジン側の実装が唯一の情報源である。
//
// 【エンジンをコード上で確認した結果（この層の前提。推測ではない）】
//   1. 優先度の向き: 数字が小さいほど優先度が高い。
//      priorityAllocation.ts が Array.from(new Set(priorities)).sort((a,b)=>a-b)
//      の順に予算を配る（CompanyProductionPlanEntry.priorityのdoc commentも
//      「小さいほど優先度が高い」と明記）。
//   2. 同順位の解決: 先着順ではない。同一priorityの計画を1つの階層としてまとめ、
//      rawMaterials/waterFill.ts の水位法（weight = cap = 希望量）で比例配分する。
//      waterFillAllocateは入力配列の順序に一切依存しない。使い切らなかった予算は
//      次の（より低い）優先度階層へ繰り越される。
//   3. 能力の適用順序（allocation.ts §Phase 6.1修正）:
//        段階1 原料           … 会社単位の共有プール・原料HOSO換算量
//        段階2 工場共通処理能力 … 工場単位の共有プール・原料投入HOSO換算量
//        段階3 冷凍・包装能力   … 工場単位の共有プール・完成品HOSO換算量
//        段階4 商品別設備能力   … 工場×商品単位の専用プール・完成品HOSO換算量
//        段階5 有効労働能力     … 工場単位の共有ワーカープール
//      冷凍・包装能力は商品別能力より「先」に適用される（この順序は実装どおりで
//      あり、直感的な順序とは異なる）。
//   4. 希望量が商品別実効能力を超えた場合: 段階4でその能力までクリップされ、
//      shortfallReasonsに "productCapacityShortage" が入る。
//   5. 能力消費量の基準: 段階1・2は「原料投入量」、段階3・4・5は「完成品数量」。
//      歩留まり（params.yield.saleableRecoveryRatio）は段階2→3の1箇所でのみ
//      適用される（physicalYieldRatioはHOSO換算量には一切使わない）。
//   6. 原料不足・人員制約: いずれも見込み計算に含まれる（段階1・段階5）。
//
// 【禁止事項】
//   - allocateProductionPlans / calculateFactoryEffectiveCapacity /
//     applyCapexCapacityToFactories を再実装しない。必ず呼び出す。
//   - 「VAPの処理可能量は約810t」のような、優先度に依存する値を固定値として
//     持たない・返さない。返す値は常に「現在の入力」から導出したものに限る。
//   - コードに存在しない能力補正要因（人員充足率・工場保守状態・設備立ち上がり・
//     品質リスク等）を作らない。実在するのは baseUtilizationRate と
//     equipmentAvailabilityRate の2つだけである（capacity.ts の applyRates）。
//   - 見込みを確定結果として表示しない（呼び出し側はFORECAST_HEADING_TEXTと
//     forecastCaveatTextsを必ず併記する）。

import { PeriodV2 } from "../../lib/v2/core/period";
import { unwrapUnit } from "../../lib/v2/core/units";
import { Product } from "../../lib/v2/market/types";
import { CompanyId } from "../../lib/v2/sales/types";
import { RawMaterialLot } from "../../lib/v2/rawMaterials/types";
import {
  CompanyProductionPlanEntry,
  Factory,
  ProductionShortfallReason,
  WorkerAssignment,
} from "../../lib/v2/production/types";
import { allocateProductionPlans } from "../../lib/v2/production/allocation";
import { calculateFactoryEffectiveCapacity } from "../../lib/v2/production/capacity";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../../lib/v2/production/parameters";
import { CapexState, computeEffectiveFactories } from "../../lib/v2/capex";
import type { FactoryLifecycleStateTable } from "../../lib/v2/capex/factoryLifecycle";
import { formatHosoEqTons } from "../../lib/v2/industryLab/ui/formatters";
import { CAPACITY_POOL_DESCRIPTIONS, CAPACITY_POOL_LABELS, CAPACITY_POOL_KEYS, CapacityPoolKey } from "./processingCapacityViewModel";
import { PRODUCT_LABELS } from "./marketPriceViewModel";

// ---------------------------------------------------------------------
// 1. 見出し・注記の文言（画面とExcelで同じ文言を使う）
// ---------------------------------------------------------------------

/** この表が確定結果ではないことを必ず明示する見出し。 */
export const FORECAST_HEADING_TEXT = "現在の入力に基づく処理見込み";

/** 名目能力→実効能力の計算式（画面・Excelの両方に明示する）。 */
export const EFFECTIVE_CAPACITY_FORMULA_TEXT = "実効能力 ＝ 名目能力 × 基準稼働率 × 設備利用可能率";

/** 優先順位の解釈（エンジン実装どおりの説明）。 */
export const PRIORITY_RULE_TEXT =
  "優先度は数字が小さいほど優先されます。同じ優先度の商品は先着順ではなく、希望量に比例して配分されます（水位法）。上位優先度で使い切らなかった能力だけが下位優先度へ回ります。";

/** 能力プールが適用される順序（エンジン実装どおり。直感的な順序とは異なるため明示する）。 */
export const CONSTRAINT_ORDER_TEXTS: readonly string[] = [
  "① 原料在庫（会社単位の共有・原料投入量ベース）",
  "② 工場共通処理能力（工場単位の共有・原料投入量ベース）",
  "③ 冷凍・包装能力（工場単位の共有・完成品量ベース）",
  "④ 商品別設備能力（工場×商品単位の専用・完成品量ベース）",
  "⑤ 有効労働能力（工場単位の共有ワーカープール）",
];

/** 歩留まりがどこで一度だけ適用されるか。 */
export const YIELD_APPLICATION_TEXT =
  "歩留まり（販売可能回収率）は②と③の間で一度だけ適用されます。①②は原料投入量、③④⑤は完成品量が能力消費量の基準です。";

// ---------------------------------------------------------------------
// 2. 実効率の内訳（実在する2要因のみ）
// ---------------------------------------------------------------------

/**
 * 実効率を構成する補正要因のキー。production/capacity.ts の applyRates が
 * 掛け合わせている値は、Factory.baseUtilizationRate と
 * Factory.equipmentAvailabilityRate の2つだけである。これ以外の要因は
 * コード上に存在しないため、ここへ追加してはならない。
 */
export type CapacityRateFactorKey = "baseUtilizationRate" | "equipmentAvailabilityRate";

export const CAPACITY_RATE_FACTOR_KEYS: readonly CapacityRateFactorKey[] = ["baseUtilizationRate", "equipmentAvailabilityRate"];

export const CAPACITY_RATE_FACTOR_LABELS: Readonly<Record<CapacityRateFactorKey, string>> = {
  baseUtilizationRate: "基準稼働率（計画上の標準操業度）",
  equipmentAvailabilityRate: "設備利用可能率（故障・保全による可用性）",
};

export interface CapacityRateFactor {
  readonly key: CapacityRateFactorKey;
  readonly label: string;
  readonly value: number;
}

/** 1能力プールぶんの「名目 → 実効」の説明行。 */
export interface CapacityEffectiveRateRow {
  readonly poolKey: CapacityPoolKey;
  readonly poolLabel: string;
  readonly poolDescription: string;
  readonly nominalTons: number;
  readonly effectiveTons: number;
  /**
   * 表示用の実効率。名目能力が0のときはundefined（0で埋めない）。
   * 「名目能力 × 実効率 ＝ 実効能力」が表示上も成り立つよう、要因の積ではなく
   * 実効能力÷名目能力として導出する（エンジンは実効能力を小数2桁へ丸めるため、
   * 要因の積をそのまま使うと丸めぶんだけ一致しなくなる）。
   */
  readonly effectiveRate: number | undefined;
  /** 実効率を構成する補正要因（実在する2要因のみ）。工場ごとに値が異なる場合は空配列。 */
  readonly factors: readonly CapacityRateFactor[];
  /** 補正要因の積（factorsが空のときはundefined）。effectiveRateとの差は丸めぶんのみ。 */
  readonly factorsProduct: number | undefined;
  /** この行が複数工場の合計で、かつ工場ごとに補正値が異なるか。 */
  readonly hasMixedFactorsAcrossFactories: boolean;
  /** 主な補正理由の説明文。 */
  readonly correctionNote: string;
}

/** 1工場ぶん、または会社合計ぶんの実効率テーブル。 */
export interface CapacityEffectiveRateTable {
  /** 会社合計の場合はnull。 */
  readonly factoryId: string | null;
  readonly rows: readonly CapacityEffectiveRateRow[];
}

// ---------------------------------------------------------------------
// 3. 処理見込みの行
// ---------------------------------------------------------------------

export const SHORTFALL_REASON_LABELS: Readonly<Record<ProductionShortfallReason, string>> = {
  rawMaterialShortage: "原料在庫",
  commonCapacityShortage: "共通処理能力",
  packagingCapacityShortage: "冷凍・包装能力",
  productCapacityShortage: "商品別設備能力",
  laborShortage: "有効労働能力",
};

/** 制約1件（主因か補足要因かを区別する）。 */
export interface ProcessingForecastConstraint {
  readonly reason: ProductionShortfallReason;
  readonly label: string;
  /** shortfallReasonsの先頭が主因、それ以降が補足要因（エンジンは段階順に理由を積む）。 */
  readonly role: "primary" | "contributing";
  /** この段階の上限値（完成品HOSO換算トン。段階1・2は歩留まり適用後の完成品換算値）。 */
  readonly limitTons: number;
  /** この段階で減った量（直前段階の値 − この段階の値）。 */
  readonly reducedTons: number;
  readonly sentence: string;
}

export interface ProcessingForecastRow {
  readonly factoryId: string;
  readonly product: Product;
  readonly productLabel: string;
  readonly priority: number;
  readonly desiredTons: number;
  /** 商品別名目能力（稼働開始済み設備投資を含む当期の名目値）。 */
  readonly productNominalCapacityTons: number;
  /** 商品別実効能力（名目 × 基準稼働率 × 設備利用可能率）。 */
  readonly productEffectiveCapacityTons: number;
  /** 共通能力配分後の処理見込み量（allocateProductionPlansのallocatedQuantity）。 */
  readonly forecastProcessedTons: number;
  /** 未処理見込み量（希望量 − 処理見込み量）。 */
  readonly forecastUnprocessedTons: number;
  /** 各制約段階の中間値（エンジンのstagesをそのまま写す）。 */
  readonly stages: {
    readonly rawMaterialLimitedTons: number;
    readonly commonCapacityLimitedTons: number;
    readonly freezingPackagingLimitedTons: number;
    readonly productCapacityLimitedTons: number;
    readonly laborLimitedTons: number;
  };
  /** 制約となった能力（主因が先頭）。制約なしなら空配列。 */
  readonly constraints: readonly ProcessingForecastConstraint[];
  readonly primaryConstraint: ProcessingForecastConstraint | undefined;
  /** 制約となった能力の要約（画面の1列に収める用。制約なしなら「制約なし」）。 */
  readonly constraintSummary: string;
  /** 共有プールを他商品と奪い合っており、かつ自分より優先度の高い商品がある場合の注記。 */
  readonly priorityNote: string | undefined;
  readonly requiredRawMaterialTons: number;
  readonly assignedRegularHeadcount: number;
  readonly assignedTemporaryHeadcount: number;
  readonly appliedOvertimeRate: number;
}

export interface CompanyProcessingForecast {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 常にtrue。確定結果ではないことを型の上でも明示する。 */
  readonly isForecast: true;
  readonly headingText: string;
  readonly rows: readonly ProcessingForecastRow[];
  /** 見込み計算に使った利用可能原料在庫（会社単位の共有プール）。 */
  readonly availableRawMaterialTons: number;
  /** 会社合計の実効率テーブル。 */
  readonly companyRateTable: CapacityEffectiveRateTable;
  /** 工場ごとの実効率テーブル。 */
  readonly factoryRateTables: readonly CapacityEffectiveRateTable[];
  /** 画面・Excelの両方に必ず併記する注意書き。 */
  readonly caveatTexts: readonly string[];
}

// ---------------------------------------------------------------------
// 4. 導出
// ---------------------------------------------------------------------

function poolNominalTons(factory: Factory, pool: CapacityPoolKey): number {
  switch (pool) {
    case "commonProcessing":
      return unwrapUnit(factory.commonProcessingCapacity);
    case "hoso":
      return unwrapUnit(factory.hosoCapacity);
    case "pd":
      return unwrapUnit(factory.pdCapacity);
    case "vap":
      return unwrapUnit(factory.vapCapacity);
    case "freezingPackaging":
      return unwrapUnit(factory.freezingPackagingCapacity);
  }
}

function poolEffectiveTons(factory: Factory, pool: CapacityPoolKey): number {
  const effective = calculateFactoryEffectiveCapacity(factory);
  switch (pool) {
    case "commonProcessing":
      return unwrapUnit(effective.commonProcessing);
    case "hoso":
      return unwrapUnit(effective.hoso);
    case "pd":
      return unwrapUnit(effective.pd);
    case "vap":
      return unwrapUnit(effective.vap);
    case "freezingPackaging":
      return unwrapUnit(effective.freezingPackaging);
  }
}

function factorsOf(factory: Factory): readonly CapacityRateFactor[] {
  return [
    {
      key: "baseUtilizationRate",
      label: CAPACITY_RATE_FACTOR_LABELS.baseUtilizationRate,
      value: unwrapUnit(factory.baseUtilizationRate),
    },
    {
      key: "equipmentAvailabilityRate",
      label: CAPACITY_RATE_FACTOR_LABELS.equipmentAvailabilityRate,
      value: unwrapUnit(factory.equipmentAvailabilityRate),
    },
  ];
}

function correctionNoteFor(factories: readonly Factory[], mixed: boolean): string {
  if (factories.length === 0) return "対象工場がありません。";
  if (factories.every((f) => f.status !== "active")) {
    return "工場が稼働状態（active）ではないため、実効能力は0です。";
  }
  if (mixed) {
    return "工場ごとに基準稼働率・設備利用可能率が異なるため、会社合計の実効率は工場別の加重平均になります。";
  }
  const f = factories[0];
  const base = unwrapUnit(f.baseUtilizationRate);
  const avail = unwrapUnit(f.equipmentAvailabilityRate);
  return `基準稼働率 ${(base * 100).toFixed(1)}% × 設備利用可能率 ${(avail * 100).toFixed(1)}% ＝ ${(base * avail * 100).toFixed(1)}%（この2つ以外の補正はエンジンに存在しません）`;
}

function buildRateTable(factoryId: string | null, factories: readonly Factory[]): CapacityEffectiveRateTable {
  const activeFactories = factories;
  const mixed =
    activeFactories.length > 1 &&
    activeFactories.some(
      (f) =>
        unwrapUnit(f.baseUtilizationRate) !== unwrapUnit(activeFactories[0].baseUtilizationRate) ||
        unwrapUnit(f.equipmentAvailabilityRate) !== unwrapUnit(activeFactories[0].equipmentAvailabilityRate)
    );
  const factors = activeFactories.length > 0 && !mixed ? factorsOf(activeFactories[0]) : [];
  const factorsProduct = factors.length > 0 ? factors.reduce((p, f) => p * f.value, 1) : undefined;
  const correctionNote = correctionNoteFor(activeFactories, mixed);

  const rows: CapacityEffectiveRateRow[] = CAPACITY_POOL_KEYS.map((poolKey) => {
    let nominalTons = 0;
    let effectiveTons = 0;
    for (const f of activeFactories) {
      nominalTons += poolNominalTons(f, poolKey);
      effectiveTons += poolEffectiveTons(f, poolKey);
    }
    return {
      poolKey,
      poolLabel: CAPACITY_POOL_LABELS[poolKey],
      poolDescription: CAPACITY_POOL_DESCRIPTIONS[poolKey],
      nominalTons,
      effectiveTons,
      effectiveRate: nominalTons > 0 ? effectiveTons / nominalTons : undefined,
      factors,
      factorsProduct,
      hasMixedFactorsAcrossFactories: mixed,
      correctionNote,
    };
  });

  return { factoryId, rows };
}

function sentenceFor(
  reason: ProductionShortfallReason,
  role: "primary" | "contributing",
  limitTons: number,
  reducedTons: number,
  priority: number
): string {
  const head = role === "primary" ? "主因" : "補足要因";
  switch (reason) {
    case "rawMaterialShortage":
      return `${head}: 原料在庫の配分が ${formatHosoEqTons(limitTons)} までのため、${formatHosoEqTons(reducedTons)} 不足`;
    case "commonCapacityShortage":
      return `${head}: 共通処理能力の配分が ${formatHosoEqTons(limitTons)} までのため、${formatHosoEqTons(reducedTons)} 不足（優先度${priority}のため、より優先度の高い商品の配分後の残りを使用します）`;
    case "packagingCapacityShortage":
      return `${head}: 冷凍・包装能力の配分が ${formatHosoEqTons(limitTons)} までのため、${formatHosoEqTons(reducedTons)} 不足`;
    case "productCapacityShortage":
      return `${head}: 商品別実効能力（${formatHosoEqTons(limitTons)}）により ${formatHosoEqTons(reducedTons)} 不足`;
    case "laborShortage":
      return `${head}: 有効労働能力（${formatHosoEqTons(limitTons)}）により ${formatHosoEqTons(reducedTons)} 不足`;
  }
}

const SHARED_POOL_REASONS: readonly ProductionShortfallReason[] = [
  "rawMaterialShortage",
  "commonCapacityShortage",
  "packagingCapacityShortage",
  "laborShortage",
];

export interface BuildCompanyProcessingForecastInput {
  /**
   * 【ENG-FAC-1 read-path consistency】Factory lifecycle決定ログ（capex/factoryLifecycle.ts）。
   * CompanyOwnState.factoryLifecycleState をそのまま渡すこと。省略時はlifecycleを一切
   * 適用しない＝この機能の導入前と完全に同一の表示（既存呼び出し元との後方互換）。
   * ここで status の独自判定は行わない（判定は computeEffectiveFactories の1箇所のみ）。
   */
  readonly factoryLifecycleState?: FactoryLifecycleStateTable;
  readonly companyId: CompanyId;
  /** ラボ作成時の静的な工場（capex加算前）。加算はこの関数の中で行う。 */
  readonly baseFactories: readonly Factory[];
  readonly capexState: CapexState;
  readonly period: PeriodV2;
  /** 現在の入力から作った生産計画（buildDecisionInputFromDraftの出力をそのまま渡す）。 */
  readonly productionPlans: readonly CompanyProductionPlanEntry[];
  readonly workerAssignments: readonly WorkerAssignment[];
  /** 見込み計算時点で会社が持っている原料ロット。 */
  readonly rawMaterialLots: readonly RawMaterialLot[];
  readonly params?: ProductionParameters;
}

/**
 * 現在の入力に基づく処理見込みを作る。計算そのものは
 * allocateProductionPlans（生産処理エンジンの純粋関数）が行い、この関数は
 * その戻り値を表示用へ書き写すだけである。
 */
export function buildCompanyProcessingForecast(input: BuildCompanyProcessingForecastInput): CompanyProcessingForecast {
  const params = input.params ?? PRODUCTION_PARAMETERS_V1;
  const companyBase = input.baseFactories.filter((f) => f.companyId === input.companyId);
  // 【Test15・develop/v2統合（Required fix 2）】唯一の計算箇所computeEffectiveFactories
  // を使う（applyCapexCapacityToFactoriesだけだと、稼働開始済みの新設Factory向けの
  // 生産計画・ワーカー配置が、下のfactoryById.has()フィルタで丸ごと除外されてしまい、
  // 「新設工場へ入力しても処理見込みに反映されない」という不整合が生じるため）。
  const currentFactories = computeEffectiveFactories(companyBase, input.capexState, input.period, input.factoryLifecycleState);
  const factoryById = new Map(currentFactories.map((f) => [f.factoryId, f]));

  const companyPlans = input.productionPlans.filter((p) => p.companyId === input.companyId && factoryById.has(p.factoryId));
  const companyWorkers = input.workerAssignments.filter((w) => w.companyId === input.companyId && factoryById.has(w.factoryId));
  const companyLots = input.rawMaterialLots.filter((l) => l.companyId === input.companyId);

  const availableRawMaterialTons = companyLots
    .filter((l) => l.status === "available")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);

  const allocation = allocateProductionPlans(companyPlans, currentFactories, companyWorkers, companyLots, input.period, params);

  const minPriorityByFactory = new Map<string, number>();
  for (const p of companyPlans) {
    const current = minPriorityByFactory.get(p.factoryId);
    if (current === undefined || p.priority < current) minPriorityByFactory.set(p.factoryId, p.priority);
  }

  const rows: ProcessingForecastRow[] = allocation.entries.map((entry) => {
    const factory = factoryById.get(entry.factoryId)!;
    const poolKey = entry.product as CapacityPoolKey;
    const desiredTons = unwrapUnit(entry.desiredQuantity);

    const stageList: { readonly reason: ProductionShortfallReason; readonly value: number }[] = [
      { reason: "rawMaterialShortage", value: unwrapUnit(entry.stages.rawMaterialLimited) },
      { reason: "commonCapacityShortage", value: unwrapUnit(entry.stages.commonCapacityLimited) },
      { reason: "packagingCapacityShortage", value: unwrapUnit(entry.stages.freezingPackagingLimited) },
      { reason: "productCapacityShortage", value: unwrapUnit(entry.stages.productCapacityLimited) },
      { reason: "laborShortage", value: unwrapUnit(entry.stages.laborLimited) },
    ];
    const valueByReason = new Map(stageList.map((s) => [s.reason, s.value]));
    const prevByReason = new Map<ProductionShortfallReason, number>();
    let prev = desiredTons;
    for (const s of stageList) {
      prevByReason.set(s.reason, prev);
      prev = s.value;
    }

    // 制約の並びと主因/補足要因の区別は、エンジンが返した shortfallReasons の
    // 順序をそのまま使う（この層で並べ替え・取捨選択をしない）。
    const constraints: ProcessingForecastConstraint[] = entry.shortfallReasons.map((reason, idx) => {
      const limitTons = valueByReason.get(reason) ?? 0;
      const reducedTons = Math.max(0, (prevByReason.get(reason) ?? desiredTons) - limitTons);
      const role: "primary" | "contributing" = idx === 0 ? "primary" : "contributing";
      return {
        reason,
        label: SHORTFALL_REASON_LABELS[reason],
        role,
        limitTons,
        reducedTons,
        sentence: sentenceFor(reason, role, limitTons, reducedTons, entry.priority),
      };
    });

    const minPriority = minPriorityByFactory.get(entry.factoryId);
    const competesForSharedPool = constraints.some((c) => SHARED_POOL_REASONS.includes(c.reason));
    const priorityNote =
      competesForSharedPool && minPriority !== undefined && entry.priority > minPriority
        ? `優先度${entry.priority}のため、優先度${minPriority}の商品が共有能力（原料・共通処理・冷凍包装・ワーカー）を先に使用します。優先度を上げるとこの商品の処理見込みは増え、他商品の処理見込みは減ります。`
        : undefined;

    return {
      factoryId: entry.factoryId,
      product: entry.product,
      // 見込み表の「商品」列は商品名そのもの（HOSO/PD/VAP）。
      // 能力プール名（「HOSO加工能力」等）は実効率テーブル側で使う別ラベル。
      productLabel: PRODUCT_LABELS[entry.product],
      priority: entry.priority,
      desiredTons,
      productNominalCapacityTons: poolNominalTons(factory, poolKey),
      productEffectiveCapacityTons: poolEffectiveTons(factory, poolKey),
      forecastProcessedTons: unwrapUnit(entry.allocatedQuantity),
      forecastUnprocessedTons: unwrapUnit(entry.shortfallQuantity),
      stages: {
        rawMaterialLimitedTons: unwrapUnit(entry.stages.rawMaterialLimited),
        commonCapacityLimitedTons: unwrapUnit(entry.stages.commonCapacityLimited),
        freezingPackagingLimitedTons: unwrapUnit(entry.stages.freezingPackagingLimited),
        productCapacityLimitedTons: unwrapUnit(entry.stages.productCapacityLimited),
        laborLimitedTons: unwrapUnit(entry.stages.laborLimited),
      },
      constraints,
      primaryConstraint: constraints[0],
      constraintSummary:
        constraints.length === 0
          ? "制約なし（希望量どおり処理見込み）"
          : constraints.length === 1
            ? `${constraints[0].label}`
            : `${constraints[0].label}（主因）＋ ${constraints.slice(1).map((c) => c.label).join("・")}`,
      priorityNote,
      requiredRawMaterialTons: unwrapUnit(entry.requiredRawMaterialQuantity),
      assignedRegularHeadcount: entry.labor.assignedRegularHeadcount,
      assignedTemporaryHeadcount: entry.labor.assignedTemporaryHeadcount,
      appliedOvertimeRate: unwrapUnit(entry.labor.appliedOvertimeRate),
    };
  });

  const caveatTexts: readonly string[] = [
    "この表は確定結果ではありません。現在の入力値をそのまま生産処理エンジンへ渡した場合の見込みです。",
    "生産希望量が0の行は生産計画として送信されないため、この表には出ません。",
    "原料在庫は「現時点の在庫」で計算しています。当期の国内買付・輸入到着ぶんは、四半期処理の中で買付・入庫が確定してから原料在庫へ加わるため、この見込みには含まれていません（実際の処理量は増える可能性があります）。",
    PRIORITY_RULE_TEXT,
    YIELD_APPLICATION_TEXT,
  ];

  return {
    companyId: input.companyId,
    period: input.period,
    isForecast: true,
    headingText: FORECAST_HEADING_TEXT,
    rows,
    availableRawMaterialTons,
    companyRateTable: buildRateTable(null, currentFactories),
    factoryRateTables: currentFactories.map((f) => buildRateTable(f.factoryId, [f])),
    caveatTexts,
  };
}
