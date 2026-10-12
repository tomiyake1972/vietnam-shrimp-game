// ShrimpX V2 — 競合ニュースの生成（PUBLIC-COMPETITOR-2）
//
// 【このモジュールが存在する理由】
//   公開競合情報（シェア帯・営業人員・投資発表）を表として出すだけでは、
//   「何が起きたのか」が読み取りにくい。前四半期の確定結果から条件に合う
//   出来事を拾い、既存のシナリオニュースと同じカード形式で流す。
//
// 【決定論（最重要）】
//   LLM も Math.random() も使わない。本文はテンプレート＋変数で組み立て、
//   「観測・噂」が外れるかどうかも run ID ＋ターン＋記事キーから導いた
//   ハッシュで決める。同じ Run を再表示・リプレイしても、記事の並びも
//   外れ方も必ず同じになる。
//
// 【情報境界】
//   記事に書いてよいのは帯・概数・カタログ標準値だけ。他社の正確なトン数・
//   価格・利益・原価は書かない（数値はすべて publicCompetitorSnapshot が
//   既に丸めたものだけを使う）。
//
// 【外れ記事を訂正しない】
//   「観測・噂」が外れた場合でも、翌ターンに打ち消し記事は出さない
//   （三宅さんの判断）。受講者は次の四半期の実績を見て自分で判断する。

import { CompanyId } from "../sales/types";
import { Product } from "../market/types";
import {
  CROWDING_BAND_LABEL,
  CompetitorMarketCell,
  PublicCompetitorSnapshot,
  PublicInvestmentAnnouncement,
} from "./publicCompetitorSnapshot";

// ---------------------------------------------------------------------
// 1. 記事の型
// ---------------------------------------------------------------------

export type CompetitorNewsKind =
  | "majorInvestment"
  | "marketCrowding"
  | "priceOffensive"
  | "shareGain"
  | "salesForceBuildup"
  | "deliveryDelay"
  | "liquidityStress"
  | "annualDividend";

/** 確度ラベル。既存のシナリオニュースと同じ2値。 */
export type CompetitorNewsConfidence = "confirmed" | "rumored";

export interface CompetitorNewsItem {
  /** 決定論的なID（同じ Run・同じターンなら必ず同じ）。 */
  readonly newsId: string;
  readonly kind: CompetitorNewsKind;
  readonly confidence: CompetitorNewsConfidence;
  readonly companyId: CompanyId | null;
  readonly headline: string;
  readonly body: string;
  /** 市場・商品・会社などのタグ（画面の絞り込み用）。 */
  readonly tags: readonly string[];
  /**
   * この記事が事実と異なるか。confidence==="rumored" の記事にのみ true が付きうる。
   * **画面には出さない**（出したら噂である意味が無い）。
   * 研修後のふりかえり・GM 側の検証・テストのためにだけ持つ。
   */
  readonly isMisleading: boolean;
}

/**
 * 優先順位。1ターンの本数上限を超えたらこの順で残す。
 * 年間配当は別枠（上限に数えない）なので、ここには含めない。
 */
const KIND_PRIORITY: readonly CompetitorNewsKind[] = [
  "majorInvestment",
  "marketCrowding",
  "priceOffensive",
  "shareGain",
  "salesForceBuildup",
  "deliveryDelay",
  "liquidityStress",
];

/** 1ターンに流す競合ニュースの上限（年間配当の別枠を除く）。 */
export const MAX_COMPETITOR_NEWS_PER_TURN = 3;

/** 「観測・噂」が事実と食い違う確率。 */
export const RUMOR_MISLEADING_RATE = 0.25;

// ---------------------------------------------------------------------
// 2. 決定論的な擬似乱数
// ---------------------------------------------------------------------

/**
 * FNV-1a 32bit ハッシュ。暗号用途ではなく、「同じ文字列からは必ず同じ数」を
 * 得るためだけに使う。Math.random() を使わないのは、リプレイ・再表示で
 * 記事の外れ方が変わってしまうため。
 */
function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 0以上1未満の決定論的な値。 */
export function deterministicUnitValue(seed: string): number {
  return hash32(seed) / 0x100000000;
}

// ---------------------------------------------------------------------
// 3. 条件判定と本文
// ---------------------------------------------------------------------

const PRODUCT_LABEL: Readonly<Record<Product, string>> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

interface Candidate {
  readonly kind: CompetitorNewsKind;
  readonly confidence: CompetitorNewsConfidence;
  readonly companyId: CompanyId | null;
  readonly key: string;
  readonly headline: string;
  readonly body: string;
  readonly tags: readonly string[];
  /** 外れたときの本文（rumored のみ）。 */
  readonly misleadingHeadline?: string;
  readonly misleadingBody?: string;
}

function investmentCandidates(
  investments: readonly PublicInvestmentAnnouncement[],
  nameOf: (companyId: CompanyId) => string
): readonly Candidate[] {
  return investments.map((investment) => {
    const name = nameOf(investment.companyId);
    const isNewFactory = investment.projectType === "newFactoryConstruction";
    const started = investment.kind === "constructionStarted";

    if (isNewFactory) {
      const amount = investment.approximateInvestmentUsd;
      const capacity = investment.approximateCapacityTonsPerQuarter;
      const amountText = amount === null ? "" : `投資額は約${Math.round(amount / 1_000_000).toLocaleString()}百万ドル。`;
      const capacityText = capacity === null ? "" : `フル稼働時の処理能力は約${capacity.toLocaleString()}トン／四半期とされる。`;
      return {
        kind: "majorInvestment" as const,
        confidence: "confirmed" as const,
        companyId: investment.companyId,
        key: `investment:${investment.companyId}:${investment.projectType}:${investment.kind}`,
        headline: started ? `${name}、新工場を着工` : `${name}の新工場が稼働を開始`,
        body: started
          ? `${name}が新工場の建設に着手した。${amountText}${capacityText}稼働開始までは約${investment.expectedQuartersToOperational ?? "?"}四半期を見込む。`
          : `${name}の新工場が稼働を開始した。${capacityText}立ち上げ期間を経て能力が段階的に上がる見通し。`,
        tags: ["競合動向", "投資", name],
      };
    }

    if (investment.projectType === "pdMechanization") {
      return {
        kind: "majorInvestment" as const,
        confidence: "confirmed" as const,
        companyId: investment.companyId,
        key: `investment:${investment.companyId}:${investment.projectType}:${investment.kind}`,
        headline: started ? `${name}、PD工程の省人化に着手` : `${name}のPD省人化設備が稼働`,
        body: started
          ? `${name}が自社工場のPD工程について省人化設備の導入を始めた。対象工場や削減規模は公表されていない。`
          : `${name}のPD省人化設備が稼働を開始した。PDの生産能力そのものが増えるわけではない。`,
        tags: ["競合動向", "投資", name, "PD"],
      };
    }

    const productLabel = investment.product ? PRODUCT_LABEL[investment.product] : "加工";
    const capacity = investment.approximateCapacityTonsPerQuarter;
    const capacityText = capacity === null ? "" : `追加能力は約${capacity.toLocaleString()}トン／四半期。`;
    return {
      kind: "majorInvestment" as const,
      confidence: "confirmed" as const,
      companyId: investment.companyId,
      key: `investment:${investment.companyId}:${investment.projectType}:${investment.kind}`,
      headline: started ? `${name}、${productLabel}ラインを増設へ` : `${name}の${productLabel}増設ラインが稼働`,
      body: started
        ? `${name}が${productLabel}の加工ライン増設に着手した。${capacityText}稼働開始までは約${investment.expectedQuartersToOperational ?? "?"}四半期の見込み。`
        : `${name}の${productLabel}増設ラインが稼働を開始した。${capacityText}`,
      tags: ["競合動向", "投資", name, productLabel],
    };
  });
}

function crowdingCandidates(cells: readonly CompetitorMarketCell[]): readonly Candidate[] {
  return cells
    .filter((cell) => cell.crowding === "tight")
    .map((cell) => {
      const label = `${cell.market}${PRODUCT_LABEL[cell.product]}`;
      return {
        kind: "marketCrowding" as const,
        confidence: "confirmed" as const,
        companyId: null,
        key: `crowding:${cell.market}:${cell.product}`,
        headline: `${label}市場に各社の提示が集中`,
        body: `${label}市場では、前四半期に各社の提示が需要に対して集中した（混雑度「${CROWDING_BAND_LABEL.tight}」）。この状態が続くと成約価格の下押し要因になる。`,
        tags: ["競合動向", "市場", cell.market, PRODUCT_LABEL[cell.product]],
      };
    });
}

function shareGainCandidates(
  cells: readonly CompetitorMarketCell[],
  nameOf: (companyId: CompanyId) => string
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const cell of cells) {
    for (const share of cell.shares) {
      if (share.trend !== "up" || share.band === "none" || share.band === "small") continue;
      const name = nameOf(share.companyId);
      const label = `${cell.market}${PRODUCT_LABEL[cell.product]}`;
      candidates.push({
        kind: "shareGain",
        confidence: "confirmed",
        companyId: share.companyId,
        key: `shareGain:${cell.market}:${cell.product}:${share.companyId}`,
        headline: `${label}市場で${name}が存在感、取引先が拡大`,
        body: `前四半期の${label}市場で、${name}の位置づけが一段上がった。取引先の裾野が広がっているとみられる。`,
        tags: ["競合動向", "シェア", cell.market, PRODUCT_LABEL[cell.product], name],
      });
    }
  }
  return candidates;
}

function salesForceCandidates(
  snapshot: PublicCompetitorSnapshot,
  nameOf: (companyId: CompanyId) => string
): readonly Candidate[] {
  return snapshot.salesForce
    .filter((entry) => {
      const change = entry.approximateChange;
      if (change === null || change < 20) return false;
      const before = entry.approximateHeadcount - change;
      // 20人以上、または20%以上の増員。
      return change >= 20 || (before > 0 && change / before >= 0.2);
    })
    .map((entry) => {
      const name = nameOf(entry.companyId);
      return {
        kind: "salesForceBuildup" as const,
        confidence: "confirmed" as const,
        companyId: entry.companyId,
        key: `salesForce:${entry.companyId}`,
        headline: `${name}が営業体制を強化、約${entry.approximateChange}人を新たに採用`,
        body: `${name}が営業人員を約${entry.approximateChange}人増やし、総勢は約${entry.approximateHeadcount}人になった。採用した人員は次の四半期から配置される。どの市場へ投入するかは公表されていない。`,
        tags: ["競合動向", "営業", name],
      };
    });
}

/** 値下げ攻勢・納期遅延・資金繰りの判定に必要な、確定記録由来の公開可能な事実。 */
export interface CompetitorSignalInput {
  readonly companyId: CompanyId;
  /** 平均成約価格が市場基準より何%低いか（0.03 = 3%低い）。取得できなければ null。 */
  readonly priceDiscountRatio: number | null;
  /** 帯が上がったマスがあるか（値下げ攻勢の判定に使う）。 */
  readonly gainedShare: boolean;
  /** 納期超過が受注残に占める割合。取得できなければ null。 */
  readonly overdueRatio: number | null;
  /** 当四半期に緊急融資を使ったか。 */
  readonly usedEmergencyLoan: boolean;
}

function signalCandidates(
  signals: readonly CompetitorSignalInput[],
  nameOf: (companyId: CompanyId) => string
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const signal of signals) {
    const name = nameOf(signal.companyId);

    if (signal.priceDiscountRatio !== null && signal.priceDiscountRatio >= 0.03 && signal.gainedShare) {
      candidates.push({
        kind: "priceOffensive",
        confidence: "rumored",
        companyId: signal.companyId,
        key: `priceOffensive:${signal.companyId}`,
        headline: `${name}に値下げの動き`,
        body: `${name}の提示が相場を下回っているとの見方がある。取引先によると、前四半期の成約価格は市場の基準をやや下回る水準だったという。`,
        tags: ["競合動向", "価格", name],
        misleadingHeadline: `${name}、強気の価格設定に転換との観測`,
        misleadingBody: `${name}が提示価格を引き上げているとの見方が一部にある。取引先によると、相場を上回る水準での提示が増えているという。ただし確認は取れていない。`,
      });
    }

    if (signal.overdueRatio !== null && signal.overdueRatio >= 0.1) {
      candidates.push({
        kind: "deliveryDelay",
        confidence: "rumored",
        companyId: signal.companyId,
        key: `deliveryDelay:${signal.companyId}`,
        headline: `${name}の出荷に遅れとの話`,
        body: `${name}の納品に遅れが出ているとの話が輸入業者の間で出ている。受注残のうち納期を過ぎた分が目立ってきたとの見方も。`,
        tags: ["競合動向", "納期", name],
        misleadingHeadline: `${name}、出荷体制を立て直したとの観測`,
        misleadingBody: `${name}の納品遅延が解消に向かっているとの見方がある。取引先によると直近の出荷は安定してきたというが、裏付けは取れていない。`,
      });
    }

    if (signal.usedEmergencyLoan) {
      candidates.push({
        kind: "liquidityStress",
        confidence: "rumored",
        companyId: signal.companyId,
        key: `liquidity:${signal.companyId}`,
        headline: `${name}、資金繰りに緊張の観測`,
        body: `${name}が短期の資金調達に動いたとの見方がある。金融関係者は「通常の運転資金の範囲」とするが、確認は取れていない。`,
        tags: ["競合動向", "財務", name],
        misleadingHeadline: `${name}、手元資金に余裕との見方`,
        misleadingBody: `${name}の資金繰りは安定しているとの見方が出ている。関係者によると当面の支払いに懸念はないというが、裏付けは乏しい。`,
      });
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------
// 4. 組み立て
// ---------------------------------------------------------------------

/** 年間配当の記事（Q4の翌ターンに別枠で必ず出す）。 */
export interface AnnualDividendNewsInput {
  readonly fiscalYearLabel: string;
  readonly topCompanyId: CompanyId;
  readonly topApproximateUsd: number;
}

export function buildCompetitorNews(input: {
  /** 記事の決定論シードに使う。run ID ＋ ターン。 */
  readonly runId: string;
  readonly turn: number;
  readonly snapshot: PublicCompetitorSnapshot;
  readonly signals: readonly CompetitorSignalInput[];
  readonly displayNameByCompanyId: ReadonlyMap<CompanyId, string>;
  readonly annualDividend?: AnnualDividendNewsInput;
}): readonly CompetitorNewsItem[] {
  const { runId, turn, snapshot, signals, displayNameByCompanyId } = input;
  const nameOf = (companyId: CompanyId): string => displayNameByCompanyId.get(companyId) ?? companyId;

  const candidates: Candidate[] = [
    ...investmentCandidates(snapshot.investments, nameOf),
    ...crowdingCandidates(snapshot.cells),
    ...shareGainCandidates(snapshot.cells, nameOf),
    ...salesForceCandidates(snapshot, nameOf),
    ...signalCandidates(signals, nameOf),
  ];

  // 優先順位 → 同順位内は key の辞書順（確定記録の並び順に結果を依存させない）。
  const ordered = [...candidates].sort((a, b) => {
    const byKind = KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind);
    return byKind !== 0 ? byKind : a.key.localeCompare(b.key);
  });

  // 同じ会社は1ターンに1本まで。会社に紐づかない記事（市場の混雑）は対象外。
  const usedCompanyIds = new Set<CompanyId>();
  const selected: Candidate[] = [];
  for (const candidate of ordered) {
    if (selected.length >= MAX_COMPETITOR_NEWS_PER_TURN) break;
    if (candidate.companyId !== null) {
      if (usedCompanyIds.has(candidate.companyId)) continue;
      usedCompanyIds.add(candidate.companyId);
    }
    selected.push(candidate);
  }

  const items: CompetitorNewsItem[] = selected.map((candidate) => {
    const seed = `${runId}|${turn}|${candidate.key}`;
    const isMisleading =
      candidate.confidence === "rumored" &&
      candidate.misleadingBody !== undefined &&
      deterministicUnitValue(seed) < RUMOR_MISLEADING_RATE;
    return {
      newsId: `competitor-${turn}-${candidate.key}`,
      kind: candidate.kind,
      confidence: candidate.confidence,
      companyId: candidate.companyId,
      headline: isMisleading ? (candidate.misleadingHeadline ?? candidate.headline) : candidate.headline,
      body: isMisleading ? (candidate.misleadingBody ?? candidate.body) : candidate.body,
      tags: candidate.tags,
      isMisleading,
    };
  });

  // 年間配当は上限3本に数えず、必ず別枠で出す。
  if (input.annualDividend) {
    const dividend = input.annualDividend;
    const name = nameOf(dividend.topCompanyId);
    items.push({
      newsId: `competitor-${turn}-annualDividend`,
      kind: "annualDividend",
      confidence: "confirmed",
      companyId: null,
      headline: `${dividend.fiscalYearLabel}の年間配当が出そろう`,
      body: `${dividend.fiscalYearLabel}の各社の年間配当が確定した。最も多かったのは${name}で約${Math.round(dividend.topApproximateUsd / 1_000_000).toLocaleString()}百万ドル。`,
      tags: ["競合動向", "配当"],
      isMisleading: false,
    });
  }

  return items;
}
