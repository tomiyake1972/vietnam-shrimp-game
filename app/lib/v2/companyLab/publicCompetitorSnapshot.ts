// ShrimpX V2 — 公開競合情報スナップショット（PUBLIC-COMPETITOR-1）
//
// 【このモジュールが存在する理由】
//   正規の画面で見える競合情報が TSV ランキングと市場全体の需要・価格しか無く、
//   「どこに誰が力を入れているか」が分からなかった。販売モデルが「同じ市場に
//   集中すると価格が下がる」（crowding）仕組みである以上、競合の集中先が
//   大まかに分かることは戦略判断の前提になる。
//
// 【公開してよい情報の原則】
//   1. 出すのは **前四半期の確定結果だけ**。当期の他社の入力は一切出さない。
//   2. 粒度は帯（首位級・大・中・小・なし）や10人単位の概数へ丸める。
//      他社の正確なトン数・価格・利益・原価・市場別配置は出さない。
//   3. 自社の行だけは正確なシェアも併記する（自分の実績は本来わかっている情報で
//      あり、帯だけにすると自社の位置を誤認したまま他社と比べることになる）。
//   4. 値が取得できないときは 0 で埋めず「取得不能」を表す null を返す。
//
// 【決定論】入力（確定記録）が同じなら出力も必ず同じ。乱数を使わない。
//   同じ Run を再表示・リプレイしても帯とニュースが変わらないことを担保する。
//
// 【このモジュールがやらないこと】
//   - 経済計算をしない。確定記録の値を数えて丸めるだけ。
//   - 混雑度を自前で定義し直さない。エンジンの crowding 診断値をそのまま使い、
//     診断が無いターン（crowding 無効の販売モデル）は null にする。

import { CompanyId } from "../sales/types";
import { DemandMarketId, Product } from "../market/types";
import { SalesContract } from "../sales/types";
import { CompanyQuarterRecord } from "./types";
import { CapitalProjectType } from "../capex/types";
import { CapexProjectTemplate } from "../capex/parameters";
import { unwrapUnit } from "../core/units";

export const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

// ---------------------------------------------------------------------
// 1. シェア帯
// ---------------------------------------------------------------------

/**
 * シェア帯。5社均等は 20% であり、「中」（10〜25%）の内側に収まる。
 * 均等点が帯の境界に乗らないため、平均より上か下かを判別しやすい。
 */
export type ShareBand = "leader" | "large" | "medium" | "small" | "none";

export const SHARE_BAND_THRESHOLDS = {
  /** 40% 以上 = 首位級。5社均等（20%）のちょうど2倍。 */
  leader: 0.4,
  /** 25% 以上 = 大。 */
  large: 0.25,
  /** 10% 以上 = 中。 */
  medium: 0.1,
} as const;

export const SHARE_BAND_LABEL: Readonly<Record<ShareBand, string>> = {
  leader: "首位級",
  large: "大",
  medium: "中",
  small: "小",
  none: "なし",
};

/** 帯の強さ順（差分の↑↓判定に使う）。 */
const SHARE_BAND_RANK: Readonly<Record<ShareBand, number>> = { none: 0, small: 1, medium: 2, large: 3, leader: 4 };

export function classifyShareBand(share: number): ShareBand {
  if (!Number.isFinite(share) || share <= 0) return "none";
  if (share >= SHARE_BAND_THRESHOLDS.leader) return "leader";
  if (share >= SHARE_BAND_THRESHOLDS.large) return "large";
  if (share >= SHARE_BAND_THRESHOLDS.medium) return "medium";
  return "small";
}

/** 帯の変化。前四半期の帯が無ければ "flat" とせず null（捏造しない）。 */
export type ShareBandTrend = "up" | "down" | "flat";

export function compareShareBand(current: ShareBand, previous: ShareBand | null): ShareBandTrend | null {
  if (previous === null) return null;
  const diff = SHARE_BAND_RANK[current] - SHARE_BAND_RANK[previous];
  return diff > 0 ? "up" : diff < 0 ? "down" : "flat";
}

// ---------------------------------------------------------------------
// 2. 混雑度
// ---------------------------------------------------------------------

/** 混雑度の3段階。エンジンの crowding ratio をそのまま帯にしたもの。 */
export type CrowdingBand = "loose" | "normal" | "tight";

export const CROWDING_BAND_THRESHOLDS = {
  /** この比率未満なら「余裕」。 */
  loose: 0.8,
  /** この比率以上なら「混雑」。 */
  tight: 1.1,
} as const;

export const CROWDING_BAND_LABEL: Readonly<Record<CrowdingBand, string>> = {
  loose: "余裕",
  normal: "普通",
  tight: "混雑",
};

export function classifyCrowdingBand(ratio: number): CrowdingBand {
  if (ratio >= CROWDING_BAND_THRESHOLDS.tight) return "tight";
  if (ratio < CROWDING_BAND_THRESHOLDS.loose) return "loose";
  return "normal";
}

// ---------------------------------------------------------------------
// 3. スナップショットの型
// ---------------------------------------------------------------------

/** 1社ぶんの、1マス（市場×商品）における見え方。 */
export interface CompetitorShareEntry {
  readonly companyId: CompanyId;
  readonly band: ShareBand;
  /** 前四半期の帯との比較。前四半期が無ければ null。 */
  readonly trend: ShareBandTrend | null;
  /**
   * 正確なシェア（0〜1）。**自社の行にだけ設定される**。
   * 他社の行では必ず undefined であり、DTO にも現れない。
   */
  readonly exactShare?: number;
}

export interface CompetitorMarketCell {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly shares: readonly CompetitorShareEntry[];
  /**
   * 混雑度。エンジンの crowding 診断がある四半期のみ。
   * crowding 無効の販売モデルでは null（自前の代理指標を作らない）。
   */
  readonly crowding: CrowdingBand | null;
}

/** 営業人員の公開値（10人単位の概数）。 */
export interface CompetitorSalesForceEntry {
  readonly companyId: CompanyId;
  /** 10人単位に四捨五入した概数。 */
  readonly approximateHeadcount: number;
  /** 前四半期比（10人単位）。前四半期が無ければ null。 */
  readonly approximateChange: number | null;
}

export interface PublicCompetitorSnapshot {
  /** この内容が「どのTurnの結果か」。 */
  readonly sourceTurn: number;
  /**
   * 出所の種別。初期受注残から作った開始時点の勢力図か、確定した四半期結果か。
   * 画面はこれを必ず併記する。
   */
  readonly source: "GAME_START_BACKLOG" | "LAST_QUARTER_RESULT";
  readonly cells: readonly CompetitorMarketCell[];
  readonly salesForce: readonly CompetitorSalesForceEntry[];
  /** 公開してよい大型投資の発表（着工・稼働）。 */
  readonly investments: readonly PublicInvestmentAnnouncement[];
  /** 各社の工場数（稼働中＋建設中）。 */
  readonly factoryCounts: readonly CompanyFactoryCount[];
}

// ---------------------------------------------------------------------
// 4. 組み立て
// ---------------------------------------------------------------------

function roundToTen(value: number): number {
  const rounded = Math.round(value / 10) * 10;
  // Math.round(-3 / 10) * 10 は -0 を返す。画面で「-0人」と出るのを避けるため 0 に正規化する。
  return rounded === 0 ? 0 : rounded;
}

/** 会社×市場×商品の数量表。 */
type QuantityTable = Map<string, Map<CompanyId, number>>;

function cellKey(market: DemandMarketId, product: Product): string {
  return `${market}|${product}`;
}

function addQuantity(table: QuantityTable, market: DemandMarketId, product: Product, companyId: CompanyId, quantity: number): void {
  if (!Number.isFinite(quantity) || quantity <= 0) return;
  const key = cellKey(market, product);
  const row = table.get(key) ?? new Map<CompanyId, number>();
  row.set(companyId, (row.get(companyId) ?? 0) + quantity);
  table.set(key, row);
}

/** 確定記録の成約配分から、会社×市場×商品の新規成約量を数える。 */
function quantityTableFromRecord(record: CompanyQuarterRecord): QuantityTable {
  const table: QuantityTable = new Map();
  for (const allocation of record.salesRecord.allocations) {
    for (const entry of allocation.companies) {
      addQuantity(table, allocation.market, allocation.product, entry.companyId, unwrapUnit(entry.allocatedQuantity));
    }
  }
  return table;
}

/** 開始時点の受注残から、会社×市場×商品の数量を数える（Turn 1 用）。 */
function quantityTableFromContracts(contracts: readonly SalesContract[]): QuantityTable {
  const table: QuantityTable = new Map();
  for (const contract of contracts) {
    addQuantity(table, contract.market, contract.product, contract.companyId, unwrapUnit(contract.outstandingQuantity));
  }
  return table;
}

/** 市場×商品ごとの crowding ratio（診断がある四半期のみ）。 */
function crowdingRatioByCell(record: CompanyQuarterRecord | null): Map<string, number> {
  const result = new Map<string, number>();
  for (const bucket of record?.crowdingDiagnostics?.buckets ?? []) {
    const ratio = bucket.crowdingRatio;
    if (!Number.isFinite(ratio)) continue;
    // 同じ市場×商品が複数の納期バケツに分かれることがある。
    // 受講者に出すのは「そのマスがどれだけ混んでいるか」なので、最も混んだ値を採る
    // （平均にすると、一部の納期だけ強く混んでいる状況が薄まって見えなくなる）。
    const key = cellKey(bucket.market, bucket.product);
    const existing = result.get(key);
    if (existing === undefined || ratio > existing) result.set(key, ratio);
  }
  return result;
}

function buildCells(input: {
  readonly current: QuantityTable;
  readonly previous: QuantityTable | null;
  readonly crowding: Map<string, number>;
  readonly companyIds: readonly CompanyId[];
  readonly ownCompanyId: CompanyId;
}): readonly CompetitorMarketCell[] {
  const { current, previous, crowding, companyIds, ownCompanyId } = input;

  function sharesFor(table: QuantityTable, key: string): Map<CompanyId, number> {
    const row = table.get(key);
    const result = new Map<CompanyId, number>();
    if (!row) return result;
    let total = 0;
    for (const value of row.values()) total += value;
    if (total <= 0) return result;
    for (const [companyId, value] of row) result.set(companyId, value / total);
    return result;
  }

  const cells: CompetitorMarketCell[] = [];
  for (const key of [...current.keys()].sort()) {
    const [market, product] = key.split("|") as [DemandMarketId, Product];
    const currentShares = sharesFor(current, key);
    const previousShares = previous ? sharesFor(previous, key) : null;

    const shares: CompetitorShareEntry[] = companyIds.map((companyId) => {
      const share = currentShares.get(companyId) ?? 0;
      const band = classifyShareBand(share);
      const previousBand = previousShares ? classifyShareBand(previousShares.get(companyId) ?? 0) : null;
      const base: CompetitorShareEntry = { companyId, band, trend: compareShareBand(band, previousBand) };
      // 正確なシェアは自社の行にだけ載せる。他社の行にはキー自体を作らない。
      return companyId === ownCompanyId ? { ...base, exactShare: share } : base;
    });

    const ratio = crowding.get(key);
    cells.push({
      market,
      product,
      shares,
      crowding: ratio === undefined ? null : classifyCrowdingBand(ratio),
    });
  }
  return cells;
}

/**
 * 営業人員の公開値を作る。
 *
 * 【人数の出どころ】会社ごとの営業人員は四半期記録ではなく
 * CompanyLabState.salesForceHiringState が持つ（ターンをまたぐ状態）。
 * したがって現在人数はその状態から受け取る。
 *
 * 【増減の出どころ】採用は「次の四半期の開始時点から配分可能になる」仕様
 * （salesForceHiring.ts）なので、**前四半期に出された採用・解雇の指示**が
 * そのまま「今期から効く増減」になる。これは既に効果が出ている過去の結果で
 * あり、当期の他社の入力ではない。
 *
 * 【10人単位の丸め方】増減は「丸めた人数どうしの差」ではなく
 * 「実数の増減を丸めた値」を出す。前者にすると、例えば 64→71 人（+7人）が
 * 「約60人 → 約70人、+10人」と出てしまい、実際より多く採用したように見える。
 */
function buildSalesForce(
  record: CompanyQuarterRecord | null,
  companyIds: readonly CompanyId[],
  currentHeadcountByCompanyId: ReadonlyMap<CompanyId, number>
): readonly CompetitorSalesForceEntry[] {
  return companyIds.map((companyId) => {
    const current = currentHeadcountByCompanyId.get(companyId) ?? 0;
    const decision = record?.decisions.find((d) => d.companyId === companyId);
    const netChange =
      decision === undefined ? null : (decision.salesForceHireCount ?? 0) - (decision.salesForceLayoffCount ?? 0);
    return {
      companyId,
      approximateHeadcount: roundToTen(current),
      approximateChange: netChange === null ? null : roundToTen(netChange),
    };
  });
}

/**
 * 確定した四半期の結果から公開スナップショットを作る（Turn 2 以降）。
 *
 * @param record         直近の確定四半期（この内容が公開される）
 * @param previousRecord その1つ前（帯の↑↓判定にだけ使う）
 */
export function buildPublicCompetitorSnapshot(input: {
  readonly record: CompanyQuarterRecord;
  readonly previousRecord: CompanyQuarterRecord | null;
  readonly companyIds: readonly CompanyId[];
  readonly ownCompanyId: CompanyId;
  /** 会社ごとの現在の営業人員（CompanyLabState.salesForceHiringState 由来）。 */
  readonly salesForceHeadcountByCompanyId: ReadonlyMap<CompanyId, number>;
  /** 公開投資発表。省略は「該当なし」を意味する。 */
  readonly investments?: readonly PublicInvestmentAnnouncement[];
  /** 各社の工場数。省略は「未取得」ではなく「集計対象なし」を意味する。 */
  readonly factoryCounts?: readonly CompanyFactoryCount[];
}): PublicCompetitorSnapshot {
  const { record, previousRecord, companyIds, ownCompanyId } = input;
  return {
    sourceTurn: record.turn,
    source: "LAST_QUARTER_RESULT",
    cells: buildCells({
      current: quantityTableFromRecord(record),
      previous: previousRecord ? quantityTableFromRecord(previousRecord) : null,
      crowding: crowdingRatioByCell(record),
      companyIds,
      ownCompanyId,
    }),
    salesForce: buildSalesForce(record, companyIds, input.salesForceHeadcountByCompanyId),
    investments: input.investments ?? [],
    factoryCounts: input.factoryCounts ?? [],
  };
}

/**
 * まだ1四半期も確定していない Turn 1 用のスナップショット。
 *
 * 前四半期が存在しないため、開始時点の受注残（会社の初期設定）をシェアとして使う。
 * 「開始時点の勢力図」であって実績ではないことを source で明示する。
 * 帯の↑↓は比較対象が無いので必ず null になる。
 */
export function buildGameStartCompetitorSnapshot(input: {
  readonly contracts: readonly SalesContract[];
  readonly companyIds: readonly CompanyId[];
  readonly ownCompanyId: CompanyId;
  readonly salesForceHeadcountByCompanyId: ReadonlyMap<CompanyId, number>;
  readonly factoryCounts?: readonly CompanyFactoryCount[];
}): PublicCompetitorSnapshot {
  const { contracts, companyIds, ownCompanyId, salesForceHeadcountByCompanyId } = input;
  return {
    sourceTurn: 1,
    source: "GAME_START_BACKLOG",
    cells: buildCells({
      current: quantityTableFromContracts(contracts),
      previous: null,
      // 開始時点では提示が一度も行われていないため混雑度は存在しない。
      crowding: new Map(),
      companyIds,
      ownCompanyId,
    }),
    salesForce: buildSalesForce(null, companyIds, salesForceHeadcountByCompanyId),
    // 開始時点ではまだ1件も着工・稼働していない。
    investments: [],
    factoryCounts: input.factoryCounts ?? [],
  };
}

// ---------------------------------------------------------------------
// 5. 大型投資の発表（公開情報②）
// ---------------------------------------------------------------------

/**
 * 公開対象の投資案件。
 *
 * 【この5種だけにする理由】品質管理設備・排水環境設備・保管庫増設などは
 * 小型で、毎ターン流れると本当に効く情報（新工場・ライン増設）が埋もれる。
 * 共通加工能力増設・凍結包装能力増設も、仕様で公開対象に挙げられていないため
 * 出さない（勝手に公開範囲を広げない）。
 */
export const PUBLIC_INVESTMENT_PROJECT_TYPES: readonly CapitalProjectType[] = [
  "newFactoryConstruction",
  "hosoLineExpansion",
  "pdLineExpansion",
  "vapLineExpansion",
  "pdMechanization",
];

export type PublicInvestmentKind = "constructionStarted" | "operational";

export interface PublicInvestmentAnnouncement {
  readonly companyId: CompanyId;
  readonly projectType: CapitalProjectType;
  readonly kind: PublicInvestmentKind;
  /** 対象商品（ライン増設のみ）。新工場・省人化では null。 */
  readonly product: Product | null;
  /**
   * 概数の投資額（USD）。**新工場のみ公開する**。
   * 値は capex カタログの標準額であり、その会社が実際に承認した金額ではない
   * （実額を出すと他社の資金規模が推測できてしまう）。
   */
  readonly approximateInvestmentUsd: number | null;
  /** 概数の追加能力（HOSO換算トン/四半期）。カタログ標準値。無い案件は null。 */
  readonly approximateCapacityTonsPerQuarter: number | null;
  /** 着工時点から稼働開始までの見込み四半期数（カタログの工期＋稼働準備）。 */
  readonly expectedQuartersToOperational: number | null;
}

/** 各社の工場数（稼働中＋建設中）。 */
export interface CompanyFactoryCount {
  readonly companyId: CompanyId;
  readonly operating: number;
  readonly underConstruction: number;
}

function roundToMillions(value: number): number {
  return Math.round(value / 1_000_000) * 1_000_000;
}

function roundToHundreds(value: number): number {
  return Math.round(value / 100) * 100;
}

/**
 * 確定した四半期の capex イベントから、公開してよい投資発表を抜き出す。
 *
 * 【却下・取り下げは出さない】statusAfter が cancelled の案件、および
 * rejectedProposals は公開対象にしない（仕様どおり。検討しただけの案件が
 * 他社に見えると、意思決定前の情報が漏れるのと同じことになる）。
 *
 * 【着工のタイミング】statusBefore === "approved" のイベントが
 * 「前のターンに承認され、いま着工した」案件にあたる。承認の翌ターンに
 * 公開する、という仕様はこれで満たされる。
 */
export function buildPublicInvestmentAnnouncements(input: {
  readonly record: CompanyQuarterRecord;
  readonly templatesByType: Readonly<Record<CapitalProjectType, CapexProjectTemplate>>;
}): readonly PublicInvestmentAnnouncement[] {
  const announcements: PublicInvestmentAnnouncement[] = [];
  for (const capex of input.record.capexResults) {
    for (const event of capex.events) {
      if (!PUBLIC_INVESTMENT_PROJECT_TYPES.includes(event.projectType)) continue;

      const started = event.statusBefore === "approved" && event.statusAfter !== "cancelled";
      const operational = event.statusAfter === "completed";
      if (!started && !operational) continue;

      const template = input.templatesByType[event.projectType];
      const isNewFactory = event.projectType === "newFactoryConstruction";
      const effect = template?.futureCapacityEffect;
      const newFactory = template?.newFactoryEffect;

      const capacity = isNewFactory
        ? (newFactory?.fullCapacities.commonProcessing ?? null)
        : typeof effect?.capacityIncreaseTonsPerQuarter === "number" && effect.capacityIncreaseTonsPerQuarter > 0
          ? effect.capacityIncreaseTonsPerQuarter
          : null;

      const targetProduct = effect?.targetProduct;
      announcements.push({
        companyId: capex.companyId,
        projectType: event.projectType,
        kind: operational ? "operational" : "constructionStarted",
        product: targetProduct === "hoso" || targetProduct === "pd" || targetProduct === "vap" ? targetProduct : null,
        // 投資額は新工場だけ、しかもカタログ標準額の概数だけを出す。
        approximateInvestmentUsd: isNewFactory && template ? roundToMillions(template.standardBudgetUsd) : null,
        approximateCapacityTonsPerQuarter: capacity === null ? null : roundToHundreds(capacity),
        expectedQuartersToOperational:
          operational || !template ? null : template.standardConstructionQuarters + template.postCompletionReadinessQuarters,
      });
    }
  }
  // 会社・案件種別で安定した順序にする（確定記録の並び順に依存させない）。
  return [...announcements].sort((a, b) =>
    a.companyId !== b.companyId ? a.companyId.localeCompare(b.companyId) : a.projectType.localeCompare(b.projectType)
  );
}

/**
 * 各社の工場数。稼働中は現在の Factory 一覧から、建設中は capex の
 * 新工場案件（underConstruction）から数える。能力値は公開しない。
 */
export function buildCompanyFactoryCounts(input: {
  readonly factories: readonly { readonly companyId: CompanyId }[];
  readonly capexProjectsByCompanyId: ReadonlyMap<CompanyId, readonly { readonly projectType: CapitalProjectType; readonly status: string }[]>;
  readonly companyIds: readonly CompanyId[];
}): readonly CompanyFactoryCount[] {
  return input.companyIds.map((companyId) => ({
    companyId,
    operating: input.factories.filter((f) => f.companyId === companyId).length,
    underConstruction: (input.capexProjectsByCompanyId.get(companyId) ?? []).filter(
      (p) => p.projectType === "newFactoryConstruction" && (p.status === "underConstruction" || p.status === "approved")
    ).length,
  }));
}
