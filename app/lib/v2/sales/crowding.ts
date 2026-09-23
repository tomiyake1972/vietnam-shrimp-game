// ShrimpX V2 — 市場集中による価格下落（Crowding Markdown, ENG-CROWDING-MARKDOWN-1 Phase 1）
//
// 【このモジュールの責務】
// 同一の 市場 × 商品 × 納期（dueDate）へ複数社が集中した場合に、
//   preCrowdingStructuralPrice → crowdingMultiplier → postCrowdingClearingPrice
// を算出する純粋関数のみを提供する。
//
// 【やらないこと（重要）】
//  - 既存の構造価格計算（market/destinationPricing.ts の deriveMarketReferencePrices、
//    HOSO pricing、PD/VAP structural premium、destination coefficients、
//    manual sales price index、Scenario、consumer inventory、raw material pricing）を
//    一切書き換えない。それらの結果をそのまま preCrowdingStructuralPrice として受け取る。
//  - 既存契約の再価格設定（repricing）は一切行わない。SalesContract.unitPrice は
//    成約時スナップショットであり、後続ターンの Crowding で変化しない。
//  - 会社の priceAdjustmentUsdPerHosoEqKg の意味を変更しない
//    （askPrice = postCrowdingClearingPrice + priceAdjustment の順序のみ）。
//  - 永続化しない。診断は関数の戻り値としてのみ返す
//    （sales/tieredAllocation.ts の TieredAllocationDiagnostics と同じ方針）。
//
// 【同期・非同期の切り分け】
// 本モジュールは「当期の clearing price」を作る same-turn の層である。
// companyLab/marketEvolution.ts の PD/VAP supply-pressure feedback は
// 「前期までの実績 → 当期の市場入力」という翌期 feedback であり、別機構である
// （marketEvolution.ts:5-8, :20-22 の設計契約。当期の契約単価には影響しない）。
// 両者は打ち消し合わない独立チャネルであるため、診断で双方の寄与を分離できるよう
// preCrowdingStructuralPrice（= marketEvolution 適用後の構造価格）と
// crowdingMultiplier を必ず別項目として出力する。

import { PeriodV2 } from "../core/period";
import { DemandMarketId, Product } from "../market/types";
import { CompanyId } from "./types";

/** Crowding policy のバージョン識別子（係数の意味を変えるときは新versionを足す）。 */
export const CROWDING_POLICY_VERSION_V1 = "crowding-markdown-v1" as const;

/**
 * physical ATP の算出方式の識別子。
 * V2.00 Phase 1 は「現時点で確定済みの供給のみ」を使う安全側 proxy であり、
 * 将来の forward ATP model を作る場合は **別version として追加**し、
 * 既存 Run の意味を変えない（ENG-CROWDING-MARKDOWN-1 §physical ATP proxy）。
 */
export const PHYSICAL_ATP_METHOD_V1 = "CURRENT_COMMITTED_SUPPLY_PROXY_V1" as const;

/** forward demand proxy の算出方式の識別子（情報境界の明示。§5）。 */
export const FORWARD_DEMAND_PROXY_METHOD_V1 = "CURRENT_TURN_STRUCTURAL_DEMAND_HOLD_V1" as const;

/** 数量・需要のゼロ判定に使う許容誤差（トン）。 */
export const CROWDING_QUANTITY_EPSILON = 1e-9;

/**
 * grossCompanyAddressableDemand が実質ゼロなのに crowdingLoad が正のときに使う
 * 飽和 ratio。Infinity / NaN を出さないための有限の定数であり、
 * markdown 関数が floor に十分近づく大きさを持つ（§8）。
 */
export const CROWDING_RATIO_SATURATION = 1e6;

/** markdown 関数の係数（商品別・必要最小限の市場 override 可）。 */
export interface CrowdingMarkdownCoefficients {
  /** この ratio 以下では既存価格を維持する（multiplier = 1）。 */
  readonly threshold: number;
  /** 減衰の強さ。0 なら multiplier は常に 1。 */
  readonly lambda: number;
  /** 超過分の非線形性。1 で指数減衰。 */
  readonly gamma: number;
  /** multiplier の下限（0 < floor <= 1）。 */
  readonly floor: number;
}

/**
 * Crowding の適用方針。**正式係数はこのモジュールで確定しない**
 * （ENG-CROWDING-MARKDOWN-1 §9: 正式係数は感応度試験後に #04/#08 が決める）。
 * ここで提供する既定値は「現行挙動と完全同一になる中立値」だけである。
 */
export interface CrowdingPolicy {
  readonly policyVersion: string;
  /** false のとき Crowding 層は一切動かず、既存結果はビット単位で不変。 */
  readonly enabled: boolean;
  /** 商品別係数。HOSO/PD/VAP で同一係数を前提にしない。 */
  readonly byProduct: Readonly<Record<Product, CrowdingMarkdownCoefficients>>;
  /** 必要最小限の市場 override（指定が無い市場・商品は byProduct を使う）。 */
  readonly marketOverrides?: Readonly<
    Partial<Record<DemandMarketId, Partial<Record<Product, CrowdingMarkdownCoefficients>>>>
  >;
  /**
   * 保護される外部需要の割合（0〜1）。ゲームに登場しない他Vietnam企業および
   * 購買見送りのうち、5社が争えない部分。
   * **正式数値はこの branch で恣意的に確定しない**（感応度用 parameter として集約する）。
   */
  readonly protectedExternalShare: Readonly<Record<Product, number>>;
  /** physical ATP の算出方式（診断へそのまま出す）。 */
  readonly physicalAtpMethod: string;
  /** forward demand proxy の算出方式（診断へそのまま出す）。 */
  readonly forwardDemandProxyMethod: string;
}

/** multiplier が恒等的に 1 になる中立係数。 */
export const NEUTRAL_CROWDING_COEFFICIENTS: CrowdingMarkdownCoefficients = {
  threshold: 0,
  lambda: 0,
  gamma: 1,
  floor: 1,
};

/**
 * 既定 policy。**enabled=false かつ全係数が中立**であり、
 * これを使う限り postCrowdingClearingPrice は preCrowdingStructuralPrice と
 * 厳密に同一の数値になる（CRWD-14）。
 */
export const NEUTRAL_CROWDING_POLICY: CrowdingPolicy = {
  policyVersion: CROWDING_POLICY_VERSION_V1,
  enabled: false,
  byProduct: {
    hoso: NEUTRAL_CROWDING_COEFFICIENTS,
    pd: NEUTRAL_CROWDING_COEFFICIENTS,
    vap: NEUTRAL_CROWDING_COEFFICIENTS,
  },
  protectedExternalShare: { hoso: 0, pd: 0, vap: 0 },
  physicalAtpMethod: PHYSICAL_ATP_METHOD_V1,
  forwardDemandProxyMethod: FORWARD_DEMAND_PROXY_METHOD_V1,
};

/** 市場 override を解決して、この 市場 × 商品 に効く係数を返す。 */
export function resolveCrowdingCoefficients(
  policy: CrowdingPolicy,
  market: DemandMarketId,
  product: Product
): CrowdingMarkdownCoefficients {
  return policy.marketOverrides?.[market]?.[product] ?? policy.byProduct[product];
}

/**
 * markdown 関数（smooth exponential floor）。
 *
 *   x = max(0, crowdingRatio - threshold)
 *   multiplier = floor + (1 - floor) * exp(-lambda * x^gamma)
 *
 * 性質（CRWD-1〜4 が固定する）:
 *  - ratio について単調非増加
 *  - threshold 以下では厳密に 1（連続。threshold 境界に jump が無い）
 *  - floor 未満にならない
 *  - NaN / 負値を出さない
 *  - 同一入力に対して決定論的
 */
export function crowdingMultiplier(crowdingRatio: number, c: CrowdingMarkdownCoefficients): number {
  if (!Number.isFinite(crowdingRatio) || crowdingRatio < 0) {
    throw new Error(`crowdingRatio は 0 以上の有限値である必要があります: ${crowdingRatio}`);
  }
  if (!(c.floor > 0 && c.floor <= 1)) {
    throw new Error(`floor は 0 < floor <= 1 である必要があります: ${c.floor}`);
  }
  if (!(c.lambda >= 0) || !Number.isFinite(c.lambda)) {
    throw new Error(`lambda は 0 以上の有限値である必要があります: ${c.lambda}`);
  }
  if (!(c.gamma > 0) || !Number.isFinite(c.gamma)) {
    throw new Error(`gamma は正の有限値である必要があります: ${c.gamma}`);
  }
  if (!Number.isFinite(c.threshold) || c.threshold < 0) {
    throw new Error(`threshold は 0 以上の有限値である必要があります: ${c.threshold}`);
  }

  const x = Math.max(0, crowdingRatio - c.threshold);
  if (x === 0) return 1;
  // x^gamma は x>0 かつ gamma>0 でのみ評価する（0^0 等の不定形を作らない）。
  const decay = Math.exp(-c.lambda * Math.pow(x, c.gamma));
  const multiplier = c.floor + (1 - c.floor) * decay;
  // 数値誤差で floor をわずかに割る/1 をわずかに超えることを構造的に防ぐ。
  return Math.min(1, Math.max(c.floor, multiplier));
}

/**
 * crowdingRatio = crowdingLoad / grossCompanyAddressableDemand。
 * 需要が実質ゼロのときの挙動を明示的に定義し、Infinity / NaN を出さない（§8）。
 */
export function crowdingRatioOf(crowdingLoad: number, grossCompanyAddressableDemand: number): number {
  if (!Number.isFinite(crowdingLoad) || crowdingLoad < 0) {
    throw new Error(`crowdingLoad は 0 以上の有限値である必要があります: ${crowdingLoad}`);
  }
  if (!Number.isFinite(grossCompanyAddressableDemand) || grossCompanyAddressableDemand < 0) {
    throw new Error(
      `grossCompanyAddressableDemand は 0 以上の有限値である必要があります: ${grossCompanyAddressableDemand}`
    );
  }
  if (grossCompanyAddressableDemand <= CROWDING_QUANTITY_EPSILON) {
    // 需要が無いのに提示も無い → 混雑していない（0）。
    // 需要が無いのに提示がある → 最大混雑として有限の飽和値を返す。
    return crowdingLoad <= CROWDING_QUANTITY_EPSILON ? 0 : CROWDING_RATIO_SATURATION;
  }
  return crowdingLoad / grossCompanyAddressableDemand;
}

// ---------------------------------------------------------------------
// bucket（市場 × 商品 × 納期）
// ---------------------------------------------------------------------

/** Crowding の単位。同じ市場・商品でも dueDate が違えば別 bucket（§3）。 */
export interface CrowdingBucketKey {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly dueDate: PeriodV2;
}

/** bucket の決定論的なキー文字列。 */
export function crowdingBucketKey(market: DemandMarketId, product: Product, dueDate: PeriodV2): string {
  return `${market}::${product}::${dueDate}`;
}

/** 1社が 1 bucket へ出した提示の診断。 */
export interface CrowdingCompanyOfferDiagnostics {
  readonly companyId: CompanyId;
  /** 営業工数適用後の希望提示量（Crowding の分子にはそのまま使わない）。 */
  readonly desiredOffer: number;
  /** physical ATP / 商業枠を適用した後の信頼可能提示量。 */
  readonly credibleOffer: number;
  /** credibleOffer を決めた拘束要因。 */
  readonly bindingReason: string;
}

/** 1 bucket 分の Crowding 診断（§15 の必須項目を漏れなく持つ）。 */
export interface CrowdingBucketDiagnostics {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly dueDate: PeriodV2;
  readonly preCrowdingStructuralPrice: number;
  readonly forwardDemandProxy: number;
  readonly protectedExternalShare: number;
  readonly protectedExternalDemand: number;
  readonly grossCompanyAddressableDemand: number;
  readonly existingCommittedOutstanding: number;
  readonly residualContestableDemand: number;
  readonly companyOffers: readonly CrowdingCompanyOfferDiagnostics[];
  readonly totalDesiredOffers: number;
  readonly totalCredibleOffers: number;
  readonly crowdingLoad: number;
  readonly crowdingRatio: number;
  readonly threshold: number;
  readonly lambda: number;
  readonly gamma: number;
  readonly floor: number;
  readonly crowdingMultiplier: number;
  readonly postCrowdingClearingPrice: number;
  readonly physicalAtpMethod: string;
  readonly forwardDemandProxyMethod: string;
  /** forward demand proxy の限界（§5 で診断へ記録することが要求されている）。 */
  readonly forwardDemandProxyLimitations: readonly string[];
}

/**
 * 1 bucket 分の Crowding を計算する。
 *
 * 【重要】分母（grossCompanyAddressableDemand）は **当期の会社競争力から
 * 逆算しない**。marketEvolution.computeAddressableDemand() は会社の
 * competitiveness weights を入力に持つため clearing price との循環を作りうるので、
 * same-turn の分母へは流用しない（§4）。ここでは呼び出し側が渡す
 * forwardDemandProxy（構造需要）と、versioned な protectedExternalShare だけを使う。
 */
export function computeCrowdingBucket(args: {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly dueDate: PeriodV2;
  readonly preCrowdingStructuralPrice: number;
  readonly forwardDemandProxy: number;
  readonly existingCommittedOutstanding: number;
  readonly offers: readonly CrowdingCompanyOfferDiagnostics[];
  readonly policy: CrowdingPolicy;
  readonly forwardDemandProxyLimitations: readonly string[];
}): CrowdingBucketDiagnostics {
  const { market, product, dueDate, preCrowdingStructuralPrice, forwardDemandProxy, policy } = args;

  const protectedExternalShare = policy.protectedExternalShare[product];
  if (!Number.isFinite(protectedExternalShare) || protectedExternalShare < 0 || protectedExternalShare >= 1) {
    throw new Error(`protectedExternalShare は 0 <= share < 1 である必要があります: ${protectedExternalShare}`);
  }
  const grossDemand = Math.max(0, forwardDemandProxy);
  const protectedExternalDemand = grossDemand * protectedExternalShare;
  const grossCompanyAddressableDemand = Math.max(0, grossDemand - protectedExternalDemand);

  const existingCommittedOutstanding = Math.max(0, args.existingCommittedOutstanding);
  // 既存 commitment は「残余需要」の計算でのみ需要を減らす。
  // crowdingLoad 側へも同額を足すが、これは需要を二重に控除しているのではなく、
  // 「その納期に既に積み上がっている負荷」を分子へ入れているだけである（§6）。
  const residualContestableDemand = Math.max(0, grossCompanyAddressableDemand - existingCommittedOutstanding);

  const totalDesiredOffers = args.offers.reduce((s, o) => s + o.desiredOffer, 0);
  const totalCredibleOffers = args.offers.reduce((s, o) => s + o.credibleOffer, 0);
  const crowdingLoad = existingCommittedOutstanding + totalCredibleOffers;
  const crowdingRatio = crowdingRatioOf(crowdingLoad, grossCompanyAddressableDemand);

  const c = resolveCrowdingCoefficients(policy, market, product);
  const multiplier = policy.enabled ? crowdingMultiplier(crowdingRatio, c) : 1;
  const postCrowdingClearingPrice = preCrowdingStructuralPrice * multiplier;

  return {
    market,
    product,
    dueDate,
    preCrowdingStructuralPrice,
    forwardDemandProxy: grossDemand,
    protectedExternalShare,
    protectedExternalDemand,
    grossCompanyAddressableDemand,
    existingCommittedOutstanding,
    residualContestableDemand,
    companyOffers: args.offers,
    totalDesiredOffers,
    totalCredibleOffers,
    crowdingLoad,
    crowdingRatio,
    threshold: c.threshold,
    lambda: c.lambda,
    gamma: c.gamma,
    floor: c.floor,
    crowdingMultiplier: multiplier,
    postCrowdingClearingPrice,
    physicalAtpMethod: policy.physicalAtpMethod,
    forwardDemandProxyMethod: policy.forwardDemandProxyMethod,
    forwardDemandProxyLimitations: args.forwardDemandProxyLimitations,
  };
}
