// ShrimpX V2 — Independent Player Flow: Workspace 表示用ビューモデル
//
// 【このモジュールが存在する理由】
//   受講者が実際に使う画面は /v2/play/workspace（join リンク・seat Cookie 認証）
//   だが、そこには Overview / Market / Inventory が無く、意思決定タブしか無かった。
//   一方 GM コンソール側の PlayerWorkspace（/v2/management/player）には3タブとも
//   あるが、こちらは GM のブラウザタブ内キャッシュ（liveSessionRegistry）を
//   Source of Truth にしており、受講者の端末からは原理的に開けない。
//
//   そこで「受講者へ返してよい値だけ」をサーバー側で組み立て、
//   PlayerDecisionContext に載せて返す。クライアントは表示するだけにする。
//
// 【情報境界（最重要）】
//   GM コンソールの MarketSummary は dataset.marketMetrics の visibility==="trueWorld"
//   を読む Game Owner 向けの表示であり、「Standard AI はこの値を直接見ず、観測遅延の
//   ある observation だけを使う」と当該ファイル自身が明記している。
//   したがってそれを受講者画面へそのまま移植してはならない（プレイヤーだけが
//   当期の真の需要を見ることになり、Standard AI に対して情報優位が生じる）。
//
//   受講者向けの市場情報は PublicMarketInfo.observedMarketDemand を正本にする。
//   この値は types.ts が「プレイヤー画面と Standard AI Observation は必ず同じ
//   この値を参照する」と規定しているもので、A-8（開始時基準価格）で確立した
//   情報境界の扱いと同じ方針である。
//
// 【このモジュールがやらないこと】
//   - 新しい経済計算をしない。確定記録・既存ビルダーの値を選んで並べるだけ。
//   - 他社の非公開値（現金・利益・原価・市場別配置・AI の判断理由）を一切含めない。
//   - 値が無いときに 0 で埋めない（null のまま返し、画面側で「未取得」と出す）。

import { CompanyId } from "../sales/types";
import { DemandMarketId, Product } from "../market/types";
import { CompanyQuarterRecord, PublicMarketInfo } from "../companyLab/types";
import { MarketProductBasePriceReference } from "../sales/marketBasePriceReference";
import { CompanyEvaluationSnapshot } from "../companyLab/evaluation/evaluationSemantics";
import { unwrapUnit } from "../core/units";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------
// 1. Inventory（自社のみ）
// ---------------------------------------------------------------------

export interface PlayerInventoryView {
  readonly newContractedTons: number;
  readonly fulfilledTons: number;
  readonly backlogTons: number;
  readonly previousBacklogTons: number | null;
  readonly overdueTons: number;
  /** 納期超過が0より大きい＝画面で目立たせてよい。 */
  readonly overdueIsSignificant: boolean;
  readonly finishedGoodsInventoryTons: number;
  readonly rawMaterialInventoryTons: number;
  /** 設備稼働率（取得できなければ null。0で埋めない）。 */
  readonly equipmentUtilizationRate: number | null;
  /** 労働稼働率（取得できなければ null）。 */
  readonly laborUtilizationRate: number | null;
}

/**
 * 直近確定Turnの自社サマリーから在庫・受注残・稼働率を選ぶ。
 *
 * 計算式は持たない（受注残・納期超過・稼働率はいずれも会社ラボ本体が既に
 * 確定させた CompanyQuarterSummary の値をそのまま読むだけ）。
 * GM 側の buildBacklogDisplay と同じフィールドを同じ意味で読む。
 */
export function buildPlayerInventoryView(
  lastRecord: CompanyQuarterRecord | null,
  previousRecord: CompanyQuarterRecord | null,
  companyId: CompanyId
): PlayerInventoryView | null {
  const summary = lastRecord?.companySummaries.find((c) => c.companyId === companyId) ?? null;
  if (!summary) return null;
  const previousSummary = previousRecord?.companySummaries.find((c) => c.companyId === companyId) ?? null;
  const overdueTons = unwrapUnit(summary.overdueQuantity);
  return {
    newContractedTons: unwrapUnit(summary.newContractedQuantity),
    fulfilledTons: unwrapUnit(summary.fulfilledQuantity),
    backlogTons: unwrapUnit(summary.outstandingQuantity),
    previousBacklogTons: previousSummary ? unwrapUnit(previousSummary.outstandingQuantity) : null,
    overdueTons,
    overdueIsSignificant: overdueTons > 0,
    finishedGoodsInventoryTons: unwrapUnit(summary.finishedGoodsInventory),
    rawMaterialInventoryTons: unwrapUnit(summary.rawMaterialInventory),
    equipmentUtilizationRate: finiteOrNull(unwrapUnit(summary.equipmentUtilizationRate)),
    laborUtilizationRate: finiteOrNull(unwrapUnit(summary.laborUtilizationRate)),
  };
}

// ---------------------------------------------------------------------
// 2. Market（公開情報のみ）
// ---------------------------------------------------------------------

/** 市場×商品1マスぶんの公開情報。 */
export interface PlayerMarketCell {
  readonly market: DemandMarketId;
  readonly product: Product;
  /**
   * 遅行公開の需要量（t）。PublicMarketInfo.observedMarketDemand 由来であり、
   * 当期の確定需要ではない（原則2四半期前の実績）。取得できなければ null。
   */
  readonly observedDemandTons: number | null;
  /**
   * 前四半期の市場基準価格（USD/kg）。Turn 1 ではゲーム開始時の基準価格
   * （A-8 で追加した GAME_START_MARKET_INFORMATION）になる。取得できなければ null。
   */
  readonly basePriceUsdPerKg: number | null;
  /** 基準価格の出所。画面で「開始時の市場情報」「前期の市場実績」を区別するために使う。 */
  readonly basePriceSource: MarketProductBasePriceReference["source"];
}

/** TSV ランキングの1行（従来から公開されている情報）。 */
export interface PlayerTsvRow {
  readonly companyId: CompanyId;
  readonly displayName: string;
  readonly totalShareholderValueUsd: number | null;
  readonly isOwnCompany: boolean;
}

export interface PlayerMarketView {
  /** 公開需要情報が「どのTurnの実績か」。初期情報のときは null。 */
  readonly observedDemandSourceQuarter: number | null;
  /** 観測遅延（四半期）。 */
  readonly observationLagQuarters: number | null;
  readonly cells: readonly PlayerMarketCell[];
  readonly tsvRanking: readonly PlayerTsvRow[];
  /** ベトナム国内原料の前期価格（USD/kg）。 */
  readonly vietnamDomesticPriorPrice: number;
  /**
   * 市場情報の出所を画面へ必ず併記するための文言。
   * 「当期の確定需要ではない」ことを受講者が取り違えないようにする。
   */
  readonly sourceNote: string;
}

export const PLAYER_MARKET_SOURCE_NOTE =
  "ここに出ている需要量は、業界統計として公開されている遅行値です（原則2四半期前の実績であり、当期の確定需要ではありません）。" +
  "価格は前四半期の市場基準価格です。Standard AI も同じ値を見ており、どちらか一方だけが当期の真の需要を見ることはありません。";

/**
 * 受講者向け Market タブのビューを組み立てる。
 *
 * 【trueWorld を読まない】GM 向け MarketSummary が読む dataset.marketMetrics
 * （visibility==="trueWorld"）は使わない。使うのは PublicMarketInfo だけ。
 */
export function buildPlayerMarketView(input: {
  readonly publicInfo: PublicMarketInfo;
  readonly evaluationSnapshots: readonly CompanyEvaluationSnapshot[];
  readonly displayNameByCompanyId: ReadonlyMap<string, string>;
  readonly companyId: CompanyId;
  /**
   * 市場×商品の基準価格。PlayerDecisionContext が既に持っている
   * lastQuarterSalesAllocations（A-8 で Turn 1 の開始時基準価格も入るようにしたもの）
   * をそのまま渡す。ここで価格を計算し直さない。
   */
  readonly basePriceReferences: readonly MarketProductBasePriceReference[] | undefined;
}): PlayerMarketView {
  const { publicInfo, evaluationSnapshots, displayNameByCompanyId, companyId } = input;

  const observed = publicInfo.observedMarketDemand;

  const basePriceByKey = new Map<string, MarketProductBasePriceReference>();
  for (const reference of input.basePriceReferences ?? []) {
    basePriceByKey.set(`${reference.market}|${reference.product}`, reference);
  }

  const cells: PlayerMarketCell[] = [];
  for (const entry of observed?.entries ?? []) {
    for (const product of PRODUCTS) {
      const demand = entry.observedDemandByProduct[product];
      const reference = basePriceByKey.get(`${entry.market}|${product}`);
      cells.push({
        market: entry.market,
        product,
        observedDemandTons: finiteOrNull(demand),
        basePriceUsdPerKg: reference ? finiteOrNull(reference.basePrice) : null,
        basePriceSource: reference?.source,
      });
    }
  }

  const tsvRanking: PlayerTsvRow[] = [...evaluationSnapshots]
    .sort((a, b) => (b.totalShareholderValueUsd ?? -Infinity) - (a.totalShareholderValueUsd ?? -Infinity))
    .map((s) => ({
      companyId: s.companyId,
      displayName: displayNameByCompanyId.get(s.companyId) ?? s.companyId,
      totalShareholderValueUsd: s.totalShareholderValueUsd,
      isOwnCompany: s.companyId === companyId,
    }));

  return {
    observedDemandSourceQuarter: observed?.sourceQuarter ?? null,
    observationLagQuarters: observed?.observationLagQuarters ?? null,
    cells,
    tsvRanking,
    vietnamDomesticPriorPrice: publicInfo.vietnamDomesticPriorPrice,
    sourceNote: PLAYER_MARKET_SOURCE_NOTE,
  };
}
