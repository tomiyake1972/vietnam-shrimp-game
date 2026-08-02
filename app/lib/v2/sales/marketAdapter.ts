// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール Phase3市場結果アダプター（Phase 4）
//
// Phase3の市場・価格形成モジュール（app/lib/v2/market）の出力
// MarketQuarterResult・入力 MarketQuarterInput を読み取るだけの純粋関数のみを
// 提供する。価格・需給の計算式は一切変更・再実装しない
// （実装指示「国際基準価格そのものは変更しない」に対応）。
//
// 本モジュールが実装する5社は全員ベトナムの輸出会社という前提（ゲーム設定）
// のため、基準価格は常にベトナム（VN）のHOSO FOB価格＋PD/VAPプレミアムを使う。
//
// --- 対象需要（targetDemand）の導出について（Phase4固有の暫定前提・要校正） ---
// MarketQuarterResult は「商品区分（hoso/pd/vap）ごとの世界全体需要」は持つが、
// 「市場（CN/US/EU/JP/OTHER）ごとの当期需要」も「うちベトナム産がどれだけ
// 獲得できるか」も直接は持たない（市場別の需要内訳はPhase1の入力側
// MarketQuarterInput.demandMarkets[*].priorPeriodConsumptionにのみ存在し、
// 当期の需要成長式はPhase1内部で計算されるため、Phase4側では再計算しない）。
// 本アダプターは、成約配分の上限として必要な「市場×商品区分×ベトナム産」の
// 対象需要を、既存フィールドのみから次の3段階で機械的に按分する。新しい
// 価格・需給の経済ロジックは一切追加していない（既存の集計値を比率で
// 分配しているだけ）。
//   (a) ベトナムが世界需要のうち実際に獲得した数量 =
//       marketResult.hosoPrices.VN.allocatedDemand （Phase1がすでに計算済み）
//   (b) (a)を商品区分（hoso/pd/vap）へ、世界全体の商品構成比
//       （worldDemandに対するhoso/pd/vapそれぞれの世界需要の比率）で按分する
//       （ベトナムの商品構成が世界平均と同じという簡略化）。
//   (c) (b)の各商品区分ぶんを、5市場（CN/US/EU/JP/OTHER）へ、各市場の
//       priorPeriodConsumption（前期消費量、MarketQuarterInputの生値）の
//       構成比で按分する（商品区分によらず市場ごとの相対的な大きさの比率は
//       同じという簡略化。当期の需要成長式は再計算せず、前期実績という
//       生の入力値だけを相対ウェイトとして使う）。
// これはPhase4固有の暫定前提であり、Phase3のassumptions.tsと同じ位置づけで
// ここに集約する。将来、Phase1側に市場別・商品別の需要分解が実装されたら、
// このアダプターだけを置き換えればよい。

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, unwrapUnit } from "../core/units";
import { COUNTRY_IDS, DEMAND_MARKET_IDS, DemandMarketId, MarketQuarterInput, MarketQuarterResult, Product } from "../market/types";
import { deriveMarketReferencePrices } from "../market/destinationPricing";
import {
  CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS,
  DestinationMarketPriceCoefficientTable,
} from "../market/destinationPricingParameters";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/**
 * ベトナム（5社の共通産地）の商品区分ごとの基準価格。Phase3のプレミアムを含む。
 * 【Phase 8P-0A】この関数自体は変更していない（市場非依存・商品別のみの
 * 基準価格を返す既存の意味を維持する。既存テスト
 * sales/__tests__/marketAdapter.test.ts が検証）。成約配分の実際の基準価格には
 * 代わりに deriveVietnamMarketReferencePrices（仕向市場別）を使う。
 */
export function deriveVietnamBasePrices(marketResult: MarketQuarterResult): Readonly<Record<Product, UsdPerHosoEqKg>> {
  return {
    hoso: marketResult.hosoPrices.VN.price,
    pd: marketResult.pdPremium.byCountry.VN.finalPrice,
    vap: marketResult.vapPremium.byCountry.VN.finalPrice,
  };
}

/**
 * 【Phase 8P-0A】ベトナム（5社の共通産地）の商品×仕向市場ごとの参照価格。
 * market/destinationPricing.ts の価格分解・係数適用をそのまま呼び出すだけの
 * アダプター（新しい価格形成ロジックはここには実装しない）。
 * coefficients省略時は CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
 * （現行運用中の係数セット）を使う。
 */
export function deriveVietnamMarketReferencePrices(
  marketResult: MarketQuarterResult,
  coefficients: DestinationMarketPriceCoefficientTable = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
): Readonly<Record<DemandMarketId, Readonly<Record<Product, UsdPerHosoEqKg>>>> {
  return deriveMarketReferencePrices(marketResult, coefficients);
}

/**
 * 【加工品市場進化 §d】ベトナムの加工優位を獲得需要の商品構成へ反映するための設定。
 *
 * 【解決する問題（監査§4）】従来、ベトナムが獲得する需要の商品構成は
 * 「世界平均の商品構成比と同じ」という Phase4 の明示的な簡略化のままだった。
 * このため「ベトナムは加工能力があるからPD/VAP需要をより多く獲れる」という
 * 物語の起点が、コードのどこにも存在しなかった。
 *
 * 【原料シェアと加工品シェアの分離（実装指示の必須要件）】
 *  - 原料シェア: marketResult.hosoPrices.VN.allocatedDemand ÷ 世界需要。
 *    これは HOSO 価格の相対競争力で決まる既存の量であり、**一切変更しない**。
 *  - 加工品シェア: VNのPD(VAP)加工能力 ÷ 世界のPD(VAP)加工能力。
 *    エクアドル・インドが原料をより多く供給していても、加工能力が小さければ
 *    加工品需要は獲れない、という構造をここで初めて表現する。
 *
 * 【総量保存】ベトナムの獲得需要の**合計は変えない**（構成比だけを傾ける）。
 * 総量まで増やすと、HOSO市場清算で決まった原産地シェアと二重計上になる。
 *
 * 【「ベトナムだから儲かる」にしないこと（実装指示の強い要求）】
 * ここで動くのは 5社が **獲得を狙える上限（対象需要）** だけである。
 * 実際に成約・生産・入金へ変換するには、既存の各段で個社が要件を満たす必要がある:
 *   - sales/allocation.ts: 個社成約上限 = min(販売希望量, 営業処理能力,
 *     対象需要×最大供給者シェア, 承認済み取引枠) かつ競争力ウェイト
 *     （価格・カバレッジ・関係性・品質・納期・VAP能力）での水位法配分
 *   - production/*: 生産計画は原料在庫・工場能力・Worker能力に拘束される
 *   - financing/finance: 現金・借入余力の制約
 * したがって、原料も設備もWorkerも営業力も無い会社にとって、この上限拡大は
 * 何の利益ももたらさない（テスト DCA-5 が実証する）。
 */
export interface ProcessingAdvantageOptions {
  /**
   * 加工優位の効き具合の指数。0 = 完全に無効（世界平均構成比＝従来挙動）、
   * 1 = 加工能力シェア比をそのまま構成比の傾きに使う。
   * 【初期値0.6・要校正】加工能力が需要獲得へ直結しすぎないよう1未満にする
   * （加工能力があっても営業・品質が無ければ売れない、という後段の制約と
   * 役割を分担させるため）。
   */
  readonly advantageExponent: number;
  /** 傾き倍率の下限・上限（暴走防止）。1.0が中立。 */
  readonly tiltFloor: number;
  readonly tiltCap: number;
}

/** 【加工品市場進化 v1 初期値・要校正】 */
export const PROCESSING_ADVANTAGE_OPTIONS_V1: ProcessingAdvantageOptions = {
  advantageExponent: 0.6,
  tiltFloor: 0.5,
  tiltCap: 2.5,
};

/** 加工優位の適用内訳（説明可能性のための診断構造）。 */
export interface ProcessingAdvantageBreakdown {
  /** 原料（HOSO換算の総需要）に対するベトナムのシェア。既存の価格競争由来。 */
  readonly rawShare: number;
  /** ベトナムのPD加工能力シェア（世界のPD加工能力に対する比）。 */
  readonly pdProcessingShare: number;
  /** ベトナムのVAP加工能力シェア。 */
  readonly vapProcessingShare: number;
  /** PD構成比へ掛けた傾き倍率（1.0が中立＝世界平均構成比のまま）。 */
  readonly pdTilt: number;
  /** VAP構成比へ掛けた傾き倍率。 */
  readonly vapTilt: number;
  /** 正規化前の重み合計（総量保存のための除数）。 */
  readonly normalizationDivisor: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * ベトナムの商品区分別・獲得需要。
 *
 * processingAdvantage を渡さない場合は従来どおり「世界平均の商品構成比で按分」
 * （＝既存挙動とビット単位で一致）。渡した場合は、加工能力シェア ÷ 原料シェア
 * の比を傾きとして構成比を歪めたうえで、合計が元の獲得需要と一致するよう
 * 正規化する（総量保存）。
 */
function deriveVietnamDemandByProduct(
  marketResult: MarketQuarterResult,
  marketInput?: MarketQuarterInput,
  processingAdvantage?: ProcessingAdvantageOptions
): { readonly byProduct: Readonly<Record<Product, number>>; readonly breakdown?: ProcessingAdvantageBreakdown } {
  const vietnamAllocatedDemand = unwrapUnit(marketResult.hosoPrices.VN.allocatedDemand);
  const worldDemand = unwrapUnit(marketResult.worldDemand);
  const globalPdDemand = unwrapUnit(marketResult.pdPremium.globalDemand);
  const globalVapDemand = unwrapUnit(marketResult.vapPremium.globalDemand);
  // "hoso"（未加工のまま販売される分）= 世界需要 - PD需要 - VAP需要。
  const globalHosoDemand = Math.max(0, worldDemand - globalPdDemand - globalVapDemand);

  if (worldDemand <= 0) {
    return { byProduct: { hoso: 0, pd: 0, vap: 0 } };
  }

  const worldMix: Record<Product, number> = {
    hoso: globalHosoDemand / worldDemand,
    pd: globalPdDemand / worldDemand,
    vap: globalVapDemand / worldDemand,
  };

  if (!processingAdvantage || !marketInput || processingAdvantage.advantageExponent <= 0) {
    return {
      byProduct: {
        hoso: vietnamAllocatedDemand * worldMix.hoso,
        pd: vietnamAllocatedDemand * worldMix.pd,
        vap: vietnamAllocatedDemand * worldMix.vap,
      },
    };
  }

  const rawShare = vietnamAllocatedDemand / worldDemand;
  const worldPdCapacity = COUNTRY_IDS.reduce((sum, c) => sum + unwrapUnit(marketInput.countries[c].pdProcessingCapacity), 0);
  const worldVapCapacity = COUNTRY_IDS.reduce((sum, c) => sum + unwrapUnit(marketInput.countries[c].vapProcessingCapacity), 0);
  const pdProcessingShare = worldPdCapacity > 0 ? unwrapUnit(marketInput.countries.VN.pdProcessingCapacity) / worldPdCapacity : rawShare;
  const vapProcessingShare = worldVapCapacity > 0 ? unwrapUnit(marketInput.countries.VN.vapProcessingCapacity) / worldVapCapacity : rawShare;

  const tiltOf = (processingShare: number): number => {
    if (rawShare <= 0) return 1;
    const ratio = processingShare / rawShare;
    if (!Number.isFinite(ratio) || ratio <= 0) return 1;
    return clamp(Math.pow(ratio, processingAdvantage.advantageExponent), processingAdvantage.tiltFloor, processingAdvantage.tiltCap);
  };

  const pdTilt = tiltOf(pdProcessingShare);
  const vapTilt = tiltOf(vapProcessingShare);

  // 重み（HOSOは中立=1.0の傾き）。合計で割って正規化することで総量を保存する。
  const weightHoso = worldMix.hoso;
  const weightPd = worldMix.pd * pdTilt;
  const weightVap = worldMix.vap * vapTilt;
  const divisor = weightHoso + weightPd + weightVap;
  if (!(divisor > 0)) {
    return {
      byProduct: {
        hoso: vietnamAllocatedDemand * worldMix.hoso,
        pd: vietnamAllocatedDemand * worldMix.pd,
        vap: vietnamAllocatedDemand * worldMix.vap,
      },
    };
  }

  return {
    byProduct: {
      hoso: (vietnamAllocatedDemand * weightHoso) / divisor,
      pd: (vietnamAllocatedDemand * weightPd) / divisor,
      vap: (vietnamAllocatedDemand * weightVap) / divisor,
    },
    breakdown: { rawShare, pdProcessingShare, vapProcessingShare, pdTilt, vapTilt, normalizationDivisor: divisor },
  };
}

/**
 * 加工優位の適用内訳だけを取り出す診断用ヘルパー（Excel/CSV出力・レポート向け）。
 * 需要そのものの計算は deriveTargetDemand と同一の関数を通るため、値が食い違うことはない。
 */
export function describeProcessingAdvantage(
  marketResult: MarketQuarterResult,
  marketInput: MarketQuarterInput,
  processingAdvantage: ProcessingAdvantageOptions = PROCESSING_ADVANTAGE_OPTIONS_V1
): ProcessingAdvantageBreakdown | undefined {
  return deriveVietnamDemandByProduct(marketResult, marketInput, processingAdvantage).breakdown;
}

/**
 * 市場×商品区分ごとの対象需要（ベトナム産がこの四半期に獲得できる上限の目安）。
 * 5社の成約配分（allocateMarketProduct）の需要上限として使う。
 *
 * 【Phase 8F-1】市場別の按分ウェイトは、従来は各市場の生の
 * priorPeriodConsumption（前期消費量、静的な構成比）のみで決めていたが、
 * これは「消費」と「購買」を混同したまま需要を按分していた箇所であり、
 * 監査結果で二重計上リスクとして特定された唯一の置き換え対象である
 * （market/consumerInventory.ts のヘッダコメント参照）。
 * `marketWeights` を渡すと、market/consumerInventory.ts の
 * deriveMarketWeightsFromDesiredPurchase が算出した「希望購買量ベースの
 * 市場別構成比」で按分する（消費だけでなく在庫水準・当期価格を反映した
 * ウェイト）。省略時は既存の priorPeriodConsumption ベースの按分を維持し、
 * 後方互換を保つ（Phase 8F-1配線前の呼び出し元・既存テストへ影響しない）。
 */
export function deriveTargetDemand(
  marketResult: MarketQuarterResult,
  marketInput: MarketQuarterInput,
  marketWeights?: Readonly<Record<DemandMarketId, number>>,
  /**
   * 【SAI-5C】市場×商品の需要構成比行列（market/productLifecycle.ts の
   * computeMarketProductMix。各市場の行和=1）。指定時は、従来の
   * 「世界一律の商品構成比 × 市場ウェイト」（分離形。全市場が同じ商品構成に
   * なる簡略化＝上記(b)(c)）を「市場ウェイト × 市場別の商品構成比」（結合形）
   * へ置き換える。どちらの形でも全セルの合計はベトナム獲得需要の総量に一致する
   * （総需要保存。分離形はΣ_p世界構成比=1、結合形はΣ_p行和=1のため）。
   * 省略時は完全に従来の計算（後方互換・ビット単位一致）。
   */
  marketProductMix?: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>,
  /**
   * 【加工品市場進化 §d】ベトナムの加工優位を獲得需要の商品構成へ反映する設定。
   * 省略時は完全に従来の計算（世界平均構成比での按分。ビット単位一致）。
   */
  processingAdvantage?: ProcessingAdvantageOptions
): Readonly<Record<DemandMarketId, Readonly<Record<Product, HosoEqTons>>>> {
  const advantage = deriveVietnamDemandByProduct(marketResult, marketInput, processingAdvantage);
  const vietnamDemandByProduct = advantage.byProduct;

  const totalPriorConsumption = DEMAND_MARKET_IDS.reduce(
    (sum, m) => sum + unwrapUnit(marketInput.demandMarkets[m].priorPeriodConsumption),
    0
  );

  const vietnamAllocatedDemandTotal = marketProductMix
    ? PRODUCTS.reduce((sum, p) => sum + vietnamDemandByProduct[p], 0)
    : 0;

  /**
   * 【加工品市場進化 §d・重要】marketProductMix（SAI-5Cの結合形）を使う場合、
   * 商品別の内訳は市場別構成比行列だけで決まり、vietnamDemandByProduct は
   * **合計値としてしか使われない**。したがって加工優位の傾きをここで再度
   * 適用しないと、ライフサイクル有効時に §d の効果が丸ごと消えてしまう。
   *
   * 各市場の行（構成比、行和=1）へ同じ商品別傾きを掛けて行ごとに再正規化する。
   * 行和=1が保たれるため、市場合計・全体合計はどちらも変わらない（総量保存）。
   */
  const tiltedMix = marketProductMix && advantage.breakdown ? tiltMarketProductMix(marketProductMix, advantage.breakdown) : marketProductMix;

  const result = {} as Record<DemandMarketId, Record<Product, HosoEqTons>>;
  for (const market of DEMAND_MARKET_IDS) {
    const marketShare = marketWeights
      ? marketWeights[market]
      : totalPriorConsumption > 0
      ? unwrapUnit(marketInput.demandMarkets[market].priorPeriodConsumption) / totalPriorConsumption
      : 1 / DEMAND_MARKET_IDS.length;
    const perProduct = {} as Record<Product, HosoEqTons>;
    for (const product of PRODUCTS) {
      const cell = tiltedMix
        ? vietnamAllocatedDemandTotal * marketShare * tiltedMix[market][product]
        : vietnamDemandByProduct[product] * marketShare;
      perProduct[product] = hosoEqTons(Math.max(0, cell));
    }
    result[market] = perProduct;
  }
  return result;
}

/**
 * 市場×商品構成比行列の各行へ、ベトナムの加工優位の傾き（PD/VAP）を掛けて
 * 行ごとに再正規化する（行和=1を維持＝市場ごとの総需要は不変）。
 */
function tiltMarketProductMix(
  mix: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>,
  breakdown: ProcessingAdvantageBreakdown
): Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>> {
  const tiltByProduct: Readonly<Record<Product, number>> = { hoso: 1, pd: breakdown.pdTilt, vap: breakdown.vapTilt };
  const result = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const market of DEMAND_MARKET_IDS) {
    const weighted = {} as Record<Product, number>;
    let divisor = 0;
    for (const product of PRODUCTS) {
      const w = Math.max(0, mix[market][product]) * tiltByProduct[product];
      weighted[product] = w;
      divisor += w;
    }
    const row = {} as Record<Product, number>;
    for (const product of PRODUCTS) {
      row[product] = divisor > 0 ? weighted[product] / divisor : mix[market][product];
    }
    result[market] = row;
  }
  return result;
}
