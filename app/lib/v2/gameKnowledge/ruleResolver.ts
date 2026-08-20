// ShrimpX V2 — Deterministic Rule Resolution（Phase M2.8.1・実装指示§3）
//
// 【なぜ必要か】M2.8でKnowledge Registryを注入しても、実APIの回答は
//   ・営業能力を「前期売上 ÷ 営業人数」で答える
//   ・PD 1,000tに「1,000人強」、VAP 1,000tに「1,300人超」と答える
//   ・輸入原料を「Q2発注 → Q2利用可能」と答える
// といった誤りを出した。Knowledgeを"参考情報"として渡すだけでは、モデルが
// briefingの数字から独自にルールを逆算してしまう。
//
// 【この層の役割】ゲームルールに関する質問については、**server側でengineの関数と
// 現在のparameterから答えそのものを確定**し、Claudeへ「この結果は変更してはならない」
// と明示して渡す。Claudeの仕事は日本語で説明することだけであり、計算ではない。
//
// 【変更禁止（実装指示§14）】ここに新しいゲームルールは無い。すべて既存の
// engine関数・parameterの読み出しである。

import { Product } from "../market/types";
import { companySalesOrganizationCapacity, SALES_CAPACITY_MODEL_PER_MARKET } from "../sales/salesCapacityModel";
import { DEFAULT_GAME_KNOWLEDGE_PARAMETERS, GameKnowledgeParameterSources } from "./dynamicValues";
import { estimateSalesCapacity, estimateWorkerRequirement } from "./estimators";
import { QuestionIntent } from "./types";

/** 実装指示§3。server側で確定した、変更してはならない回答。 */
export interface ResolvedGameRuleAnswer {
  /** どの種類のルール解決か（テスト・監査用）。 */
  readonly resolverId: string;
  readonly questionIntent: QuestionIntent;
  /** この回答の根拠になるKnowledge entryのid。 */
  readonly knowledgeIds: readonly string[];
  /** 使用した確定値（parameter・engine関数の出力）。 */
  readonly canonicalFacts: Readonly<Record<string, string | number>>;
  /** 計算過程を人間可読の1行で（Claudeが別の式を作らないようにする）。 */
  readonly calculation: string;
  /** 確定した結果。Claudeはこの数値・語を変更してはならない。 */
  readonly result: string;
  readonly unit: string;
  readonly caveats: readonly string[];
  /** 現況への当てはめが必要な場合のヒント（数値はbriefing側にある）。 */
  readonly currentApplication?: string;
}

const EMPTY: readonly ResolvedGameRuleAnswer[] = [];

// ---------------------------------------------------------------------
// 質問文の解析（全角数字・カンマ・単位ゆらぎを正規化する）
// ---------------------------------------------------------------------

export function normalizeQuestion(text: string): string {
  return text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/,/g, "");
}

function firstNumber(text: string, pattern: RegExp): number | null {
  for (const match of normalizeQuestion(text).matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

const HEADCOUNT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:人|名|persons?|people|headcount)/gi;
const TONS_PATTERN = /(\d+(?:\.\d+)?)\s*(?:t\b|トン|tons?)/gi;

/** 「営業」に関する質問か。 */
function isSalesQuestion(text: string): boolean {
  return /営業|セールス|sales\s*(force|person|people|rep)|salesperson/i.test(text);
}
/** 「Worker（生産人員）」に関する質問か。 */
function isWorkerQuestion(text: string): boolean {
  return /worker|ワーカー|作業員|工員|生産.*(人|要員)|人員/i.test(text);
}
function isPerPersonQuestion(text: string): boolean {
  return /一人|1人|１人|per\s*(person|head|salesperson)|人当たり|人あたり/i.test(text);
}

function detectProduct(text: string): Product | null {
  const lower = text.toLowerCase();
  if (lower.includes("vap")) return "vap";
  if (lower.includes("pd")) return "pd";
  if (lower.includes("hoso")) return "hoso";
  return null;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------
// 1. 営業能力（実装指示§4）
// ---------------------------------------------------------------------

function resolveSalesCapacity(question: string, sources: GameKnowledgeParameterSources): readonly ResolvedGameRuleAnswer[] {
  if (!isSalesQuestion(question)) return EMPTY;
  const model = sources.sales.salesCapacityModel ?? SALES_CAPACITY_MODEL_PER_MARKET;
  if (model.kind === "perMarket") return EMPTY;

  const coefficients = sources.sales.salesEffortCoefficients;
  const knowledgeIds = ["SALES.SALESPERSON_CAPACITY", "SALES.CAPACITY_VS_ACTUAL"];
  const curve = `capacity(h) = ${model.companyBaselineCapacityTons} + ${model.companyCapacityMaxIncrementTons} × h/(h + ${model.companyCapacitySaturationHeadcount})`;
  const answers: ResolvedGameRuleAnswer[] = [];

  const headcount = firstNumber(question, HEADCOUNT_PATTERN);
  const targetTons = firstNumber(question, TONS_PATTERN);

  // (a)「営業N人ならどれくらい売れる？」
  // 【注意】「営業1人当たり」の"1人"を人数指定と誤読しない。この場合は(b)だけが正しい答えで、
  // 「営業1人の能力は◯トン」を併記すると、存在しない per-person 固定能力を追認してしまう。
  const headcountIsPerPersonArtifact = headcount === 1 && isPerPersonQuestion(question);
  if (headcount !== null && !headcountIsPerPersonArtifact) {
    const estimate = estimateSalesCapacity(headcount, sources);
    const effort = estimate.effortCapacityTons ?? 0;
    answers.push({
      resolverId: "SALES_CAPACITY_AT_HEADCOUNT",
      questionIntent: "GAME_RULE",
      knowledgeIds,
      canonicalFacts: {
        headcount,
        salesEffortCapacityTonsPerQuarter: round(effort),
        hosoOnlyTons: round(estimate.sellableTonsByProduct.hoso ?? 0),
        pdOnlyTons: round(estimate.sellableTonsByProduct.pd ?? 0),
        vapOnlyTons: round(estimate.sellableTonsByProduct.vap ?? 0),
        hosoEffortCoefficient: coefficients.hoso,
        pdEffortCoefficient: coefficients.pd,
        vapEffortCoefficient: coefficients.vap,
      },
      calculation: `${curve} に h=${headcount} を代入 → ${round(effort)} 営業工数トン/四半期。実トン数は商品別工数係数で割る。`,
      result: `営業${headcount}人の営業工数能力は ${round(effort)} 工数トン/四半期。実際に売れるトン数は商品構成次第で、HOSOのみなら約${round(
        estimate.sellableTonsByProduct.hoso ?? 0
      )}t、PDのみなら約${round(estimate.sellableTonsByProduct.pd ?? 0)}t、VAPのみなら約${round(estimate.sellableTonsByProduct.vap ?? 0)}t。混合構成ではこの間の値になる。`,
      unit: "HosoEqTons/quarter",
      caveats: estimate.caveats,
    });
  }

  // (b)「営業一人あたりでどれくらい売れる？」= 固定値が存在しないことを確定回答にする
  if (isPerPersonQuestion(question) || headcount === null) {
    const at30 = companySalesOrganizationCapacity(30, model);
    const at60 = companySalesOrganizationCapacity(60, model);
    const at100 = companySalesOrganizationCapacity(100, model);
    answers.push({
      resolverId: "SALES_CAPACITY_PER_PERSON",
      questionIntent: "GAME_RULE",
      knowledgeIds,
      canonicalFacts: {
        fixedTonsPerSalespersonExists: "NO",
        marginalTonsAt30to60: round((at60 - at30) / 30, 1),
        capacityAt30: round(at30),
        capacityAt60: round(at60),
        capacityAt100: round(at100),
      },
      calculation: `${curve} は飽和曲線であり、1人あたりの能力は人数によって変わる（逓減する）。30→60人の平均限界能力は約${round(
        (at60 - at30) / 30,
        1
      )} 工数トン/人。`,
      result:
        "ShrimpXには「営業1人＝何トン」という固定の能力パラメータは存在しない。営業能力は会社全体の飽和曲線で決まり、追加1人あたりの効果は人数が増えるほど逓減する。したがって単一の tons/person という数値では答えられない。",
      unit: "N/A",
      caveats: [
        "当期の売上高や成約量を営業人数で割った値は、営業能力ではなく実績値である。能力の代替値として提示してはいけない。",
        "実際の成約量は市場需要・提示価格・顧客信頼・品質・納期信頼性との競争で決まる。",
        "生産能力・原料・在庫が足りなければ、営業能力があっても納品できない。",
      ],
      currentApplication: "現在の営業人員数はbriefingにある。その人数を上の曲線へ代入した値が、その会社の現在の営業工数能力である。",
    });
  }

  // (c)「Nトン売るには営業何人？」
  if (targetTons !== null && /何人|必要|要る|いる|how many/i.test(question)) {
    const product = detectProduct(question) ?? "hoso";
    const coefficient = coefficients[product];
    const requiredEffort = targetTons * coefficient;
    const maxEffort = model.companyBaselineCapacityTons + model.companyCapacityMaxIncrementTons;
    const reachable = requiredEffort < maxEffort;
    const h = reachable
      ? (model.companyCapacitySaturationHeadcount * (requiredEffort - model.companyBaselineCapacityTons)) /
        (model.companyBaselineCapacityTons + model.companyCapacityMaxIncrementTons - requiredEffort)
      : null;
    answers.push({
      resolverId: "SALES_HEADCOUNT_FOR_TONS",
      questionIntent: "GAME_RULE",
      knowledgeIds,
      canonicalFacts: {
        targetTons,
        product,
        effortCoefficient: coefficient,
        requiredEffortTons: round(requiredEffort),
        requiredHeadcount: h === null ? "UNREACHABLE" : Math.ceil(h),
      },
      calculation: `必要営業工数 = ${targetTons}t × ${coefficient} = ${round(requiredEffort)} 工数トン。これを ${curve} について h で解く。`,
      result:
        h === null
          ? `必要な営業工数(${round(requiredEffort)})がこの曲線の漸近上限(${round(maxEffort)})を超えるため、営業人数をいくら増やしても営業能力だけでは到達できない。`
          : `${product.toUpperCase()} ${targetTons}t を扱うのに必要な営業人員は約${Math.ceil(h)}人（営業工数能力の観点のみ）。`,
      unit: "headcount",
      caveats: [
        "営業工数能力の観点だけの逆算であり、必要人数はこれで確定しない。",
        "市場需要が足りなければ人数を増やしても売れない。逆に競争力が高ければ少ない人数でも取れることがある。",
      ],
    });
  }

  return answers;
}

// ---------------------------------------------------------------------
// 2. Worker必要量（実装指示§5）
// ---------------------------------------------------------------------

function resolveWorkerRequirement(
  question: string,
  sources: GameKnowledgeParameterSources,
  context: { readonly previousProduct: Product | null; readonly previousTons: number | null; readonly previousAsksWorker: boolean }
): readonly ResolvedGameRuleAnswer[] {
  const explicitTons = firstNumber(question, TONS_PATTERN);
  const explicitProduct = detectProduct(question);
  // 【省略形への対応】「VAP 1,000tなら？」「VAPなら？」のような直前の質問を受けた
  // 省略表現でも、直前のturnで解決した商品・数量を引き継ぐ（実APIで実際に
  // 「VAP 1,000tなら？」がWorker質問と認識されず誤答した事象への対応）。
  const tons = explicitTons ?? context.previousTons;
  const product = explicitProduct ?? context.previousProduct;
  if (tons === null || product === null) return EMPTY;

  // 明示的にWorkerを問うている、または直前がWorker質問だった場合のみ。
  const asksWorker = isWorkerQuestion(question) || /何人|人必要|how many/i.test(question);
  // 直前がWorker質問だった場合、「VAP 1,000tなら？」のように商品・数量が揃っていても
  // Worker質問の続きである（実APIで誤答した実例）。
  const isFollowUp = explicitTons === null || explicitProduct === null || context.previousAsksWorker;
  if (!asksWorker && !isFollowUp) return EMPTY;
  // 営業の質問なら労務ではない。
  if (isSalesQuestion(question)) return EMPTY;

  const estimate = estimateWorkerRequirement(tons, product, sources);
  const labor = sources.production.labor;
  return [
    {
      resolverId: "WORKER_REQUIREMENT",
      questionIntent: "GAME_RULE",
      knowledgeIds: ["LABOR.WORKER_PRODUCTIVITY", "CAPACITY.POOL_SEMANTICS"],
      canonicalFacts: {
        product,
        quantityTons: tons,
        regularEfficiencyPerHeadTons: labor.regularEfficiencyPerHeadTons,
        laborIntensityCoefficient: labor.laborIntensityCoefficient[product],
        effectiveTonsPerHead: round(estimate.effectiveTonsPerHead, 2),
        baseRegularHeadcount: estimate.baseRegularHeadcount,
        withMaxOvertimeHeadcount: estimate.withMaxOvertimeHeadcount,
        overtimeRateCap: labor.overtimeRateCap,
      },
      calculation: `実効生産力 = ${labor.regularEfficiencyPerHeadTons} ÷ ${labor.laborIntensityCoefficient[product]} = ${round(
        estimate.effectiveTonsPerHead,
        2
      )} t/人/四半期。必要人数 = ${tons} ÷ ${round(estimate.effectiveTonsPerHead, 2)} = ${estimate.baseRegularHeadcount}人。`,
      result: `${product.toUpperCase()} ${tons}t の生産に必要な常用Workerは基準ケースで約${estimate.baseRegularHeadcount}人（残業を上限${
        labor.overtimeRateCap
      }まで使えば約${estimate.withMaxOvertimeHeadcount}人）。`,
      unit: "headcount",
      caveats: estimate.caveats,
      currentApplication:
        "現在の会社の総Worker数から必要人数を逆算してはいけない。上の基準生産力から求めた値が答えであり、現在人数はそれとの比較対象にすぎない。",
    },
  ];
}

// ---------------------------------------------------------------------
// 3. Timing resolver（実装指示§6）
// ---------------------------------------------------------------------

/** Turn N を基準にした確定タイムライン。Claudeにturn arithmeticを自由計算させない。 */
function resolveTiming(question: string, sources: GameKnowledgeParameterSources): readonly ResolvedGameRuleAnswer[] {
  const answers: ResolvedGameRuleAnswer[] = [];
  const wc = sources.finance.workingCapital;
  const importLead = sources.rawMaterials.imports.standardLeadTimeTurns;
  const asksTiming = /いつ|タイミング|when|何期|翌期|回収|入金|使える|届く|到着|支払/i.test(question);
  if (!asksTiming) return EMPTY;

  if (/売掛|AR\b|回収|入金|receivable/i.test(question)) {
    answers.push({
      resolverId: "TIMING_AR",
      questionIntent: "GAME_RULE",
      knowledgeIds: ["FINANCE.AR_SETTLEMENT"],
      canonicalFacts: { arCollectionQuarters: wc.arCollectionQuarters },
      calculation: `AR回収サイト = ${wc.arCollectionQuarters}四半期（全市場共通）。`,
      result: `Turn N に納品（履行）した売上の現金回収は Turn N+${wc.arCollectionQuarters} である。当四半期に履行した売上は当四半期中には現金化されない。`,
      unit: "quarters",
      caveats: [
        "Revenue / Operating Profit は発生主義で履行した四半期に計上される。現金はその次の四半期に入る。両者を混同しないこと。",
        "顧客信頼（Trust）や納期遵守率が回収時期を遅らせる仕組みはShrimpXに存在しない。",
      ],
      currentApplication: "「当四半期中に回収される」と「翌四半期に回収される」を同一回答内で併記してはいけない。正しいのは翌四半期である。",
    });
  }

  if (/輸入|import/i.test(question)) {
    answers.push({
      resolverId: "TIMING_IMPORT",
      questionIntent: "GAME_RULE",
      knowledgeIds: ["PROCUREMENT.IMPORT_TIMING", "PROCUREMENT.TERMINOLOGY"],
      canonicalFacts: { standardLeadTimeTurns: importLead, apImportPaymentQuarters: wc.apImportPaymentQuarters },
      calculation: `発注 Turn N → 現金 Turn N+${wc.apImportPaymentQuarters} → 到着 Turn N+${importLead} → 生産に使える Turn N+${importLead}。`,
      result: `Turn N に発注した輸入原料が生産に使えるのは Turn N+${importLead} である（標準リードタイム ${importLead} 四半期）。発注した四半期には使えない。`,
      unit: "quarters",
      caveats: [
        "到着前の輸送中（in transit）在庫は生産に使えない。",
        `現金の支出は発注から ${wc.apImportPaymentQuarters} 四半期後であり、使える時期とは一致しない。`,
      ],
    });
  }

  if (/国内|domestic|買付/i.test(question)) {
    answers.push({
      resolverId: "TIMING_DOMESTIC",
      questionIntent: "GAME_RULE",
      knowledgeIds: ["PROCUREMENT.DOMESTIC_TIMING"],
      canonicalFacts: { apDomesticPaymentQuarters: wc.apDomesticPaymentQuarters },
      calculation: `買付 Turn N → 現金 Turn N（サイト${wc.apDomesticPaymentQuarters}） → 生産に使える Turn N。`,
      result: "Turn N に買い付けた国内原料は Turn N の生産にそのまま使える（リードタイムなし）。現金も同じ四半期に出る。",
      unit: "quarters",
      caveats: ["希望量が必ず取れるわけではない。国内市場の供給総量に対して5社が提示価格と調達カバレッジで競争し、配分される。"],
    });
  }

  if (/養殖|aquaculture|池入/i.test(question)) {
    answers.push({
      resolverId: "TIMING_AQUACULTURE",
      questionIntent: "GAME_RULE",
      knowledgeIds: ["PROCUREMENT.AQUACULTURE_TIMING"],
      canonicalFacts: { harvestLagTurns: 1 },
      calculation: "池入れ Turn N → 収穫 Turn N+1 → 生産に使える Turn N+1。",
      result: "Turn N に池入れした自社養殖原料が収穫・生産に使えるのは Turn N+1 である。",
      unit: "quarters",
      caveats: ["収穫量は池入れ量そのものではない。養殖強度・疾病圧力・バイオセキュリティで変動するため、入手量は不確実である。"],
    });
  }

  if (/capex|設備投資|投資|増設|新工場/i.test(question)) {
    answers.push({
      resolverId: "TIMING_CAPEX",
      questionIntent: "GAME_RULE",
      knowledgeIds: ["CAPEX.PROJECT_SEMANTICS"],
      canonicalFacts: { effectFromTurn: "COMPLETION_TURN" },
      calculation: "提案 Turn N → 承認 → 建設（必要四半期数にわたり分割払い）→ 完成 → その四半期から能力として使える。",
      result: "設備投資を決定した四半期には能力は増えない。能力が増えるのは案件が完成した四半期からである（必要四半期数は案件種別ごとのparameterで決まる）。",
      unit: "quarters",
      caveats: ["支払いができなかった四半期は建設が進まない。", "工場スペースに余地が無ければ増設案件は却下される。"],
    });
  }

  return answers;
}

// ---------------------------------------------------------------------
// 4. Capacity pools（実装指示§8）
// ---------------------------------------------------------------------

function resolveCapacityPools(question: string): readonly ResolvedGameRuleAnswer[] {
  if (!/能力|capacity|工場|満杯|天井|ボトルネック|bottleneck/i.test(question)) return EMPTY;
  return [
    {
      resolverId: "CAPACITY_POOLS",
      questionIntent: "GAME_RULE",
      knowledgeIds: ["CAPACITY.POOL_SEMANTICS", "LABOR.UTILIZATION_SEMANTICS"],
      canonicalFacts: {
        pools: "common processing / HOSO line / PD line / VAP line / freezing-packaging (flow) / cold storage (stock)",
        bottleneckRule: "min(raw material, common processing, freezing-packaging, product line, labor)",
      },
      calculation: "実際に作れる量 = 原料・共通前処理・凍結包装・商品ライン・労働 の各段階の最小値（ボトルネック）。",
      result:
        "生産能力は単一の数値ではなく、複数の別プール（共通前処理 / HOSO・PD・VAPの商品ライン / 凍結包装のフロー能力 / 冷蔵保管のストック能力）で構成される。商品ライン能力の合計は会社全体の天井ではない。共通前処理がボトルネックなら、ライン能力に余力があっても作れない。",
      unit: "N/A",
      caveats: [
        "product-line capacity の合計を company-wide capacity ceiling と呼んではいけない。",
        "凍結・包装能力（四半期あたりの処理量＝フロー）と冷蔵保管能力（同時保管量＝ストック）は別概念である。",
        "設備稼働率と労働稼働率は別指標である。「工場は満杯か」にはどのプール・どちらの制約かを区別して答える。",
      ],
      currentApplication: "現在の各プールの能力値と稼働率はbriefingにある。天井を1つの数値で語らず、どのプールが制約かを述べること。",
    },
  ];
}

// ---------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------

export interface ResolveGameRulesInput {
  readonly question: string;
  /** 直前の会話で解決済みの商品・数量（省略形の質問を解決するために使う）。 */
  readonly previousProduct?: Product | null;
  readonly previousTons?: number | null;
  /** 直前の会話がWorker（生産人員）の質問だったか。省略形の追問を解決するために使う。 */
  readonly previousAsksWorker?: boolean;
  readonly parameters?: GameKnowledgeParameterSources;
}

/**
 * 質問文から、server側で確定できるゲームルールの答えをすべて返す。
 * 該当が無ければ空配列（無理に答えを作らない＝実装指示§11）。
 */
export function resolveGameRuleAnswers(input: ResolveGameRulesInput): readonly ResolvedGameRuleAnswer[] {
  const sources = input.parameters ?? DEFAULT_GAME_KNOWLEDGE_PARAMETERS;
  const question = input.question;
  const context = {
    previousProduct: input.previousProduct ?? null,
    previousTons: input.previousTons ?? null,
    previousAsksWorker: input.previousAsksWorker ?? false,
  };
  return [
    ...resolveSalesCapacity(question, sources),
    ...resolveWorkerRequirement(question, sources, context),
    ...resolveTiming(question, sources),
    ...resolveCapacityPools(question),
  ];
}

/** 会話履歴から、省略形の質問を解決するための直前の商品・数量を拾う。 */
export function extractRecentProductQuantity(
  recentTexts: readonly string[]
): { readonly previousProduct: Product | null; readonly previousTons: number | null; readonly previousAsksWorker: boolean } {
  const previousAsksWorker = recentTexts.some((t) => isWorkerQuestion(t) || /何人|人必要/i.test(t));
  for (let i = recentTexts.length - 1; i >= 0; i--) {
    const text = recentTexts[i];
    const product = detectProduct(text);
    const tons = firstNumber(text, TONS_PATTERN);
    if (product !== null && tons !== null) return { previousProduct: product, previousTons: tons, previousAsksWorker };
  }
  // 商品だけ・数量だけでも拾えるなら拾う（片方は現在の質問側にあることが多い）。
  let previousProduct: Product | null = null;
  let previousTons: number | null = null;
  for (let i = recentTexts.length - 1; i >= 0; i--) {
    previousProduct = previousProduct ?? detectProduct(recentTexts[i]);
    previousTons = previousTons ?? firstNumber(recentTexts[i], TONS_PATTERN);
    if (previousProduct !== null && previousTons !== null) break;
  }
  return { previousProduct, previousTons, previousAsksWorker };
}
