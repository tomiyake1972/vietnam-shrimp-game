// ShrimpX V2 — Phase SAI-5B: 異質5社preset（会社別の小幅で説明可能な初期差）
//
// 【方針（実装指示§5）】identical-standard preset（5社完全同一）は同一条件比較・
// 回帰試験・AI校正の基準として必ず残し、本presetは別フラグ
// （heterogeneousInitialConditionsEnabled）でのみ有効化する。
//
// 【初期差の対象と限定理由】
//  1. 商品別設備能力ミックス（±20%以内の傾斜。総能力はほぼ同一）
//     … 会社像（MASS=HOSO量産、JPQ/VAP社=加工品寄り、CONSV=PD寄り）を
//        「過去に選んできた設備投資の違い」として表現する。
//  2. 固定資産（fixedAssetsGross）を商品ライン能力の合計比で微調整
//     … 「設備能力を変えた場合は固定資産との整合を保つ」（指示§5）。
//        利益剰余金は残差（総資産−総負債−資本金）で決まるためBSは
//        構造的にバランスする。
//  3. ワーカー技能の商品別傾斜（±5%）… 設備と同じ方向の習熟差。
//  4. 初期営業基盤（会社×市場×商品、salesBase.ts）… 「過去に築いてきた
//     営業基盤が違う」の直接表現。BS非接続のため会計整合を壊さない最も
//     安全な初期差。
//
// 【変えないもの（会計整合・説明可能性を壊さないため。指示§5「無理に変えない」）】
//  初期契約・初期在庫・現金・借入・AR/AP・品質/信頼初期値・営業/調達人員総数・
//  養殖能力。これらは完了報告の「次工程候補（SAI-5B拡張）」として記録する。
//
// 【勝敗を作らない】いずれの差も「利益への直接ボーナス」ではなく、能力構成・
// 習熟・営業基盤という中間資源の傾斜であり、その価値は市場環境（ライフサイクル・
// プレミアム・競合行動）に依存して変わる。

import { hosoEqTons, ratio, score0to100, unwrapUnit } from "../../../core/units";
import { DemandMarketId, Product } from "../../../market/types";
import { CompanyId } from "../../../sales/types";
import { CompanyFixture } from "../../types";
import { SalesBaseEntry, SalesBaseState } from "../../salesBase";
import { UnifiedPerCompanyOverrides } from "./decomposeHarness";

/** 商品別設備能力の傾斜倍率（1.0=テンプレートのまま）。 */
export const SAI5_CAPACITY_TILTS_BY_COMPANY: Readonly<Record<CompanyId, Readonly<Record<Product, number>>>> = {
  BAL: { hoso: 1.0, pd: 1.0, vap: 1.0 },
  MASS: { hoso: 1.15, pd: 0.9, vap: 0.8 },
  JPQ: { hoso: 0.85, pd: 1.05, vap: 1.2 },
  VAP: { hoso: 0.85, pd: 1.15, vap: 1.15 },
  CONSV: { hoso: 0.95, pd: 1.15, vap: 0.9 },
};

/** ワーカー技能の商品別傾斜倍率（±5%。技能は0〜1のratioのため0.98でクランプ）。 */
export const SAI5_SKILL_TILTS_BY_COMPANY: Readonly<Record<CompanyId, Readonly<Record<Product, number>>>> = {
  BAL: { hoso: 1.0, pd: 1.0, vap: 1.0 },
  MASS: { hoso: 1.05, pd: 0.98, vap: 0.95 },
  JPQ: { hoso: 0.97, pd: 1.02, vap: 1.05 },
  VAP: { hoso: 0.96, pd: 1.05, vap: 1.04 },
  CONSV: { hoso: 1.0, pd: 1.05, vap: 0.97 },
};

/** 初期営業基盤（中立50からの小幅な差。会社像と整合する市場×商品のみ）。 */
export const SAI5_INITIAL_SALES_BASE_ENTRIES: readonly { companyId: CompanyId; market: DemandMarketId; product: Product; score: number }[] = [
  // JPQ: 日本のPD/VAPで先行（日本・品質重視型の過去の蓄積）
  { companyId: "JPQ", market: "JP", product: "vap", score: 65 },
  { companyId: "JPQ", market: "JP", product: "pd", score: 60 },
  // MASS: 中国・その他のHOSO量販の販路
  { companyId: "MASS", market: "CN", product: "hoso", score: 65 },
  { companyId: "MASS", market: "OTHER", product: "hoso", score: 55 },
  // VAP社: 米国のPD/VAP
  { companyId: "VAP", market: "US", product: "pd", score: 62 },
  { companyId: "VAP", market: "US", product: "vap", score: 60 },
  // CONSV: 欧州のPD/HOSO
  { companyId: "CONSV", market: "EU", product: "pd", score: 62 },
  { companyId: "CONSV", market: "EU", product: "hoso", score: 55 },
  // BAL: 初期差なし（バランス型の基準会社）
];

function clampSkill(v: number): number {
  return Math.max(0, Math.min(0.98, v));
}

/** 会社別のfixture上書き（設備能力ミックス・技能傾斜）。 */
function applyFixtureTilts(companyId: CompanyId, fixture: CompanyFixture): CompanyFixture {
  const capacityTilt = SAI5_CAPACITY_TILTS_BY_COMPANY[companyId] ?? SAI5_CAPACITY_TILTS_BY_COMPANY.BAL;
  const skillTilt = SAI5_SKILL_TILTS_BY_COMPANY[companyId] ?? SAI5_SKILL_TILTS_BY_COMPANY.BAL;
  return {
    ...fixture,
    factories: fixture.factories.map((f) => ({
      ...f,
      hosoCapacity: hosoEqTons(Math.round(unwrapUnit(f.hosoCapacity) * capacityTilt.hoso)),
      pdCapacity: hosoEqTons(Math.round(unwrapUnit(f.pdCapacity) * capacityTilt.pd)),
      vapCapacity: hosoEqTons(Math.round(unwrapUnit(f.vapCapacity) * capacityTilt.vap)),
      // 共通前処理・凍結包装・保管・スペースは共有工程のため変えない
      // （商品ライン構成の違いだけを表現する）。
    })),
    workerBaseline: fixture.workerBaseline.map((w) => ({
      ...w,
      skills: w.skills.map((s) => ({
        product: s.product,
        skillLevel: ratio(clampSkill(unwrapUnit(s.skillLevel) * (skillTilt[s.product] ?? 1))),
      })),
    })),
  };
}

/** 商品ライン能力合計の変化率（固定資産の比例調整に使う）。 */
function productLineCapacityRatio(before: CompanyFixture, after: CompanyFixture): number {
  const sum = (fx: CompanyFixture) =>
    fx.factories.reduce((s, f) => s + unwrapUnit(f.hosoCapacity) + unwrapUnit(f.pdCapacity) + unwrapUnit(f.vapCapacity), 0);
  const b = sum(before);
  return b > 0 ? sum(after) / b : 1;
}

/**
 * SAI-5B異質presetのoverride一式を構築する。
 * initializeUnifiedCompanyLabFromTemplateのperCompanyOverridesへそのまま渡す。
 */
export function buildSai5HeterogeneousOverrides(): UnifiedPerCompanyOverrides {
  const initialSalesBaseState: SalesBaseState = {
    entries: SAI5_INITIAL_SALES_BASE_ENTRIES.map(
      (e): SalesBaseEntry => ({ companyId: e.companyId, market: e.market, product: e.product, score: score0to100(e.score) })
    ),
  };
  return {
    fixtureOverride: applyFixtureTilts,
    financeFixtureOverride: (companyId, template, fixture) => {
      // fixtureOverride適用後の商品ライン能力合計に比例してfixedAssetsGrossを調整
      // （設備が多い会社は固定資産も多い、という説明可能な整合）。テンプレートの
      // 傾斜前fixtureは受け取れないため、傾斜倍率から比率を再構成する。
      const tilt = SAI5_CAPACITY_TILTS_BY_COMPANY[companyId] ?? SAI5_CAPACITY_TILTS_BY_COMPANY.BAL;
      const untilted: CompanyFixture = {
        ...fixture,
        factories: fixture.factories.map((f) => ({
          ...f,
          hosoCapacity: hosoEqTons(unwrapUnit(f.hosoCapacity) / tilt.hoso),
          pdCapacity: hosoEqTons(unwrapUnit(f.pdCapacity) / tilt.pd),
          vapCapacity: hosoEqTons(unwrapUnit(f.vapCapacity) / tilt.vap),
        })),
      };
      const capacityRatio = productLineCapacityRatio(untilted, fixture);
      return { ...template, companyId, fixedAssetsGross: Math.round(template.fixedAssetsGross * capacityRatio) };
    },
    initialSalesBaseState,
  };
}
