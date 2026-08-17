// ShrimpX V2 — Company Lab / Test15 期初情報ビューモデル（Turn1から見える財務・償却資産・市場）
//
// 【なぜ必要か】Turn1の開始画面には、経営判断（原料をいくらで何トン買うか、どの市場へ
// どの商品をいくらで出すか、生産をどれだけ積むか）に必要な初期情報が表示されていなかった。
// ゲームエンジンはこれらの値をすべて既に持っているため、新しい予測ロジックは一切作らず、
// 既存の状態・既存のパラメータを読み出して並べるだけの純粋関数としてここに集約する。
//
// 【この層がやらないこと】
//   - 値の推定・補完をしない。取得できない項目は undefined を返し、画面側が「－」を出す
//     （0で埋めない。Export API・Excel側と同じ「値が無ければ捏造しない」方針）。
//   - 将来四半期の情報・他社の非公開情報を一切読まない。入力は自社の CompanyOwnState と、
//     全社共通の公開パラメータ（market/sales/finance の parameters.ts）だけ。
//   - React・DOM・fetch に依存しない（Node上の単体テストからそのまま呼べる）。

import { PeriodV2 } from "../../../../lib/v2/core/period";

import type { CompanyOwnState } from "../../../../lib/v2/companyLab/types";
import { rawMaterialInventoryValueUsd } from "../../../../lib/v2/finance/initialState";
import { totalUnitCostPerTon } from "../../../../lib/v2/finance/types";
import { FINANCE_PARAMETERS_V1 } from "../../../../lib/v2/finance/parameters";
import { MARKET_PARAMETERS_V1 } from "../../../../lib/v2/market/parameters";
import { PRODUCT_LIFECYCLE_PARAMETERS_V1, ProductLifecycleParameters } from "../../../../lib/v2/market/productLifecycle";
import { InformationRelease } from "../../../../lib/v2/scenario/types";
import { DEMAND_MARKET_IDS, DemandMarketId } from "../../../../lib/v2/market/types";
import { SALES_PARAMETERS_V1 } from "../../../../lib/v2/sales/parameters";
import type { CapitalProject } from "../../../../lib/v2/capex/types";
import type { DomesticReferencePrice } from "../../../../lib/v2/companyLab/domesticReferencePrice";
import type { ObservedMarketDemand } from "../../../../lib/v2/companyLab/marketDemandObservation";

// ---------------------------------------------------------------------
// 1. 期初BS（A-1）
// ---------------------------------------------------------------------

/** BSの1行。valueがundefinedなら画面は「－」を表示する（0で埋めない）。 */
export interface OpeningBalanceSheetRow {
  readonly label: string;
  readonly value: number | undefined;
  /** 小計・合計行（画面側で強調表示する）。 */
  readonly emphasis?: boolean;
}

export interface OpeningBalanceSheet {
  readonly assets: readonly OpeningBalanceSheetRow[];
  readonly liabilities: readonly OpeningBalanceSheetRow[];
  readonly equity: readonly OpeningBalanceSheetRow[];
  readonly totalAssets: number;
  readonly totalLiabilities: number;
  readonly totalEquity: number;
  /** 有利子負債(短期+長期) ÷ 純資産。純資産が0以下のときは undefined（無限大を表示しない）。 */
  readonly debtEquityRatio: number | undefined;
  /** 資産合計 −（負債合計＋純資産合計）。0近傍であるべき検算値。 */
  readonly balanceDifference: number;
  /** 現金（assets[0]と同じ値）。スクロールせず見える「一目」表示用に単独で持つ。 */
  readonly cash: number;
  /** 有利子負債合計（短期借入金＋長期借入金）。「一目」表示用に単独で持つ。 */
  readonly totalDebt: number;
}

/**
 * 前期末（＝当期開始時点）の会社財務状態からBSを組み立てる。
 *
 * 原料在庫・完成品在庫は CompanyFinanceState に金額として保持されていないため、
 * 財務エンジンと同一の評価方法で算出する:
 *   - 原料在庫: finance/initialState.ts の rawMaterialInventoryValueUsd（ロット簿価の合計）
 *   - 完成品在庫: finishedGoodsCostLedger の 残数量 × totalUnitCostPerTon（finance/types.ts）
 * どちらも財務エンジン（quarterClose.ts）が期末BSを作るときに使うのと同じ式であり、
 * ここで独自の評価ロジックを持ち込んではいない。
 */
export function buildOpeningBalanceSheet(ownState: CompanyOwnState): OpeningBalanceSheet {
  const f = ownState.financeState;

  const cash = Number(f.cash);
  const receivables = f.receivables.reduce((s, r) => s + Number(r.amount), 0);
  const rawMaterialInventory = rawMaterialInventoryValueUsd(ownState.rawMaterialLots, ownState.companyId);
  const finishedGoodsInventory = f.finishedGoodsCostLedger.reduce(
    (s, e) => s + e.remainingQuantity * totalUnitCostPerTon(e.unitCost),
    0
  );
  const otherCurrentAssets = Number(f.otherCurrentAssets);
  const fixedAssetsGross = Number(f.fixedAssetsGross);
  const accumulatedDepreciation = Number(f.accumulatedDepreciation);
  const fixedAssetsNet = fixedAssetsGross - accumulatedDepreciation;
  // 建設中勘定は capex ポートフォリオの支払累計（未完成案件ぶん）。
  const constructionInProgress = ownState.capexState.portfolio.projects
    .filter((p) => p.status === "underConstruction" || p.status === "suspended")
    .reduce((s, p) => s + p.cumulativePaidUsd, 0);

  const payables = f.payables.reduce((s, p) => s + Number(p.amount), 0);
  const shortTermLoans = Number(f.shortTermLoans);
  const longTermLoans = Number(f.longTermLoans);
  const otherLiabilities = Number(f.otherLiabilities);
  const capitalStock = Number(f.capitalStock);
  const retainedEarnings = Number(f.retainedEarnings);

  const totalAssets =
    cash + receivables + rawMaterialInventory + finishedGoodsInventory + otherCurrentAssets + fixedAssetsNet + constructionInProgress;
  const totalLiabilities = payables + shortTermLoans + longTermLoans + otherLiabilities;
  const totalEquity = capitalStock + retainedEarnings;

  return {
    assets: [
      { label: "現金 (Cash)", value: cash },
      { label: "売掛金 (Accounts Receivable)", value: receivables },
      { label: "原料在庫 (Raw Material Inventory)", value: rawMaterialInventory },
      { label: "完成品在庫 (Finished Goods Inventory)", value: finishedGoodsInventory },
      { label: "その他流動資産 (Other Current Assets)", value: otherCurrentAssets },
      { label: "固定資産 取得原価 (Fixed Assets, Gross)", value: fixedAssetsGross },
      { label: "　減価償却累計額 (Accumulated Depreciation)", value: -accumulatedDepreciation },
      { label: "固定資産 純額 (Fixed Assets, Net)", value: fixedAssetsNet, emphasis: true },
      { label: "建設中勘定 (Construction in Progress)", value: constructionInProgress },
      { label: "資産合計 (Total Assets)", value: totalAssets, emphasis: true },
    ],
    liabilities: [
      { label: "買掛金 (Accounts Payable)", value: payables },
      { label: "短期借入金 (Short-term Debt)", value: shortTermLoans },
      { label: "長期借入金 (Long-term Debt)", value: longTermLoans },
      { label: "その他負債 (Other Liabilities)", value: otherLiabilities },
      { label: "負債合計 (Total Liabilities)", value: totalLiabilities, emphasis: true },
    ],
    equity: [
      { label: "資本金 (Capital)", value: capitalStock },
      { label: "利益剰余金 (Retained Earnings)", value: retainedEarnings },
      { label: "純資産合計 (Total Equity)", value: totalEquity, emphasis: true },
    ],
    totalAssets,
    totalLiabilities,
    totalEquity,
    debtEquityRatio: totalEquity > 0 ? (shortTermLoans + longTermLoans) / totalEquity : undefined,
    balanceDifference: totalAssets - (totalLiabilities + totalEquity),
    cash,
    totalDebt: shortTermLoans + longTermLoans,
  };
}

// ---------------------------------------------------------------------
// 2. 償却資産明細（A-2）
// ---------------------------------------------------------------------

export interface DepreciableAssetRow {
  readonly category: string;
  /** 取得原価。区分できない場合はundefined。 */
  readonly grossBookValue: number | undefined;
  readonly accumulatedDepreciation: number | undefined;
  readonly netBookValue: number | undefined;
  readonly status: "稼働中" | "建設中";
  /** 完成予定Turn。建設中案件のみ算出できる（残り必要支払四半期数から導出）。 */
  readonly expectedCompletionTurn: number | undefined;
  /** 残存耐用年数（四半期数）。既存資産のみ既知。 */
  readonly remainingLifeQuarters: number | undefined;
  readonly note: string;
}

export interface DepreciableAssetsBreakdown {
  readonly rows: readonly DepreciableAssetRow[];
  /** 明細の簿価合計（稼働中＋建設中）。 */
  readonly totalNetBookValue: number;
  /** BS側の固定資産純額＋建設中勘定。 */
  readonly balanceSheetFixedAssetsNetPlusCip: number;
  /** 明細合計とBS側の差額（0近傍であるべき検算値）。 */
  readonly reconciliationDifference: number;
}

/**
 * 償却資産明細を組み立てる。
 *
 * 【簡略モデルであることの明示】既存資産（ゲーム開始時点の fixedAssetsGross）は
 * 個別の取得履歴を持たない。財務エンジン（finance/depreciation.ts）が建物35%／機械65%の
 * 共通比率で簡便配分して定額償却しているため、明細もその同じ配分をそのまま使う
 * （ここで別の配分規則を発明しない）。capex経由で完成した資産は取得原価が個別に
 * 分からないため、既存資産と完成capex資産を分離せず「既存＋完成投資」として1行にまとめ、
 * noteでその旨を明記する（存在しない情報を捏造しない）。
 */
export function buildDepreciableAssets(ownState: CompanyOwnState, currentTurn: number): DepreciableAssetsBreakdown {
  const f = ownState.financeState;
  const cfg = FINANCE_PARAMETERS_V1.finance.existingAssetDepreciation;

  const fixedAssetsGross = Number(f.fixedAssetsGross);
  const accumulatedDepreciation = Number(f.accumulatedDepreciation);
  const fixedAssetsNet = fixedAssetsGross - accumulatedDepreciation;

  // 建物・機械の按分は取得原価ベース。減価償却累計額も同じ比率で按分して表示する
  // （コンポーネント別の累計額は財務状態として保持されていないため、按分値である
  // ことを note で明示する）。
  const buildingGross = fixedAssetsGross * cfg.buildingOpeningRatio;
  const machineryGross = fixedAssetsGross * cfg.machineryOpeningRatio;
  const buildingAccum = accumulatedDepreciation * cfg.buildingOpeningRatio;
  const machineryAccum = accumulatedDepreciation * cfg.machineryOpeningRatio;

  const elapsedQuarters = Math.max(0, currentTurn - 1);
  const rows: DepreciableAssetRow[] = [
    {
      category: "建物・構築物（Factory buildings）",
      grossBookValue: buildingGross,
      accumulatedDepreciation: buildingAccum,
      netBookValue: buildingGross - buildingAccum,
      status: "稼働中",
      expectedCompletionTurn: undefined,
      remainingLifeQuarters: Math.max(0, cfg.buildingRemainingLifeQuartersAtGameStart - elapsedQuarters),
      note: `取得原価の${(cfg.buildingOpeningRatio * 100).toFixed(0)}%を建物区分として簡便配分（finance/parameters.ts）。定額法・ゲーム開始時点の残存${cfg.buildingRemainingLifeQuartersAtGameStart}四半期。`,
    },
    {
      category: "機械・加工設備（Processing equipment）",
      grossBookValue: machineryGross,
      accumulatedDepreciation: machineryAccum,
      netBookValue: machineryGross - machineryAccum,
      status: "稼働中",
      expectedCompletionTurn: undefined,
      remainingLifeQuarters: Math.max(0, cfg.machineryRemainingLifeQuartersAtGameStart - elapsedQuarters),
      note: `取得原価の${(cfg.machineryOpeningRatio * 100).toFixed(0)}%を機械区分として簡便配分。定額法・ゲーム開始時点の残存${cfg.machineryRemainingLifeQuartersAtGameStart}四半期。完成済みの設備投資資産もこの2区分に含まれる（取得原価が個別に分離保持されていないため）。`,
    },
  ];

  // 建設中の設備投資案件（capex）。案件種別ごとに1行ずつ出す。
  for (const p of ownState.capexState.portfolio.projects) {
    if (p.status !== "underConstruction" && p.status !== "suspended") continue;
    rows.push({
      category: `${describeProjectType(p)}（建設中: ${p.projectId}）`,
      grossBookValue: p.approvedBudgetUsd,
      // 建設中資産は稼働開始まで償却しない（完成時に固定資産へ振替えてから償却が始まる）。
      accumulatedDepreciation: 0,
      netBookValue: p.cumulativePaidUsd,
      status: "建設中",
      expectedCompletionTurn: estimateCompletionTurn(p, currentTurn),
      remainingLifeQuarters: undefined,
      note: `承認予算 $${Math.round(p.approvedBudgetUsd).toLocaleString()}、支払済 ${p.completedPaymentStagesCount}/${p.paymentSchedule.length}回、支払成功四半期 ${p.elapsedConstructionQuartersWithPayment}/${p.requiredConstructionQuarters}${p.status === "suspended" ? "（現在中断中。再開要求が必要）" : ""}`,
    });
  }

  const totalNetBookValue = rows.reduce((s, r) => s + (r.netBookValue ?? 0), 0);
  const constructionInProgress = ownState.capexState.portfolio.projects
    .filter((p) => p.status === "underConstruction" || p.status === "suspended")
    .reduce((s, p) => s + p.cumulativePaidUsd, 0);
  const balanceSheetFixedAssetsNetPlusCip = fixedAssetsNet + constructionInProgress;

  return {
    rows,
    totalNetBookValue,
    balanceSheetFixedAssetsNetPlusCip,
    reconciliationDifference: totalNetBookValue - balanceSheetFixedAssetsNetPlusCip,
  };
}

function describeProjectType(p: CapitalProject): string {
  switch (p.projectType) {
    case "pdMechanization":
      return "PD省人化投資（PD mechanization）";
    case "newFactoryConstruction":
      return "新工場建設（Factory construction）";
    case "coldStorageExpansion":
      return "冷蔵設備増設（Cold storage）";
    default:
      return p.projectType;
  }
}

/**
 * 完成予定Turn＝現在Turn＋（残りの必要支払成功四半期数）。
 * 中断中の案件は再開時期が決まらないため undefined（推測しない）。
 */
function estimateCompletionTurn(p: CapitalProject, currentTurn: number): number | undefined {
  if (p.status !== "underConstruction") return undefined;
  const remaining = p.requiredConstructionQuarters - p.elapsedConstructionQuartersWithPayment;
  if (remaining <= 0) return currentTurn;
  return currentTurn + remaining;
}

// ---------------------------------------------------------------------
// 3. 期初市場情報（A-3）
// ---------------------------------------------------------------------

export interface RawMaterialMarketInfo {
  /** 前四半期のベトナム国内原料価格（USD/HOSO換算kg）。Turn1ではシナリオの初期値。 */
  readonly vietnamDomesticPriorPrice: number;
  /** 農家留保価格の構成（この水準を下回る買付は成立しない）。 */
  readonly farmerReservationPrice: {
    readonly farmingCost: number;
    readonly diseaseRiskAllowance: number;
    readonly minimumMargin: number;
    readonly total: number;
  };
  /** 産地国別のHOSO FOB初期価格（USD/kg）。輸入検討時の価格差の出発点。 */
  readonly initialHosoFobPriceByCountry: Readonly<Record<string, number>>;
  /** 1社が国内供給量から買い付けられる最大シェア。 */
  readonly maximumBuyerShare: number;
  readonly notes: readonly string[];
}

export interface SalesMarketInfoRow {
  readonly market: DemandMarketId;
  readonly displayName: string;
  /** 前期消費量（HOSO換算t）。シナリオ定義の値。 */
  readonly priorPeriodConsumption: number | undefined;
  readonly economicIndex: number | undefined;
  readonly populationGrowthRate: number | undefined;
  /** 商品構成比（初期値）。hosoは 1 - pd - vap。 */
  readonly initialShareByProduct: { readonly hoso: number; readonly pd: number; readonly vap: number };
  /** 成熟時の商品構成比（この市場が最終的に向かう構成）。 */
  readonly matureShareByProduct: { readonly hoso: number; readonly pd: number; readonly vap: number };
  readonly characteristics: string;
}

export interface OpeningMarketInfo {
  readonly rawMaterial: RawMaterialMarketInfo;
  readonly salesMarkets: readonly SalesMarketInfoRow[];
  /** 成約競争力の需要ウェイト（価格・営業カバレッジ・顧客関係・品質・納期・営業基盤）。 */
  readonly competitivenessWeights: Readonly<Record<string, number>>;
  /** 1社が1市場×商品の需要から成約できる最大シェア。 */
  readonly maximumSupplierShare: number;
  /** 5社以外の外部選択肢の競争力ウェイト（これを上回らないと成約が取れない）。 */
  readonly externalOptionWeight: number;
  /** PD/VAPの参考プレミアム率（HOSO基準価格に対する倍率）。 */
  readonly productPremiumRatio: { readonly pd: number; readonly vap: number };
  /** 商品別の営業工数係数（同じトン数でも必要な営業工数が違う）。 */
  readonly salesEffortCoefficients: Readonly<Record<string, number>>;
  /** 参考市場価格（HOSO/PD/VAP、USD/HOSO換算kg）。Turn1はFOB初期価格の加重平均を基準に算出。 */
  readonly referencePriceByProduct: { readonly hoso: number; readonly pd: number; readonly vap: number };
}

const MARKET_DISPLAY_NAME: Readonly<Record<DemandMarketId, string>> = {
  US: "USA（米国）",
  JP: "Japan（日本）",
  EU: "EU（欧州）",
  CN: "China（中国）",
  OTHER: "Asia / Other（その他）",
};

const MARKET_CHARACTERISTICS: Readonly<Record<DemandMarketId, string>> = {
  US: "大規模市場。PD需要が厚く、VAPも中期的に伸びる（成熟PD38% / VAP26%）。",
  JP: "高付加価値市場。初期からVAP比率が最も高く（10%）、成熟時VAP30%まで伸びる。品質・納期の要求が厳しい。",
  EU: "中規模・品質重視。PD/VAPの伸びはUS/JPよりやや遅い（加速開始turn10）。",
  CN: "最大の数量市場だがHOSO中心（初期VAP1%）。付加価値化の立ち上がりが最も遅い（加速開始turn16〜22）。",
  OTHER: "その他アジア等。HOSO主体で価格感応度が高い。",
};

/**
 * 期初の市場情報を組み立てる。
 *
 * 【予測しない】ここで新しい需要予測・価格予測は一切行わない。表示するのは
 *   (a) market/parameters.ts・sales/parameters.ts・market/productLifecycle.ts の静的パラメータ
 *   (b) publicInfo.vietnamDomesticPriorPrice（エンジンが既に持っている前期国内価格）
 *   (c) シナリオ定義が持つ市場別の前期消費量・景気指数・人口成長率
 * だけである。(c) は「前期の実績」であり、当期の実現需要ではない（既存の情報境界を
 * 越えない）。
 *
 * @param priorConsumptionByMarket シナリオ定義由来の市場別前期消費量等。取得できない
 *        呼び出し経路では省略でき、その場合は該当項目が undefined になる。
 */
export function buildOpeningMarketInfo(
  vietnamDomesticPriorPrice: number,
  priorConsumptionByMarket?: Readonly<
    Partial<Record<DemandMarketId, { readonly priorPeriodConsumption: number; readonly economicIndex: number; readonly populationGrowthRate: number }>>
  >,
  /**
   * 【Dynamic Scenario 1】市場別の初期/成熟構成比を表示するための実効
   * ライフサイクルパラメータ。省略時は市場モジュール既定値（＝従来表示）。
   */
  lifecycleParameters: ProductLifecycleParameters = PRODUCT_LIFECYCLE_PARAMETERS_V1
): OpeningMarketInfo {
  const farmer = MARKET_PARAMETERS_V1.vietnamDomestic.farmerEconomicsDefaults;
  const premium = MARKET_PARAMETERS_V1.pdVapPremium;

  // 参考市場価格は「前期の国内原料価格」ではなく、産地FOB価格の世界影響度加重平均を
  // HOSO基準とし、PD/VAPはその基準にプレミアム率を掛けたもの（市場エンジンが実際に
  // 使う pdBasePremiumRatio / vapBasePremiumRatio と同じ係数）。
  const fob = MARKET_PARAMETERS_V1.initialHosoFobPriceUsdPerKg;
  const w = MARKET_PARAMETERS_V1.worldInfluenceWeight;
  const hosoReference = fob.EC * w.EC + fob.IN * w.IN + fob.VN * w.VN + fob.ID * w.ID;

  return {
    rawMaterial: {
      vietnamDomesticPriorPrice,
      farmerReservationPrice: {
        farmingCost: farmer.farmingCostUsdPerHosoEqKg,
        diseaseRiskAllowance: farmer.diseaseRiskAllowanceUsdPerHosoEqKg,
        minimumMargin: farmer.minimumFarmerMarginUsdPerHosoEqKg,
        total:
          farmer.farmingCostUsdPerHosoEqKg + farmer.diseaseRiskAllowanceUsdPerHosoEqKg + farmer.minimumFarmerMarginUsdPerHosoEqKg,
      },
      initialHosoFobPriceByCountry: fob,
      maximumBuyerShare: 0.35,
      notes: [
        "国内買付価格は、買付希望量が国内供給量に対して増えるほど上昇する（需給連動）。",
        "農家留保価格を下回る買付上限を提示すると、取引数量そのものが減る（quantityRationing）。",
        "1社が国内供給量の35%を超えて買い付けることはできない。",
        "輸入は発注から到着までリードタイムがあり、当期の生産には間に合わないことがある。",
      ],
    },
    salesMarkets: DEMAND_MARKET_IDS.map((market) => {
      const lc = lifecycleParameters.byMarket[market];
      const prior = priorConsumptionByMarket?.[market];
      return {
        market,
        displayName: MARKET_DISPLAY_NAME[market],
        priorPeriodConsumption: prior?.priorPeriodConsumption,
        economicIndex: prior?.economicIndex,
        populationGrowthRate: prior?.populationGrowthRate,
        initialShareByProduct: {
          hoso: 1 - lc.pd.initialShare - lc.vap.initialShare,
          pd: lc.pd.initialShare,
          vap: lc.vap.initialShare,
        },
        matureShareByProduct: {
          hoso: 1 - lc.pd.matureShare - lc.vap.matureShare,
          pd: lc.pd.matureShare,
          vap: lc.vap.matureShare,
        },
        characteristics: MARKET_CHARACTERISTICS[market],
      };
    }),
    competitivenessWeights: { ...SALES_PARAMETERS_V1.competitivenessWeights },
    maximumSupplierShare: SALES_PARAMETERS_V1.maximumSupplierShare,
    externalOptionWeight: SALES_PARAMETERS_V1.externalOptionWeight,
    productPremiumRatio: { pd: premium.pdBasePremiumRatio, vap: premium.vapBasePremiumRatio },
    salesEffortCoefficients: { ...SALES_PARAMETERS_V1.salesEffortCoefficients },
    referencePriceByProduct: {
      hoso: hosoReference,
      pd: hosoReference * (1 + premium.pdBasePremiumRatio),
      vap: hosoReference * (1 + premium.vapBasePremiumRatio),
    },
  };
}

/** 画面へ渡す期初情報のまとめ（viewModelの1フィールドとして持たせる）。 */
/**
 * 【Dynamic Scenario 1】公開済みシナリオNewsを画面表示用へ変換する。
 *
 * 情報の絞り込み（未来のイベントを返さない・GM情報を混ぜない・postGameTruthを
 * 落とす）は scenario/informationEngine.ts が既に多重防御で行っている。
 * ここでは表示に必要なフィールドを取り出すだけで、判定ロジックを再実装しない。
 */
export function toScenarioNewsItems(releases: readonly InformationRelease[]): readonly ScenarioNewsItem[] {
  return [...releases]
    // 新しいNewsを上に。同じターンなら確定情報（噂でない）を先に見せる。
    .sort((a, b) => b.availableFromTurn - a.availableFromTurn || Number(a.isRumor) - Number(b.isRumor) || a.informationId.localeCompare(b.informationId))
    .map((r) => ({
      informationId: r.informationId,
      headline: r.headlineTemplate,
      body: r.body ?? null,
      isRumor: r.isRumor,
      confidence: r.confidence ?? null,
      availableFromTurn: r.availableFromTurn,
      facts: r.structuredFacts.map((f) => ({ label: f.label, value: String(f.value), ...(f.unit !== undefined ? { unit: f.unit } : {}) })),
      estimateRange: r.estimateRange ?? null,
    }));
}

export interface OpeningInfoViewModel {
  readonly period: PeriodV2;
  readonly turn: number;
  /**
   * 【Test15】国内原料の参考買付価格。市場エンジンの清算価格をそのまま読み出したもの。
   * 取得できなかった場合はnull（画面は「－」を表示し、価格を捏造しない）。
   */
  readonly domesticReferencePrice: DomesticReferencePrice | null;
  readonly balanceSheet: OpeningBalanceSheet;
  readonly depreciableAssets: DepreciableAssetsBreakdown;
  readonly marketInfo: OpeningMarketInfo;
  /**
   * 【Batch 002】市場×商品別の観測需要（原則2四半期前の実績。turn1・turn2は
   * ゲーム開始時点の既知市場情報）。Standard AIが見るのと完全に同じ値を、
   * publicInfoからそのまま渡す（画面側で再計算しない）。
   */
  readonly observedMarketDemand: ObservedMarketDemand | undefined;
  /**
   * 【Dynamic Scenario 1】当該ターンまでに公開されたシナリオNews（世界情勢）。
   * scenario/informationEngine.ts の getAvailableInformation をそのまま読み出した
   * ものであり、画面側で新しい情報を作らない。未来のイベント・GM専用情報・
   * ゲーム終了後の真実は情報エンジン側で構造的に除外されている。
   *
   * これは**外部世界の情報**であり、他社の意思決定・シェア等の競争情報は
   * 一切含まない（競争情報は既存の market report 側の責務）。
   */
  readonly scenarioNews: readonly ScenarioNewsItem[];
}

/** 画面表示用に絞り込んだシナリオNews 1件。 */
export interface ScenarioNewsItem {
  readonly informationId: string;
  readonly headline: string;
  /** 記事本文。未設定の記事では null（画面は見出しと事実だけを出す）。 */
  readonly body: string | null;
  /** 噂（Leading Indicator）か、確定した事象（Current Event / Structural Trend）か。 */
  readonly isRumor: boolean;
  /** 0〜1。未指定なら null（確信度を捏造しない）。 */
  readonly confidence: number | null;
  readonly availableFromTurn: number;
  /** 定性的な構造化事実（内部パラメータ値は情報エンジン側で除外済み）。 */
  readonly facts: readonly { readonly label: string; readonly value: string; readonly unit?: string }[];
  /** 見積り範囲（幅で示す量的ヒント）。無ければ null。 */
  readonly estimateRange: { readonly low: number; readonly high: number; readonly unit?: string } | null;
}
