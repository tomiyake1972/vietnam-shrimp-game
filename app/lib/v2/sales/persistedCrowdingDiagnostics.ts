// ShrimpX V2 — Crowding 診断の永続化 DTO（ENG-CROWDING-MARKDOWN-3 / Persistence v9）
//
// 【なぜ runtime 型と分けるか（§8）】
// CrowdingLayerResult（sales/crowdingLayer.ts）をそのまま保存すると、
// 将来 runtime 専用の field を1つ足しただけで**永続化契約が黙って変わる**。
// Persistence v9 の意味を固定するため、保存対象を明示的な DTO として切り出し、
// 「v9 が保存するのはこの形」とコードで確定させる。
//
// 【保存対象は純粋データのみ】
// ここに現れるのは string / number / boolean と、その配列・オブジェクトだけである。
// 関数・クラスインスタンス・循環参照・branded 値（Usd 等の unwrap が要る型）を含めない
// （JSON 直列化して Redis へ往復できることが条件）。
// CrowdingLayerResult の credibleOffers（会社×市場×商品×納期の明細）は
// bucket 側の companyOffers と重複するため保存しない（payload 肥大を避ける）。

// 【未解決の制約（ENG-CROWDING-MARKDOWN-3 §16）— rolling history】
// Crowding 診断は CompanyQuarterRecord の中にしか存在しない。一方、Simulation Run の
// 保存は容量のため resumePayload.state.history を ROLLING_RESUME_HISTORY_WINDOW（=4）
// Turn ぶんへ間引く（companyLab/simulation/persistence/resume.ts）。
// したがって **保存済み Run から export すると、Crowding 診断は直近ウィンドウの Turn
// しか埋まらない**。live session を渡した export（Management Console 経由）では全 Turn 埋まる。
// これは本実装で解決していない既存の永続化設計上の制約であり、回避策（診断だけを
// 別キーへ全 Turn 保存する等）は保存容量の再設計を伴うため、ここでは行っていない。
// 監査成果物側では、この不足を捏造で埋めず missingDataNotes と README の
// limitation.crowdingHistory に必ず明示する（auditWorkbook/rows.ts・workbook.ts）。

import { PeriodV2 } from "../core/period";
import { DemandMarketId, Product } from "../market/types";
import { CrowdingLayerResult } from "./crowdingLayer";

/** 保存形式のバージョン識別子。形を変えるときは V2 を追加し、これは据え置く。 */
export const PERSISTED_CROWDING_DIAGNOSTICS_VERSION_V1 = "crowdingDiagnostics-v1" as const;

/** 1社が1 bucket へ出した提示（保存形）。 */
export interface PersistedCrowdingCompanyOfferV1 {
  readonly companyId: string;
  readonly desiredOffer: number;
  readonly credibleOffer: number;
  readonly bindingReason: string;
}

/** 1 bucket（市場 × 商品 × 納期）の診断（保存形）。 */
export interface PersistedCrowdingBucketV1 {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly dueDate: PeriodV2;
  readonly preCrowdingStructuralPrice: number;
  readonly forwardDemandProxy: number;
  readonly protectedExternalShare: number;
  readonly protectedExternalDemand: number;
  /** = pricing contestable demand（forwardDemandProxy × (1 − protectedExternalShare)）。 */
  readonly grossCompanyAddressableDemand: number;
  readonly existingCommittedOutstanding: number;
  readonly residualContestableDemand: number;
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
  readonly companyOffers: readonly PersistedCrowdingCompanyOfferV1[];
}

/** CompanyQuarterRecord へ保存する Crowding 診断（保存形）。 */
export interface PersistedCrowdingDiagnosticsV1 {
  readonly diagnosticsVersion: typeof PERSISTED_CROWDING_DIAGNOSTICS_VERSION_V1;
  readonly policyVersion: string;
  readonly enabled: boolean;
  readonly buckets: readonly PersistedCrowdingBucketV1[];
}

/**
 * runtime の CrowdingLayerResult から保存形へ射影する。
 * **新しい計算は一切行わない**（値をそのまま移すだけ）。
 */
export function toPersistedCrowdingDiagnostics(result: CrowdingLayerResult): PersistedCrowdingDiagnosticsV1 {
  return {
    diagnosticsVersion: PERSISTED_CROWDING_DIAGNOSTICS_VERSION_V1,
    policyVersion: result.policyVersion,
    enabled: result.enabled,
    buckets: result.buckets.map((b) => ({
      market: b.market,
      product: b.product,
      dueDate: b.dueDate,
      preCrowdingStructuralPrice: b.preCrowdingStructuralPrice,
      forwardDemandProxy: b.forwardDemandProxy,
      protectedExternalShare: b.protectedExternalShare,
      protectedExternalDemand: b.protectedExternalDemand,
      grossCompanyAddressableDemand: b.grossCompanyAddressableDemand,
      existingCommittedOutstanding: b.existingCommittedOutstanding,
      residualContestableDemand: b.residualContestableDemand,
      totalDesiredOffers: b.totalDesiredOffers,
      totalCredibleOffers: b.totalCredibleOffers,
      crowdingLoad: b.crowdingLoad,
      crowdingRatio: b.crowdingRatio,
      threshold: b.threshold,
      lambda: b.lambda,
      gamma: b.gamma,
      floor: b.floor,
      crowdingMultiplier: b.crowdingMultiplier,
      postCrowdingClearingPrice: b.postCrowdingClearingPrice,
      physicalAtpMethod: b.physicalAtpMethod,
      forwardDemandProxyMethod: b.forwardDemandProxyMethod,
      companyOffers: b.companyOffers.map((o) => ({
        companyId: o.companyId,
        desiredOffer: o.desiredOffer,
        credibleOffer: o.credibleOffer,
        bindingReason: o.bindingReason,
      })),
    })),
  };
}

/** 保存された値が数値として健全か（NaN / Infinity を保存・復元しない）。 */
function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * 永続化された Crowding 診断を検証して返す。
 *
 * 【後方互換】v8 以前のデータにはこのキー自体が無いため、
 * undefined / null は **そのまま undefined** を返す（例外にしない）。
 * これにより v8 saved run は v9 コードでも従来どおり読める。
 */
export function validatePersistedCrowdingDiagnostics(
  raw: unknown,
  fail: (path: string, message: string) => never,
  path: string
): PersistedCrowdingDiagnosticsV1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) fail(path, "オブジェクトである必要があります");
  const obj = raw as Record<string, unknown>;

  if (obj.diagnosticsVersion !== PERSISTED_CROWDING_DIAGNOSTICS_VERSION_V1) {
    fail(
      `${path}.diagnosticsVersion`,
      `未知の診断バージョンです: ${JSON.stringify(obj.diagnosticsVersion)}（期待: ${PERSISTED_CROWDING_DIAGNOSTICS_VERSION_V1}）`
    );
  }
  if (typeof obj.policyVersion !== "string" || obj.policyVersion.length === 0) {
    fail(`${path}.policyVersion`, "空でない文字列である必要があります");
  }
  if (typeof obj.enabled !== "boolean") fail(`${path}.enabled`, "boolean である必要があります");
  if (!Array.isArray(obj.buckets)) fail(`${path}.buckets`, "配列である必要があります");

  const NUMERIC_KEYS = [
    "preCrowdingStructuralPrice",
    "forwardDemandProxy",
    "protectedExternalShare",
    "protectedExternalDemand",
    "grossCompanyAddressableDemand",
    "existingCommittedOutstanding",
    "residualContestableDemand",
    "totalDesiredOffers",
    "totalCredibleOffers",
    "crowdingLoad",
    "crowdingRatio",
    "threshold",
    "lambda",
    "gamma",
    "floor",
    "crowdingMultiplier",
    "postCrowdingClearingPrice",
  ] as const;

  const buckets = (obj.buckets as unknown[]).map((rawBucket, i) => {
    const bp = `${path}.buckets[${i}]`;
    if (typeof rawBucket !== "object" || rawBucket === null) fail(bp, "オブジェクトである必要があります");
    const b = rawBucket as Record<string, unknown>;
    for (const key of ["market", "product", "dueDate", "physicalAtpMethod", "forwardDemandProxyMethod"]) {
      if (typeof b[key] !== "string" || (b[key] as string).length === 0) {
        fail(`${bp}.${key}`, "空でない文字列である必要があります");
      }
    }
    for (const key of NUMERIC_KEYS) {
      if (!isFiniteNumber(b[key])) fail(`${bp}.${key}`, "有限の数値である必要があります");
    }
    if (!Array.isArray(b.companyOffers)) fail(`${bp}.companyOffers`, "配列である必要があります");
    const companyOffers = (b.companyOffers as unknown[]).map((rawOffer, j) => {
      const op = `${bp}.companyOffers[${j}]`;
      if (typeof rawOffer !== "object" || rawOffer === null) fail(op, "オブジェクトである必要があります");
      const o = rawOffer as Record<string, unknown>;
      if (typeof o.companyId !== "string" || o.companyId.length === 0) {
        fail(`${op}.companyId`, "空でない文字列である必要があります");
      }
      if (typeof o.bindingReason !== "string") fail(`${op}.bindingReason`, "文字列である必要があります");
      if (!isFiniteNumber(o.desiredOffer)) fail(`${op}.desiredOffer`, "有限の数値である必要があります");
      if (!isFiniteNumber(o.credibleOffer)) fail(`${op}.credibleOffer`, "有限の数値である必要があります");
      return o as unknown as PersistedCrowdingCompanyOfferV1;
    });
    return { ...b, companyOffers } as unknown as PersistedCrowdingBucketV1;
  });

  return {
    diagnosticsVersion: PERSISTED_CROWDING_DIAGNOSTICS_VERSION_V1,
    policyVersion: obj.policyVersion as string,
    enabled: obj.enabled as boolean,
    buckets,
  };
}
