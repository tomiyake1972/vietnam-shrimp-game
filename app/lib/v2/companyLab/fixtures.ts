// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 会社フィクスチャ
//
// 【重要】ここで定義する5社は、ゲームの本番会社設定ではなく、統合テスト・GM
// 確認用のフィクスチャである。工場能力・ワーカー人数・養殖能力・初期原料在庫は
// いずれも「Phase1〜6を通しで動かして検証する」目的のために選んだ暫定値であり、
// ゲームバランス調整の対象ではない。財務三表は未実装のため、保守的・財務慎重型の
// 会社は「過剰契約・過剰在庫を避ける行動」（自動方針側の抑制ロジック）でのみ
// その方針を表現する（fixture自体に財務指標は一切持たせない）。

import { PeriodV2 } from "../core/period";
import { hosoEqTons, ratio, usdPerHosoEqKg } from "../core/units";
import { CountryId } from "../market/types";
import { CompanyId } from "../sales/types";
import { RawMaterialLot } from "../rawMaterials/types";
import { Factory, WorkerAssignment } from "../production/types";
import { resolveFactoryColdStorageCapacity } from "../production/coldStorage";
import { deriveDefaultFactorySpaceUnits } from "../production/factorySpace";
import { CompanyFixture, CompanyPremiumEconomics, CompanyProductEconomics } from "./types";

const PRODUCTS = ["hoso", "pd", "vap"] as const;

/**
 * 【Phase 8D】coldStorageCapacity（冷凍・冷蔵保管能力＝ストック）と
 * totalFactorySpaceUnits（工場スペース総量）を、フィクスチャの時点で明示的に
 * 埋める。値そのものは production/coldStorage.ts・production/factorySpace.ts の
 * 導出関数をそのまま呼んで得るため、これらのフィールドを持たない既存ラボ
 * （Phase 8D以前に作成されたもの）と完全に同じ値になる。
 *
 * 明示的に埋める理由は、新しく作るラボでは「保管能力・スペース総量がいくつか」が
 * 保存データ自体から読み取れるようにするため（将来GMが会社ごとに変えられる
 * 余地も残す）。導出式は1箇所にしかないので、二重管理にはならない。
 */
/** 【SAI-2】standardBaseline.tsが本番fixtureと同じ導出ロジック（冷凍・冷蔵保管能力、
 * 工場スペース総量の自動導出）を再利用できるよう、以下のヘルパー関数をexportする。
 * 既存5社のfixture構築ロジック・数値は一切変更していない（exportのみの変更）。 */
export function factory(overrides: Partial<Factory> & Pick<Factory, "factoryId" | "companyId">): Factory {
  const withoutDerived: Factory = {
    status: "active",
    commonProcessingCapacity: hosoEqTons(0),
    hosoCapacity: hosoEqTons(0),
    pdCapacity: hosoEqTons(0),
    vapCapacity: hosoEqTons(0),
    freezingPackagingCapacity: hosoEqTons(0),
    baseUtilizationRate: ratio(0.9),
    equipmentAvailabilityRate: ratio(0.95),
    ...overrides,
  };
  const withColdStorage: Factory = {
    ...withoutDerived,
    coldStorageCapacity: withoutDerived.coldStorageCapacity ?? resolveFactoryColdStorageCapacity(withoutDerived),
  };
  return {
    ...withColdStorage,
    totalFactorySpaceUnits: withColdStorage.totalFactorySpaceUnits ?? deriveDefaultFactorySpaceUnits(withColdStorage),
  };
}

export function workerBaseline(
  factoryId: string,
  companyId: CompanyId,
  regularHeadcount: number,
  skillLevels: Readonly<Partial<Record<(typeof PRODUCTS)[number], number>>>,
  attendanceRate = 0.95
): Pick<WorkerAssignment, "factoryId" | "companyId" | "regularHeadcount" | "skills" | "attendanceRate"> {
  return {
    factoryId,
    companyId,
    regularHeadcount,
    attendanceRate: ratio(attendanceRate),
    skills: PRODUCTS.map((product) => ({ product, skillLevel: ratio(skillLevels[product] ?? 0) })),
  };
}

/**
 * 【Phase 6.3（実装指示 §9）】会社別の商品経済性ヘルパー。
 * すべてUSD/HOSO換算kgの暫定値（要校正）。Phase 8の実原価計算実装時に
 * 交換可能なテスト用フィクスチャ。VAPの最低受注水準は原則PDより高い。
 */
export function premiumEconomics(
  variable: number,
  fixed: number,
  selling: number,
  targetMargin: number,
  incrementalSelling: number,
  minimumContribution: number
): CompanyPremiumEconomics {
  return {
    expectedVariableProcessingCostUsdPerHosoEqKg: variable,
    allocatedFixedCostUsdPerHosoEqKg: fixed,
    sellingAndLogisticsCostUsdPerHosoEqKg: selling,
    targetMarginUsdPerHosoEqKg: targetMargin,
    // 回避可能変動費は、暫定的に変動加工費と同額とする（Phase 8で分離予定）。
    avoidableVariableProcessingCostUsdPerHosoEqKg: variable,
    incrementalSellingAndLogisticsCostUsdPerHosoEqKg: incrementalSelling,
    minimumContributionMarginUsdPerHosoEqKg: minimumContribution,
  };
}

export function productEconomics(
  processingCost: Readonly<Record<"hoso" | "pd" | "vap", number>>,
  pd: CompanyPremiumEconomics,
  vap: CompanyPremiumEconomics
): CompanyProductEconomics {
  return {
    expectedProcessingCostUsdPerHosoEqKg: processingCost,
    premiumEconomics: { pd, vap },
  };
}

export function initialLot(
  lotId: string,
  companyId: CompanyId,
  originCountry: CountryId,
  quantity: number,
  unitCost: number,
  inboundPeriod: PeriodV2
): RawMaterialLot {
  return {
    lotId,
    companyId,
    source: "domestic",
    originCountry,
    inboundPeriod,
    originalQuantity: hosoEqTons(quantity),
    remainingQuantity: hosoEqTons(quantity),
    unitCost: usdPerHosoEqKg(unitCost),
    availableFromPeriod: inboundPeriod,
    status: "available",
  };
}

/**
 * 5社のテスト用フィクスチャを構築する（統合テスト専用。本番会社設定ではない）。
 * startPeriodは初期原料在庫ロットのinboundPeriod/availableFromPeriodに使う。
 */
export function buildCompanyFixtures(startPeriod: PeriodV2): readonly CompanyFixture[] {
  const p0 = startPeriod;

  const BAL: CompanyId = "BAL";
  const MASS: CompanyId = "MASS";
  const JPQ: CompanyId = "JPQ";
  const VAP: CompanyId = "VAP";
  const CONSV: CompanyId = "CONSV";

  return [
    {
      companyId: BAL,
      displayName: "バランス型水産",
      archetype: "balanced",
      description:
        "統合テスト用フィクスチャ（本番会社設定ではない）。HOSO・PD・VAPをバランスよく生産し、複数市場へ分散して販売する標準的な会社という設定。",
      country: "VN",
      factories: [
        factory({
          factoryId: `${BAL}-F1`,
          companyId: BAL,
          commonProcessingCapacity: hosoEqTons(22000),
          hosoCapacity: hosoEqTons(10000),
          pdCapacity: hosoEqTons(8000),
          vapCapacity: hosoEqTons(6000),
          freezingPackagingCapacity: hosoEqTons(20000),
        }),
      ],
      workerBaseline: [workerBaseline(`${BAL}-F1`, BAL, 6000, { hoso: 0.85, pd: 0.8, vap: 0.75 })],
      aquacultureCapacity: hosoEqTons(15000),
      salesForceHeadcountTotal: 60,
      procurementHeadcountTotal: 12,
      initialRawMaterialLots: [initialLot(`${BAL}-RM-INIT`, BAL, "VN", 3000, 4.2, p0)],
      // Phase 6.3: バランス型の標準的なコスト水準（暫定値・要校正）。
      // PD: 目標プレミアム 0.52 / 最低受注 0.25、VAP: 目標 1.18 / 最低 0.59。
      productEconomics: productEconomics(
        { hoso: 0.5, pd: 0.75, vap: 1.2 },
        premiumEconomics(0.17, 0.15, 0.05, 0.15, 0.03, 0.05),
        premiumEconomics(0.43, 0.35, 0.1, 0.3, 0.06, 0.1)
      ),
    },
    {
      companyId: MASS,
      displayName: "大量生産・価格競争水産",
      archetype: "massMarket",
      description:
        "統合テスト用フィクスチャ（本番会社設定ではない）。HOSOを中心に大量生産し、値引き提示で市場シェアを取りにいく価格競争型という設定。",
      country: "VN",
      factories: [
        factory({
          factoryId: `${MASS}-F1`,
          companyId: MASS,
          commonProcessingCapacity: hosoEqTons(36000),
          hosoCapacity: hosoEqTons(30000),
          pdCapacity: hosoEqTons(6000),
          vapCapacity: hosoEqTons(2000),
          freezingPackagingCapacity: hosoEqTons(34000),
        }),
      ],
      workerBaseline: [workerBaseline(`${MASS}-F1`, MASS, 9000, { hoso: 0.9, pd: 0.6, vap: 0.5 })],
      aquacultureCapacity: hosoEqTons(18000),
      salesForceHeadcountTotal: 60,
      procurementHeadcountTotal: 20,
      initialRawMaterialLots: [initialLot(`${MASS}-RM-INIT`, MASS, "VN", 5000, 4.0, p0)],
      // Phase 6.3: HOSO大量生産は効率的だが、PD・VAPは技能が低くコスト高
      // （高コスト会社としてVAPから先に退出する想定）。
      // PD: 目標 0.57 / 最低 0.30、VAP: 目標 1.58 / 最低 0.94。
      productEconomics: productEconomics(
        { hoso: 0.45, pd: 0.85, vap: 1.6 },
        premiumEconomics(0.22, 0.18, 0.05, 0.12, 0.03, 0.05),
        premiumEconomics(0.78, 0.45, 0.1, 0.25, 0.06, 0.1)
      ),
    },
    {
      companyId: JPQ,
      displayName: "日本・品質志向水産",
      archetype: "japanQuality",
      description:
        "統合テスト用フィクスチャ（本番会社設定ではない）。PDを中心に高品質・高価格帯で日本市場向けを重視する品質志向型という設定。",
      country: "VN",
      factories: [
        factory({
          factoryId: `${JPQ}-F1`,
          companyId: JPQ,
          commonProcessingCapacity: hosoEqTons(16000),
          hosoCapacity: hosoEqTons(4000),
          pdCapacity: hosoEqTons(11000),
          vapCapacity: hosoEqTons(3000),
          freezingPackagingCapacity: hosoEqTons(15000),
        }),
      ],
      workerBaseline: [workerBaseline(`${JPQ}-F1`, JPQ, 5500, { hoso: 0.6, pd: 0.95, vap: 0.7 })],
      aquacultureCapacity: hosoEqTons(9000),
      salesForceHeadcountTotal: 60,
      procurementHeadcountTotal: 10,
      initialRawMaterialLots: [initialLot(`${JPQ}-RM-INIT`, JPQ, "VN", 2500, 4.3, p0)],
      // Phase 6.3: PD加工が効率的（PD最低受注水準が5社中最低）。
      // PD: 目標 0.51 / 最低 0.23、VAP: 目標 1.28 / 最低 0.66。
      productEconomics: productEconomics(
        { hoso: 0.6, pd: 0.68, vap: 1.25 },
        premiumEconomics(0.14, 0.13, 0.06, 0.18, 0.03, 0.06),
        premiumEconomics(0.48, 0.36, 0.11, 0.33, 0.06, 0.12)
      ),
    },
    {
      companyId: VAP,
      displayName: "VAP特化水産",
      archetype: "vapSpecialist",
      description:
        "統合テスト用フィクスチャ（本番会社設定ではない）。付加価値加工品（VAP）に設備・ワーカーを集中投資する特化型という設定。",
      country: "VN",
      factories: [
        factory({
          factoryId: `${VAP}-F1`,
          companyId: VAP,
          commonProcessingCapacity: hosoEqTons(18000),
          hosoCapacity: hosoEqTons(3000),
          pdCapacity: hosoEqTons(4000),
          vapCapacity: hosoEqTons(12000),
          freezingPackagingCapacity: hosoEqTons(17000),
        }),
      ],
      workerBaseline: [workerBaseline(`${VAP}-F1`, VAP, 6500, { hoso: 0.5, pd: 0.65, vap: 0.95 })],
      aquacultureCapacity: hosoEqTons(10000),
      salesForceHeadcountTotal: 60,
      procurementHeadcountTotal: 10,
      initialRawMaterialLots: [initialLot(`${VAP}-RM-INIT`, VAP, "VN", 2500, 4.3, p0)],
      // Phase 6.3: VAP加工が効率的（VAP最低受注水準が5社中最低）。
      // PD: 目標 0.53 / 最低 0.26、VAP: 目標 0.99 / 最低 0.47。
      productEconomics: productEconomics(
        { hoso: 0.62, pd: 0.78, vap: 1.0 },
        premiumEconomics(0.18, 0.15, 0.05, 0.15, 0.03, 0.05),
        premiumEconomics(0.34, 0.28, 0.09, 0.28, 0.05, 0.08)
      ),
    },
    {
      companyId: CONSV,
      displayName: "保守的・財務慎重水産",
      archetype: "conservative",
      description:
        "統合テスト用フィクスチャ（本番会社設定ではない）。財務三表は未実装のため、過剰契約・過剰在庫を避ける保守的な意思決定（自動方針側の抑制ロジック）でこの方針を表現する設定。",
      country: "VN",
      factories: [
        factory({
          factoryId: `${CONSV}-F1`,
          companyId: CONSV,
          commonProcessingCapacity: hosoEqTons(15000),
          hosoCapacity: hosoEqTons(8000),
          pdCapacity: hosoEqTons(6000),
          vapCapacity: hosoEqTons(4000),
          freezingPackagingCapacity: hosoEqTons(14000),
        }),
      ],
      workerBaseline: [workerBaseline(`${CONSV}-F1`, CONSV, 4500, { hoso: 0.8, pd: 0.75, vap: 0.7 }, 0.97)],
      aquacultureCapacity: hosoEqTons(10000),
      salesForceHeadcountTotal: 60,
      procurementHeadcountTotal: 8,
      initialRawMaterialLots: [initialLot(`${CONSV}-RM-INIT`, CONSV, "VN", 3000, 4.1, p0)],
      // Phase 6.3: 保守的会社は最低貢献利益の要求が高め（薄利受注を避ける）。
      // PD: 目標 0.56 / 最低 0.28、VAP: 目標 1.33 / 最低 0.70。
      productEconomics: productEconomics(
        { hoso: 0.52, pd: 0.8, vap: 1.3 },
        premiumEconomics(0.18, 0.16, 0.05, 0.17, 0.03, 0.07),
        premiumEconomics(0.5, 0.38, 0.1, 0.35, 0.06, 0.14)
      ),
    },
  ];
}

export const COMPANY_LAB_COMPANY_IDS: readonly CompanyId[] = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];
