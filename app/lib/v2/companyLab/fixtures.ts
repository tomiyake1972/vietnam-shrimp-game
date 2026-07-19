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
import { CompanyFixture } from "./types";

const PRODUCTS = ["hoso", "pd", "vap"] as const;

function factory(overrides: Partial<Factory> & Pick<Factory, "factoryId" | "companyId">): Factory {
  return {
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
}

function workerBaseline(
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

function initialLot(
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
      salesForceHeadcountTotal: 18,
      procurementHeadcountTotal: 12,
      initialRawMaterialLots: [initialLot(`${BAL}-RM-INIT`, BAL, "VN", 3000, 4.2, p0)],
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
      salesForceHeadcountTotal: 22,
      procurementHeadcountTotal: 20,
      initialRawMaterialLots: [initialLot(`${MASS}-RM-INIT`, MASS, "VN", 5000, 4.0, p0)],
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
      salesForceHeadcountTotal: 14,
      procurementHeadcountTotal: 10,
      initialRawMaterialLots: [initialLot(`${JPQ}-RM-INIT`, JPQ, "VN", 2500, 4.3, p0)],
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
      salesForceHeadcountTotal: 14,
      procurementHeadcountTotal: 10,
      initialRawMaterialLots: [initialLot(`${VAP}-RM-INIT`, VAP, "VN", 2500, 4.3, p0)],
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
      salesForceHeadcountTotal: 10,
      procurementHeadcountTotal: 8,
      initialRawMaterialLots: [initialLot(`${CONSV}-RM-INIT`, CONSV, "VN", 3000, 4.1, p0)],
    },
  ];
}

export const COMPANY_LAB_COMPANY_IDS: readonly CompanyId[] = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];
