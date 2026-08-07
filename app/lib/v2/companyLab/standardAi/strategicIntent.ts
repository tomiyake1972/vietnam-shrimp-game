// ShrimpX V2 — Standard AI Strategic Intent（2026-08-05新設）
//
// 【三宅さんご指示・今回の中心方針】Standard AIに「この会社は、そもそもどの程度の
// 規模を目指しているのか」という経営上の目安（Strategic Intent）を持たせる。
// これは「8期先の市場を精密予測するAI」を作るためのものではなく、「8期程度先の
// 会社像を定め、そこへ向けて主として今後4期程度の能力整合性を確認するAI」を
// 作るための土台である。
//
// 【スコープ】今回はStandard AI共通の単一のStrategicIntent（BALANCED_GROWTH）を
// 実装する。将来、会社別の経営性格（managementProfile.tsが既に持つ差し込み口と
// 同様の設計）や、AI Management Meetingでの動的更新へ拡張できるよう、構造体は
// 独立したモジュールとして持つ（policy.ts側で単純に差し替えられる）。
// 動的なMVV文章生成・自由文からの戦略決定は今回のスコープ外（三宅さんご指示§19）。

/** 会社の中期的な成長姿勢。 */
export type StrategicGrowthPosture = "DEFENSIVE" | "BALANCED_GROWTH" | "AGGRESSIVE_GROWTH";

/** 商品方向性（現時点ではTarget Scale算定への直接反映はせず、将来拡張の受け皿として保持）。 */
export type StrategicProductDirection = "HOSO_FOCUSED" | "PD_FOCUSED" | "VAP_FOCUSED" | "BALANCED";

/** 市場集中度（同上、将来拡張の受け皿）。 */
export type StrategicMarketConcentration = "DIVERSIFIED" | "FOCUSED";

/** 財務姿勢（同上、将来拡張の受け皿。現時点ではliquidity gate自体は既存のまま）。 */
export type StrategicFinancialPosture = "CASH_PRESERVATION" | "BALANCED" | "LEVERAGE_ACCEPTING";

/**
 * 会社の中期経営方針（機械判定可能な構造体）。三宅さんご指示のtype定義をそのまま
 * 採用し、命名規則のみ既存ファイル（parameters.ts等）に合わせてある。
 */
export interface StrategicIntent {
  readonly growthPosture: StrategicGrowthPosture;
  readonly productDirection: StrategicProductDirection;
  readonly marketConcentration: StrategicMarketConcentration;
  readonly financialPosture: StrategicFinancialPosture;
  /** 「8期程度先」を見据える、という方針上の地平線（四半期数）。精密予測の対象期間ではない。 */
  readonly targetHorizonQuarters: number;
}

/**
 * Standard AI共通のBalanced Growth（既定値）。今回はこれを全社一律で使う。
 * 将来、会社別性格・AI難易度・経営戦略へ差し替える場合は、この定数を注入するだけで
 * 済むよう、targetScale.ts / salesForceHiring.ts はStrategicIntentを引数として
 * 受け取る形にしている（会社IDによる分岐をロジック内部へ持ち込まない）。
 */
export const BALANCED_GROWTH_STRATEGIC_INTENT_V1: StrategicIntent = {
  growthPosture: "BALANCED_GROWTH",
  productDirection: "BALANCED",
  marketConcentration: "DIVERSIFIED",
  financialPosture: "BALANCED",
  targetHorizonQuarters: 8,
};

/** 現時点でのStandard AI共通StrategicIntent（全社一律）。policy.tsが参照する既定値。 */
export const STANDARD_AI_STRATEGIC_INTENT_V1: StrategicIntent = BALANCED_GROWTH_STRATEGIC_INTENT_V1;
