// ShrimpX V2 — CompanyLab 初期成約（独立設計）
//
// 【会計上の重要性】
// 初期売掛金（前期以前の販売、既に売上計上済み、Q1に回収）と、
// 初期成約（当期以降のデリバリー、売上未計上）は、会計上「別の取引」として
// 厳密に分離する。
//
// 初期成約は、初期売掛金の金額から機械的に逆算してはならず、
// 各社の営業力・生産能力・市場構成から独立に設計する。
//
// 【Period設定】
//   - contractedPeriod: 2014Q4（前期に営業活動で獲得した成約）
//   - dueDate: 2015Q2以降（当期Q1には未出荷）←★重要：初期売掛金と別時期
//   - status: "open"（未履行、Q2以降に売上実現予定）

import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../core/units";
import { PeriodV2, previousPeriod, parsePeriod } from "../core/period";
import { SalesContract, CompanyId } from "../sales/types";

/**
 * 初期成約の定義。各社の営業力・生産能力から独立に設計。
 *
 * 【重要な制約】
 *   ❌ 初期売掛金から逆算しない
 *   ✓ 営業人員 × 営業効率 × 市場需要で導出
 *   ✓ 生産能力を超えない量に制限
 *   ✓ dueDate は Q2以降（初期売掛金の回収時期 Q1 と異なる）
 *
 * 【各社の営業力（fixtures.tsから）】
 *   - BAL:   営業18名、工場CAP 10k/8k/6k HOSO/PD/VAP
 *   - MASS:  営業22名、工場CAP 30k/6k/2k（HOSO特化）
 *   - JPQ:   営業14名、工場CAP 4k/11k/3k（PD特化）
 *   - VAP:   営業14名、工場CAP 3k/4k/12k（VAP特化）
 *   - CONSV: 営業10名、工場CAP 8k/6k/4k（保守的）
 */

interface InitialContractDef {
  companyId: CompanyId;
  market: "CN" | "US" | "EU" | "JP" | "OTHER";
  product: "hoso" | "pd" | "vap";
  quantity: number; // tons
  unitPrice: number; // USD/kg
  dueDateStr: string; // "2015Q2" 形式。パース後に PeriodV2 へ変換
}

/**
 * 【BAL—バランス型】
 * 営業18名 × 営業効率 → 年間予想売上 $35-40M
 * → Q1契約分（Q2-Q3デリバリー）: $12-15M
 * 工場CAP: 10k/8k/6k HOSO/PD/VAP、複数市場分散
 */
const BAL_INITIAL_CONTRACTS: InitialContractDef[] = [
  { companyId: "BAL", market: "CN", product: "hoso", quantity: 1200, unitPrice: 5.20, dueDateStr: "2015Q2" },
  { companyId: "BAL", market: "US", product: "hoso", quantity: 1000, unitPrice: 5.35, dueDateStr: "2015Q2" },
  { companyId: "BAL", market: "EU", product: "pd", quantity: 600, unitPrice: 6.85, dueDateStr: "2015Q3" },
  { companyId: "BAL", market: "JP", product: "vap", quantity: 300, unitPrice: 8.75, dueDateStr: "2015Q3" },
];

/**
 * 【MASS—大量生産・価格競争型】
 * 営業22名（最多）× 営業効率 → 年間予想売上 $45-55M
 * → Q1契約分（Q2-Q3デリバリー）: $16-20M
 * 工場CAP: 30k HOSO特化、CN/US重視
 */
const MASS_INITIAL_CONTRACTS: InitialContractDef[] = [
  { companyId: "MASS", market: "CN", product: "hoso", quantity: 1800, unitPrice: 5.10, dueDateStr: "2015Q2" },
  { companyId: "MASS", market: "US", product: "hoso", quantity: 1400, unitPrice: 5.25, dueDateStr: "2015Q2" },
  { companyId: "MASS", market: "EU", product: "hoso", quantity: 400, unitPrice: 5.15, dueDateStr: "2015Q3" },
];

/**
 * 【JPQ—日本・品質志向型】
 * 営業14名 × 営業効率 → 年間予想売上 $22-28M
 * → Q1契約分（Q2-Q3デリバリー）: $8-12M
 * 工場CAP: 11k PD特化、JP/EU重視
 */
const JPQ_INITIAL_CONTRACTS: InitialContractDef[] = [
  { companyId: "JPQ", market: "JP", product: "pd", quantity: 900, unitPrice: 7.15, dueDateStr: "2015Q2" },
  { companyId: "JPQ", market: "EU", product: "pd", quantity: 700, unitPrice: 6.95, dueDateStr: "2015Q3" },
  { companyId: "JPQ", market: "US", product: "pd", quantity: 300, unitPrice: 6.70, dueDateStr: "2015Q3" },
];

/**
 * 【VAP—VAP 特化型】
 * 営業14名 × 営業効率 → 年間予想売上 $28-35M
 * → Q1契約分（Q2-Q3デリバリー）: $10-14M
 * 工場CAP: 12k VAP特化、高付加価値市場
 */
const VAP_INITIAL_CONTRACTS: InitialContractDef[] = [
  { companyId: "VAP", market: "JP", product: "vap", quantity: 550, unitPrice: 9.10, dueDateStr: "2015Q2" },
  { companyId: "VAP", market: "EU", product: "vap", quantity: 650, unitPrice: 8.85, dueDateStr: "2015Q2" },
  { companyId: "VAP", market: "US", product: "pd", quantity: 450, unitPrice: 6.80, dueDateStr: "2015Q3" },
];

/**
 * 【CONSV—保守的・財務慎重型】
 * 営業10名（最少）× 営業効率 → 年間予想売上 $15-20M
 * → Q1契約分（Q2-Q3デリバリー）: $5-8M
 * 工場CAP: 8k/6k/4k、過度契約回避
 */
const CONSV_INITIAL_CONTRACTS: InitialContractDef[] = [
  { companyId: "CONSV", market: "CN", product: "hoso", quantity: 600, unitPrice: 5.15, dueDateStr: "2015Q2" },
  { companyId: "CONSV", market: "JP", product: "pd", quantity: 300, unitPrice: 7.00, dueDateStr: "2015Q3" },
  { companyId: "CONSV", market: "OTHER", product: "hoso", quantity: 500, unitPrice: 5.25, dueDateStr: "2015Q3" },
];

const ALL_INITIAL_CONTRACT_DEFS = [
  ...BAL_INITIAL_CONTRACTS,
  ...MASS_INITIAL_CONTRACTS,
  ...JPQ_INITIAL_CONTRACTS,
  ...VAP_INITIAL_CONTRACTS,
  ...CONSV_INITIAL_CONTRACTS,
];

/**
 * 初期成約リストを生成する。
 *
 * @param currentPeriod 現在の開始四半期（e.g., "2015Q1"）
 * @returns 初期 SalesContract[]
 */
export function generateInitialContracts(currentPeriod: PeriodV2): SalesContract[] {
  // 成約は前々期に行われたと設定（contractedPeriod）
  const contractedPeriod = previousPeriod(currentPeriod); // 前期に成約

  const contracts: SalesContract[] = [];

  for (const def of ALL_INITIAL_CONTRACT_DEFS) {
    const dueDate = parsePeriod(def.dueDateStr); // dueDateStrをPeriodV2へ変換
    const contractId = `SC-${contractedPeriod}-${def.market}-${def.product}-${def.companyId}`;
    const quantity = hosoEqTons(def.quantity);
    const price = usdPerHosoEqKg(def.unitPrice);

    contracts.push({
      contractId,
      companyId: def.companyId,
      market: def.market,
      product: def.product,
      contractedPeriod,
      dueDate,
      originalQuantity: quantity,
      outstandingQuantity: quantity,
      unitPrice: price,
      status: "open",
      // costSnapshot は未設定（初期契約のため）
    });
  }

  return contracts;
}

/**
 * 初期成約の総売上を計算し、初期売掛金との整合性を確認する。
 * （診断・検証用）
 */
export function verifyInitialContractsTotals(contracts: SalesContract[]): Record<CompanyId, number> {
  const byCompany: Record<string, number> = {};

  for (const c of contracts) {
    // 換算: HOSO等量トン × $/kg × 1000
    const amount = unwrapUnit(c.originalQuantity) * unwrapUnit(c.unitPrice) * 1000;
    byCompany[c.companyId] = (byCompany[c.companyId] ?? 0) + amount;
  }

  return byCompany;
}
