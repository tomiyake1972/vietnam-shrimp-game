// ShrimpX V2 — Phase SAI-2: 標準初期条件（standard baseline）の候補定義
//
// 【本ファイルの位置づけ】既存5社（BAL/MASS/JPQ/VAP/CONSV）はいずれもSAI-1.5で
// 確認したとおり、経営結果を大きく左右するほど条件差が大きい（アーキタイプごとに
// 意図的に作り込まれたテスト用フィクスチャであり、本番会社設定ではない §fixtures.ts
// 冒頭コメント参照）。SAI-2では、既存5社のどれかをそのまま標準とするのではなく、
// 経営実験の出発点として使える「中立的で一貫した共通初期条件」を独立に設計する。
//
// 既存5社の会社特性（fixtures.ts）・standard AIの判断ロジック・ゲームルールは
// 一切変更しない。本ファイルは、既存の初期化部品（fixtures.tsのfactory/
// workerBaseline/premiumEconomics/productEconomics/initialLotヘルパー、
// finance/initialState.tsのInitialFinanceFixture型）をそのまま再利用して、
// 既存5社とは独立な「標準会社」を組み立てるだけの追加モジュールである。
//
// 候補の設計方針・選定結果は docs/v2/reports/sai2_standard_baseline_report.md を正とする。

import { PeriodV2 } from "../../../core/period";
import { hosoEqTons } from "../../../core/units";
import { CompanyId } from "../../../sales/types";
import { InitialFinanceFixture } from "../../../finance/initialState";
import { CompanyFixture } from "../../types";
import { factory, workerBaseline, premiumEconomics, productEconomics, initialLot } from "../../fixtures";
import { UnifiedContractDef } from "./decomposeHarness";

/** 標準初期条件の候補が独立に使う仮のcompanyId（5社へ複製する際に上書きされるため、
 *  実際のゲーム内会社IDとは無関係。displayName等の表示にのみ使う）。 */
const STANDARD_TEMPLATE_ID: CompanyId = "BAL"; // 型を満たすためのプレースホルダ（複製時に必ず上書きされる）

export interface StandardBaselineCandidate {
  readonly id: string;
  readonly label: string;
  /** なぜこの数値を標準候補とするのかの、項目別の設計理由（レポートにそのまま転記する）。 */
  readonly rationale: string;
  readonly buildFixtureTemplate: (startPeriod: PeriodV2) => CompanyFixture;
  readonly financeFixtureTemplate: Omit<InitialFinanceFixture, "companyId">;
  readonly contractDefs: readonly UnifiedContractDef[];
}

// ---------------------------------------------------------------------
// 候補1: balanced-trimmed（BALを基礎に、過度な安全余力を調整した案）
// ---------------------------------------------------------------------
//
// 設計理由: 既存5社のうちBAL（バランス型）は、HOSO/PD/VAPの処理能力配分に極端な
// 偏りがなく（10,000/8,000/6,000）、ワーカー技能も3商品にわたって比較的均等
// （0.85/0.80/0.75）であり、単独の会社として最も内部整合性が高い。SAI-1.5でも
// Test A・Test Bのどちらでも唯一32Qを通して支払不能に陥らなかった。
// ただし、その「安全さ」の一部は財務側の余裕（初期現金3,000万USDが
// 会社規模推定に基づく最低現金バッファ目安3,103万USDとほぼ同水準）ではなく、
// 処理能力配分・商品経済性の設計そのものに起因することが、CONSV（初期現金は
// BALより多い3,500万USDだが最も早く支払不能に陥る）との比較から示唆される。
// そこで本候補は、BALの操業条件（工場能力・ワーカー・養殖能力・商品経済性）は
// そのまま踏襲しつつ、財務側の初期現金をやや切り詰め（3,000万→2,000万USD）、
// 短期借入をやや引き上げる（2,000万→2,500万USD）ことで、「同じ操業設計のまま、
// 財務的な緩みだけを減らした」場合に、standard AIの資金繰り判断が実際に必要と
// なるかを確認する。
function buildCandidate1Fixture(startPeriod: PeriodV2): CompanyFixture {
  const id = STANDARD_TEMPLATE_ID;
  return {
    companyId: id,
    displayName: "[SAI-2候補1] balanced-trimmed",
    archetype: "balanced",
    description: "SAI-2標準初期条件の候補1（BALの操業条件を踏襲し、財務の安全余力のみ調整）。本番会社設定ではない。",
    country: "VN",
    factories: [
      factory({
        factoryId: `${id}-STD-F1`,
        companyId: id,
        commonProcessingCapacity: hosoEqTons(22000),
        hosoCapacity: hosoEqTons(10000),
        pdCapacity: hosoEqTons(8000),
        vapCapacity: hosoEqTons(6000),
        freezingPackagingCapacity: hosoEqTons(20000),
      }),
    ],
    workerBaseline: [workerBaseline(`${id}-STD-F1`, id, 6000, { hoso: 0.85, pd: 0.8, vap: 0.75 })],
    aquacultureCapacity: hosoEqTons(15000),
    salesForceHeadcountTotal: 18,
    procurementHeadcountTotal: 12,
    initialRawMaterialLots: [initialLot(`${id}-STD-RM-INIT`, id, "VN", 3000, 4.2, startPeriod)],
    productEconomics: productEconomics(
      { hoso: 0.5, pd: 0.75, vap: 1.2 },
      premiumEconomics(0.17, 0.15, 0.05, 0.15, 0.03, 0.05),
      premiumEconomics(0.43, 0.35, 0.1, 0.3, 0.06, 0.1)
    ),
  };
}

const CANDIDATE_1: StandardBaselineCandidate = {
  id: "balanced-trimmed",
  label: "候補1: balanced-trimmed（BALの操業条件＋財務余力を調整）",
  rationale:
    "BALの工場能力・ワーカー・養殖能力・商品経済性をそのまま踏襲（既存5社中もっとも" +
    "内部整合性が高く、SAI-1.5で唯一32Qを通して支払不能に陥らなかったため）。財務のみ、" +
    "初期現金を3,000万→2,000万USDへ切り詰め、短期借入を2,000万→2,500万USDへ引き上げる" +
    "ことで、同じ操業設計のまま財務の緩みだけを減らした場合の挙動を確認する。",
  buildFixtureTemplate: buildCandidate1Fixture,
  financeFixtureTemplate: {
    cash: 20_000_000,
    initialAccountsReceivable: 70_000_000,
    otherCurrentAssets: 5_000_000,
    fixedAssetsGross: 90_000_000,
    shortTermLoans: 25_000_000,
    longTermLoans: 30_000_000,
    otherLiabilities: 5_000_000,
    capitalStock: 50_000_000,
  },
  contractDefs: [
    { market: "CN", product: "hoso", quantity: 1200, unitPrice: 5.2, dueDateStr: "2015Q2" },
    { market: "US", product: "hoso", quantity: 1000, unitPrice: 5.35, dueDateStr: "2015Q2" },
    { market: "EU", product: "pd", quantity: 600, unitPrice: 6.85, dueDateStr: "2015Q3" },
    { market: "JP", product: "vap", quantity: 300, unitPrice: 8.75, dueDateStr: "2015Q3" },
  ],
};

// ---------------------------------------------------------------------
// 候補2: five-company blend（5社の中間的な規模・財務・能力を組み合わせた案）
// ---------------------------------------------------------------------
//
// 設計理由: 既存5社の各項目を単純平均すると、「1社を5社に複製しても業界全体の
// 供給量・資金規模の合計が既存5社合計とほぼ変わらない」という性質を構造的に
// 満たせる（5×平均＝既存5社合計）。これは、SAI-1で校正済みの需要規模（シナリオの
// 国内原料供給・trailing平均購入量とのバランス、§COMPANY_LAB_ARCHITECTURE_v0.1.md
// §5）を崩さずに「標準会社」を導入できるという利点がある。単純な平均値の機械的な
// 採用ではなく、平均値をもとに、(a) 工場能力配分がHOSO/PD/VAP間で単一商品への
// 極端な偏りを持たない、(b) ワーカー技能・attendanceが工場能力の商品構成と整合する、
// (c) 借入・現金・売掛金が資産・負債バランスとして貸借一致する、という内部整合性を
// 確認したうえで採用した。
function buildCandidate2Fixture(startPeriod: PeriodV2): CompanyFixture {
  const id = STANDARD_TEMPLATE_ID;
  return {
    companyId: id,
    displayName: "[SAI-2候補2] five-company blend",
    archetype: "balanced",
    description: "SAI-2標準初期条件の候補2（既存5社の単純平均を基礎に内部整合性を確認した中間案）。本番会社設定ではない。",
    country: "VN",
    factories: [
      factory({
        factoryId: `${id}-STD-F1`,
        companyId: id,
        commonProcessingCapacity: hosoEqTons(21400),
        hosoCapacity: hosoEqTons(11000),
        pdCapacity: hosoEqTons(7000),
        vapCapacity: hosoEqTons(5400),
        freezingPackagingCapacity: hosoEqTons(20000),
      }),
    ],
    workerBaseline: [workerBaseline(`${id}-STD-F1`, id, 6300, { hoso: 0.73, pd: 0.75, vap: 0.72 }, 0.95)],
    aquacultureCapacity: hosoEqTons(12400),
    salesForceHeadcountTotal: 16,
    procurementHeadcountTotal: 12,
    initialRawMaterialLots: [initialLot(`${id}-STD-RM-INIT`, id, "VN", 3200, 4.18, startPeriod)],
    productEconomics: productEconomics(
      { hoso: 0.538, pd: 0.772, vap: 1.27 },
      premiumEconomics(0.178, 0.154, 0.052, 0.154, 0.03, 0.056),
      premiumEconomics(0.506, 0.364, 0.1, 0.302, 0.058, 0.108)
    ),
  };
}

const CANDIDATE_2: StandardBaselineCandidate = {
  id: "five-company-blend",
  label: "候補2: five-company blend（既存5社の単純平均＋整合性確認）",
  rationale:
    "既存5社の各項目（工場能力・ワーカー・養殖能力・商品経済性・財務6項目・契約総額）の" +
    "単純平均を基礎とする。5社すべてをこの値に統一しても業界全体の供給量・資金規模の合計は" +
    "既存5社合計とほぼ変わらないため、SAI-1で校正済みの需要規模とのバランスを崩さない。" +
    "工場能力配分（11,000/7,000/5,400）は単一商品への極端な偏りがなく、ワーカー技能" +
    "（0.73/0.75/0.72）も3商品でほぼ均等であることを確認済み。",
  buildFixtureTemplate: buildCandidate2Fixture,
  financeFixtureTemplate: {
    cash: 28_400_000,
    initialAccountsReceivable: 45_600_000,
    otherCurrentAssets: 3_400_000,
    fixedAssetsGross: 80_000_000,
    shortTermLoans: 16_000_000,
    longTermLoans: 26_600_000,
    otherLiabilities: 4_000_000,
    capitalStock: 45_000_000,
  },
  contractDefs: [
    { market: "CN", product: "hoso", quantity: 550, unitPrice: 5.2, dueDateStr: "2015Q2" },
    { market: "US", product: "hoso", quantity: 550, unitPrice: 5.3, dueDateStr: "2015Q2" },
    { market: "EU", product: "pd", quantity: 400, unitPrice: 6.9, dueDateStr: "2015Q3" },
    { market: "JP", product: "pd", quantity: 300, unitPrice: 7.0, dueDateStr: "2015Q3" },
    { market: "JP", product: "vap", quantity: 300, unitPrice: 8.9, dueDateStr: "2015Q3" },
    { market: "EU", product: "vap", quantity: 230, unitPrice: 8.85, dueDateStr: "2015Q3" },
  ],
};

// ---------------------------------------------------------------------
// 候補3: moderate-pressure（やや厳しいが、standard AIの経営判断によって
// 乗り切れることを狙った案）
// ---------------------------------------------------------------------
//
// 設計理由: 候補2（blend）の操業条件（工場能力・ワーカー・養殖能力・商品経済性）を
// そのまま踏襲しつつ、財務側だけをやや厳しくする。初期現金を候補2の2,840万USDから
// 1,800万USDへ引き下げ、短期借入を1,600万→2,600万USD、長期借入を2,660万→
// 3,500万USDへ引き上げる。これにより、estimateTargetMinimumCashUsd（会社規模連動の
// 最低現金バッファ目安）に対する初期現金の比率が候補2よりも明確に低くなり、
// standard AIの資金繰り判断（financing.ts）・調達縮小判断（procurement.ts）が
// 開始直後から実際に機能する必要が生じる設計を狙った。ただし、借入がゼロ資産
// （担保）に対して過大にならないよう、収益力（原料在庫・売掛金等の担保価値）との
// バランスは候補2から変えていない。
function buildCandidate3Fixture(startPeriod: PeriodV2): CompanyFixture {
  return {
    ...buildCandidate2Fixture(startPeriod),
    displayName: "[SAI-2候補3] moderate-pressure",
    description: "SAI-2標準初期条件の候補3（候補2の操業条件を踏襲し、財務のみをやや厳しくした案）。本番会社設定ではない。",
  };
}

const CANDIDATE_3: StandardBaselineCandidate = {
  id: "moderate-pressure",
  label: "候補3: moderate-pressure（候補2の操業条件＋財務を厳格化）",
  rationale:
    "候補2の操業条件（工場能力・ワーカー・養殖能力・商品経済性）をそのまま踏襲し、財務のみ" +
    "厳しくする。初期現金2,840万→1,800万USD、短期借入1,600万→2,600万USD、長期借入" +
    "2,660万→3,500万USDへ変更。担保価値（原料在庫・売掛金等）とのバランスは候補2から" +
    "変えていない。standard AIの資金繰り・調達縮小判断が開始直後から必要になることを狙う。",
  buildFixtureTemplate: buildCandidate3Fixture,
  financeFixtureTemplate: {
    cash: 18_000_000,
    initialAccountsReceivable: 45_600_000,
    otherCurrentAssets: 3_400_000,
    fixedAssetsGross: 80_000_000,
    shortTermLoans: 26_000_000,
    longTermLoans: 35_000_000,
    otherLiabilities: 4_000_000,
    capitalStock: 45_000_000,
  },
  contractDefs: CANDIDATE_2.contractDefs,
};

export const STANDARD_BASELINE_CANDIDATES: readonly StandardBaselineCandidate[] = [CANDIDATE_1, CANDIDATE_2, CANDIDATE_3];

// ---------------------------------------------------------------------
// 選定結果（§SAI-2レポート参照）。候補別基準テストの結果をもとに1案を選定し、
// 以降のSAI-2以降の感度分析はこのbuilderを標準の再利用可能な入口として使う。
// ---------------------------------------------------------------------

/** 選定された標準初期条件の候補ID。docs/v2/reports/sai2_standard_baseline_report.md
 *  §5の選定理由を参照。 */
export const SELECTED_STANDARD_BASELINE_CANDIDATE_ID = "moderate-pressure";

function selectedCandidate(): StandardBaselineCandidate {
  const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID);
  if (!candidate) throw new Error(`選定済み標準初期条件の候補IDが見つかりません: ${SELECTED_STANDARD_BASELINE_CANDIDATE_ID}`);
  return candidate;
}

/** 選定された標準初期条件のfixtureテンプレートを構築する（用途が明確な再利用可能な
 *  builder）。5社へ複製する際はdecomposeHarness.tsのbuildUnifiedFixturesFromTemplate
 *  等を通す（companyIdはそこで上書きされる）。 */
export function buildStandardBaselineFixture(startPeriod: PeriodV2): CompanyFixture {
  return selectedCandidate().buildFixtureTemplate(startPeriod);
}

/** 選定された標準初期条件の初期財務テンプレート（companyId抜き）。 */
export function standardBaselineFinanceFixtureTemplate(): Omit<InitialFinanceFixture, "companyId"> {
  return selectedCandidate().financeFixtureTemplate;
}

/** 選定された標準初期条件の初期契約定義一覧。 */
export function standardBaselineContractDefs(): readonly UnifiedContractDef[] {
  return selectedCandidate().contractDefs;
}
