// ShrimpX V2 — Rule Answer Semantic Consistency Validator（Phase M2.8.1・実装指示§7）
//
// 【なぜ必要か】resolvedGameRules（server確定解答）をpromptへ渡しても、モデルが
// 同一回答内で「翌四半期に回収される」と「当四半期中に現金化される」を併記したり、
// 確定人数と桁違いの人数を書いたりする事象が実プレイで確認された。
// そこで、生成された日本語テキストをserver側でもう一度検査し、確定解答と矛盾する
// 記述が残っていれば1回だけrepairを要求する（既存のoverdue語彙guardと同じ手順）。
//
// 【設計方針】false positiveを出さないことを優先する。曖昧な表現は違反にしない。
// 検査するのは「確定解答が存在する項目」に限る（resolvedGameRulesが空なら何もしない）。

import { ResolvedGameRuleAnswer } from "./ruleResolver";

export interface RuleAnswerViolation {
  /** 監査・テスト用の安定したコード。 */
  readonly code: string;
  /** repair指示に載せる、何がどう矛盾しているかの説明。 */
  readonly message: string;
}

/** 全角数字・カンマ・空白を正規化して検査しやすくする。 */
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, "")
    .replace(/\s+/g, "");
}

function findResolver(resolved: readonly ResolvedGameRuleAnswer[], resolverId: string): ResolvedGameRuleAnswer | undefined {
  return resolved.find((r) => r.resolverId === resolverId);
}

/** 「52t/人」「1人当たり52トン」のような、営業1人当たり固定能力の断定を拾う。 */
const PER_PERSON_TONS_PATTERNS: readonly RegExp[] = [
  /(\d+(?:\.\d+)?)(?:t|トン|tons?)\/?(?:人|名)/i,
  /(?:1|一)人(?:当たり|あたり)[^。]{0,12}?(\d+(?:\.\d+)?)(?:t|トン|tons?)/i,
];

/** 当四半期中にARが現金化される、という誤りを拾う。 */
const AR_SAME_QUARTER_PATTERNS: readonly RegExp[] = [
  /(?:売掛|受取債権|AR)[^。]{0,40}?(?:当四半期中|今四半期中|当期中|同じ四半期(?:中|に|で))[^。]{0,20}?(?:回収|現金化|入金)/i,
  /(?:当四半期中|今四半期中|同じ四半期(?:中|に|で))[^。]{0,20}?(?:売掛|受取債権|AR)[^。]{0,20}?(?:回収|現金化|入金)/i,
];

/** 輸入原料が発注した四半期に使える、という誤りを拾う。 */
const IMPORT_SAME_QUARTER_PATTERNS: readonly RegExp[] = [
  /(?:輸入)[^。]{0,60}?(?:発注|オーダー)[^。]{0,30}?(?:同じ四半期|同一四半期|当四半期)[^。]{0,20}?(?:使え|利用|投入|到着|入荷)/i,
  /(Q[1-4]|Turn\d+)(?:に)?(?:発注|オーダー)[^。]{0,20}?\1(?:に|から)[^。]{0,12}?(?:使え|利用|投入|入荷|到着)/i,
];

/** 商品ライン能力の単純合計を全社の天井として断定する誤りを拾う。 */
const LINE_SUM_CEILING_PATTERNS: readonly RegExp[] = [
  /(?:ライン|製品ライン|商品ライン)[^。]{0,30}?(?:合計|総計|足し合わせ|合算)[^。]{0,30}?(?:全社|会社全体|当社)[^。]{0,20}?(?:上限|天井|能力の限界|生産能力)/i,
  /(?:全社|会社全体)[^。]{0,20}?(?:生産能力|能力)(?:の)?(?:上限|天井)[^。]{0,20}?(?:ライン|製品ライン|商品ライン)[^。]{0,20}?(?:合計|総計|合算)/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * 実装指示§7。生成テキストと確定解答の矛盾を検出する。
 * 違反が無ければ空配列。
 */
export function findRuleAnswerViolations(
  texts: readonly string[],
  resolved: readonly ResolvedGameRuleAnswer[]
): readonly RuleAnswerViolation[] {
  if (resolved.length === 0) return [];
  const violations: RuleAnswerViolation[] = [];
  const joined = normalize(texts.join("\n"));

  // (1) 営業1人当たり固定トン数の捏造（存在しないルール）。
  const perPerson = findResolver(resolved, "SALES_CAPACITY_PER_PERSON");
  if (perPerson && matchesAny(joined, PER_PERSON_TONS_PATTERNS)) {
    violations.push({
      code: "SALES_PER_PERSON_FIXED_CAPACITY",
      message:
        "「営業1人当たり◯トン」という固定能力値を提示していますが、ShrimpXにそのパラメータは存在しません。" +
        "営業能力は会社全体の飽和曲線で決まり、1人当たりの効果は人数とともに逓減します。実績を人数で割った値を能力として提示しないでください。",
    });
  }

  // (2) 営業能力の確定値と異なる数値を能力として書いていないか。
  const salesAt = findResolver(resolved, "SALES_CAPACITY_AT_HEADCOUNT");
  if (salesAt) {
    const canonical = Number(salesAt.canonicalFacts.salesEffortCapacityTonsPerQuarter);
    if (Number.isFinite(canonical) && !joined.includes(String(Math.round(canonical)))) {
      violations.push({
        code: "SALES_CAPACITY_CANONICAL_MISSING",
        message:
          `server側で確定した営業工数能力 ${Math.round(canonical)} 工数トン/四半期 が回答に含まれていません。` +
          "この確定値をそのまま提示してください（別の数値へ計算し直さないでください）。",
      });
    }
  }

  // (3) 必要Worker人数が確定値と乖離していないか。
  const worker = findResolver(resolved, "WORKER_REQUIREMENT");
  if (worker) {
    const base = Number(worker.canonicalFacts.baseRegularHeadcount);
    const withOt = Number(worker.canonicalFacts.withMaxOvertimeHeadcount);
    const mentionsCanonical = [base, withOt].some((v) => Number.isFinite(v) && joined.includes(String(Math.round(v))));
    if (!mentionsCanonical) {
      violations.push({
        code: "WORKER_HEADCOUNT_CANONICAL_MISSING",
        message:
          `server側で確定した必要Worker数（基準 ${base}人 / 残業上限まで使う場合 ${withOt}人）が回答に含まれていません。` +
          "この確定値をそのまま提示し、独自に人数を計算し直さないでください。",
      });
    }
  }

  // (4) AR回収タイミングの自己矛盾。
  if (findResolver(resolved, "TIMING_AR") && matchesAny(joined, AR_SAME_QUARTER_PATTERNS)) {
    violations.push({
      code: "AR_TIMING_CONTRADICTION",
      message:
        "売掛金が当四半期中に現金化されるかのような記述があります。ShrimpXのAR回収サイトは1四半期であり、" +
        "Turn N に履行した売上の入金は Turn N+1 です。発生主義の売上計上時期と現金回収時期を混同しないでください。",
    });
  }

  // (5) 輸入リードタイムの自己矛盾。
  if (findResolver(resolved, "TIMING_IMPORT") && matchesAny(joined, IMPORT_SAME_QUARTER_PATTERNS)) {
    violations.push({
      code: "IMPORT_TIMING_CONTRADICTION",
      message:
        "輸入原料が発注した四半期に使えるかのような記述があります。標準リードタイムは2四半期であり、" +
        "Turn N の発注が生産に使えるのは Turn N+2 です。turn計算を独自に組み立てず、確定解答をそのまま使ってください。",
    });
  }

  // (6) 商品ライン能力の単純合計を全社の天井として提示していないか。
  if (findResolver(resolved, "CAPACITY_POOLS") && matchesAny(joined, LINE_SUM_CEILING_PATTERNS)) {
    violations.push({
      code: "LINE_SUM_AS_COMPANY_CEILING",
      message:
        "商品ライン能力の合計を全社の生産能力上限として提示しています。実際の上限は原料・共通前処理・凍結包装・" +
        "商品ライン・労働のうち最も制約となるプールで決まります。どのプールが制約かを述べてください。",
    });
  }

  return violations;
}

/**
 * 実装指示§10。GAME_RULE系の質問で該当Knowledgeを注入したのに、
 * 応答がそのidを1つも参照していない場合を検出する。
 */
export function findKnowledgeUsageViolation(input: {
  readonly questionIntent: string;
  readonly injectedIds: readonly string[];
  readonly knowledgeUsedIds: readonly string[];
}): RuleAnswerViolation | null {
  // 【範囲を GAME_RULE に限定する理由】MIXEDは「マーカーがどれも無い質問」の既定値でもあり、
  // 通常の相談・戦略質問まで含んでしまう。そこまでrepair対象にするとAPI呼び出しが
  // 恒常的に2倍になる。実装指示§10が求めているのは「ルールを聞かれたのに提供された
  // ルールを使わなかった場合」なので、intentがGAME_RULEのときだけ違反とする。
  if (input.questionIntent !== "GAME_RULE") return null;
  if (input.injectedIds.length === 0) return null;
  if (input.knowledgeUsedIds.length > 0) return null;
  return {
    code: "KNOWLEDGE_NOT_USED",
    message:
      `この質問にはShrimpXの公式ルール（${input.injectedIds.slice(0, 6).join(" / ")}）が提供されています。` +
      "それらを根拠にして回答し、参照したidをknowledgeUsedIdsに必ず記録してください。" +
      "briefingの実績値から独自にルールを逆算して答えてはいけません。",
  };
}

/** 検出した違反からrepair指示文を作る（既存のrepairNote経路にそのまま載せる）。 */
export function buildRuleAnswerRepairNote(violations: readonly RuleAnswerViolation[]): string {
  return (
    "直前の回答に、ShrimpXの確定ルールと矛盾する記述がありました。以下を訂正して回答し直してください。\n" +
    violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join("\n")
  );
}
