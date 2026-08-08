// ShrimpX V2 — 相談役AI  質問の分類とretrieval strategy（実装指示§39・§50）
//
// 【なぜ決定論的な分類にするか】
// 「どの情報を取ってくるか」をClaudeに決めさせると、(a) 毎回全部を詰め込むか、
// (b) 判断がぶれてcontextが再現しなくなる。ここではキーワードによる決定論的な分類にし、
// 「PLの質問なら財務、仕様の質問なら正式仕様、なぜの質問なら開発文書」を機械的に決める。
//
// 【誤分類について】キーワード一致であるため誤分類はありうる。そのため
//   ・分類は「どれを必ず含めるか」を決めるだけで、他を禁止しない
//   ・LIVE GAME STATE と STANDARD AI STATE は常に含める（会社の相談が主用途のため）
//   ・質問原文は必ず保存する（Harness側で再分類できるようにする）
// という設計にしてある。

/** 会話ログの分析用カテゴリ（実装指示§50）。 */
export type AdvisorQuestionCategory =
  | "MANAGEMENT"
  | "STANDARD_AI_REVIEW"
  | "GAME_DESIGN"
  | "DEVELOPMENT_HISTORY"
  | "HOW_TO_PLAY"
  | "COMPETITOR_ANALYSIS"
  | "OTHER";

/** どの情報層を取得するか（実装指示§9の4層 + 競合）。 */
export interface AdvisorRetrievalPlan {
  readonly category: AdvisorQuestionCategory;
  /** A. LIVE GAME STATE。常にtrue（会社の相談が主用途）。 */
  readonly includeLiveGameState: true;
  /** A. のうち財務三表（PL/BS/CF）を厚く含めるか。 */
  readonly includeFinancialStatements: boolean;
  /** B. STANDARD AI STATE。常にtrue（Standard AIの評価が主用途の1つ）。 */
  readonly includeStandardAiState: true;
  /** A. のうち他社サマリー・ゲーム内部の真値（Owner Modeのみ）。 */
  readonly includeCompetitorAndInternal: boolean;
  /** C. FORMAL GAME SPECIFICATION。 */
  readonly includeFormalSpecification: boolean;
  /** D. DEVELOPMENT KNOWLEDGE。 */
  readonly includeDevelopmentKnowledge: boolean;
  /** D. のうち古い資料も対象にするか（過去経緯の質問のみ）。 */
  readonly includeHistoricalDocuments: boolean;
  /** 文書検索に使うクエリ（MVPでは質問文そのもの）。 */
  readonly documentQuery: string;
}

const MARKERS = {
  standardAi: ["standard ai", "standardai", "スタンダード", "aiの提案", "aiの判断", "ai提案", "提案どう", "判断は妥当", "見落とし", "reason code", "理由コード", "診断"],
  gameDesign: ["ゲーム環境", "不自然", "おかしくない", "厳しすぎ", "バランス", "設計に問題", "訓練環境", "仕様なの", "この仕様", "設計判断", "簡略化", "抽象化", "現実と", "リアル", "計算しなくて", "入力させ", "省略", "エンジン内部", "自動で"],
  developmentHistory: ["開発記録", "開発日誌", "development diary", "過去の開発", "経緯", "いつ変更", "どの記録", "どこに書いて", "昔の", "旧仕様", "以前は", "変更履歴", "manual", "マニュアル", "パラメータ文書"],
  howToPlay: ["何をすれば", "何を学ぶ", "学ぶため", "どう遊", "初めて", "初心者", "最初にどこ", "遊び方", "プレイすれば", "わからない", "分からない", "どういう考え方"],
  competitor: ["mass", "他社", "競合", "比較して", "との違い", "他の会社", "ライバル"],
  /** ゲーム内部の真の値を求める質問（Owner Modeでのみ開示する）。 */
  internalTruth: ["内部の", "ゲーム内部", "真の", "本当の需要", "実際の需要", "裏側", "エンジンの値"],
  financial: ["pl", "bs", "cf", "損益", "貸借", "キャッシュ", "資金", "利益", "赤字", "黒字", "財務", "原価", "コスト", "現金", "借入", "債務"],
  /**
   * 「なぜ」系。仕様・設計の理由を問う質問は必ず文書を引く必要があるが、
   * gameDesignのキーワードだけでは取りこぼす（例:「なぜ歩留まりを細かく自分で
   * 計算しなくていいの？」は"なぜ"以外に設計語を含まない場合がある）。
   * ただし「なぜ営業を9人採るの？」のようにStandard AIの判断を問う質問も同じ語を
   * 含むため、standardAiに一致する場合は文書検索の対象にしない（下のneedsDocs参照）。
   */
  why: ["なぜ", "なんで", "どうして", "理由は", "何のため"],
} as const;

function includesAny(haystack: string, markers: readonly string[]): boolean {
  return markers.some((m) => haystack.includes(m));
}

/**
 * 質問文からretrieval planを決める。純粋関数・決定論的。
 * ownerMode=falseの場合、競合・ゲーム内部の真値は常にfalseになる
 * （将来のPlayer Mode向けのpermission boundary。実装指示§46）。
 */
export function planRetrieval(question: string, options: { readonly ownerMode: boolean }): AdvisorRetrievalPlan {
  const q = question.toLowerCase();

  const hitsDevelopment = includesAny(q, MARKERS.developmentHistory);
  const hitsGameDesign = includesAny(q, MARKERS.gameDesign);
  const hitsHowToPlay = includesAny(q, MARKERS.howToPlay);
  const hitsStandardAi = includesAny(q, MARKERS.standardAi);
  const hitsCompetitor = includesAny(q, MARKERS.competitor);
  const hitsFinancial = includesAny(q, MARKERS.financial);
  const hitsInternalTruth = includesAny(q, MARKERS.internalTruth);
  const hitsWhy = includesAny(q, MARKERS.why);

  // カテゴリは1つに決める（ログ分析用）。優先順位は「開発履歴 > ゲーム設計 > 遊び方 >
  // Standard AI評価 > 競合 > 経営」。開発履歴を最優先にするのは、
  // 「なぜこの仕様？」を経営相談として処理してしまうと開発文書を引かなくなるため。
  let category: AdvisorQuestionCategory = "MANAGEMENT";
  if (hitsDevelopment) category = "DEVELOPMENT_HISTORY";
  else if (hitsGameDesign) category = "GAME_DESIGN";
  else if (hitsHowToPlay) category = "HOW_TO_PLAY";
  else if (hitsStandardAi) category = "STANDARD_AI_REVIEW";
  else if (hitsCompetitor) category = "COMPETITOR_ANALYSIS";

  // 「なぜ」系のうち、Standard AIの判断を問うものではないものは、仕様・設計の理由を
  // 問うている可能性が高いので文書を引く（§55 Q10「なぜ歩留まりを細かく自分で
  // 計算しなくていいの？」のような、設計語を含まない質問を取りこぼさないため）。
  const whyAboutDesign = hitsWhy && !hitsStandardAi;
  const needsDocs = hitsDevelopment || hitsGameDesign || hitsHowToPlay || whyAboutDesign;

  // 「なぜ」系で他に何も一致しなかった場合、経営の質問ではなくゲーム設計の質問として扱う。
  if (category === "MANAGEMENT" && whyAboutDesign) category = "GAME_DESIGN";

  return {
    category,
    includeLiveGameState: true,
    includeFinancialStatements: hitsFinancial || category === "MANAGEMENT",
    includeStandardAiState: true,
    includeCompetitorAndInternal: options.ownerMode && (hitsCompetitor || hitsGameDesign || hitsInternalTruth),
    includeFormalSpecification: needsDocs,
    includeDevelopmentKnowledge: needsDocs,
    // 過去経緯を明示的に聞かれた場合だけ古い資料を対象にする。
    includeHistoricalDocuments: hitsDevelopment,
    documentQuery: question,
  };
}
