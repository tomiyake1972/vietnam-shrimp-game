// ShrimpX V2 — 商品戦略プロファイル investment overlay（companyLab検証専用・2026-08-01新規）
//
// 【既知のギャップへの対応】productDevelopmentState.ts の更新関数
// updateProductDevelopmentState は「会社別の当期投資額」を受け取れる形に既に
// 対応済みだが、実際の呼び出し元（companyLab/runner.ts）は常に空Map（投資額0）で
// 呼び出しており、実額を投入する経路がどこにも存在しなかった
// （runner.ts該当箇所のコメント「未接続の入力チャネル・要フォローアップ」参照）。
//
// 【本ファイルの責務】会社の商品戦略プロファイル（standardAi/strategyProfile.ts）が
// VAP商品開発投資（investmentOverlay.vapProductDevelopment）を要求する場合にのみ、
// 妥当な四半期あたり投資額を計算する。金額の根拠は
// PRODUCT_DEVELOPMENT_PARAMETERS_V1.standardBudgetUsd（productDevelopmentState.tsが
// 既に定義している「標準投資額＝投資ゲインが基準速度になる額」）をそのまま使う
// （新しい金額の物差しを発明しない）。
//
// 【調達規模効果（HOSO_SCALE）との非対称性】procurementScaleState.tsは購入量
// （トン）を入力とする既存の移動平均メカニズムであり、$投資ではなく購入行動その
// ものから継続的な規模効果を蓄積する設計のため、HOSO_SCALE戦略には対応する
// $投資チャネルを追加しない（strategyProfile.tsのHOSO_SCALE定義・コメント参照）。
//
// 【呼び出し元】companyLab/runner.ts の productDevelopmentState 四半期末更新
// 呼び出し（state.config.sai5?.vapDifferentiation ? updateProductDevelopmentState(...) ）
// のinvestmentAmountByCompanyUsd引数。config.strategyProfilesEnabled有効時のみ
// このファイルの結果を渡し、未指定なら従来どおり空Map（既存挙動とビット単位で一致）。

import { CompanyId } from "../sales/types";
import { resolveStrategyProfile } from "./standardAi/strategyProfile";

/**
 * 【2026-08-01調整】当初は1.0倍（standardBudgetUsdそのもの）だったが、4環境×6seed×
 * 32Qの実測検証で、この投資チャネルが実際に費消する現金（$400,000/四半期×32 =
 * 累計$12.8M、環境非依存の固定コスト）に対し、それが押し上げるVAP能力係数
 * （premiumPolicy.tsのcalculateCompanyRealizedVapPremiumRatio）は
 * decision/sales.tsのorderQuantityFactor（受注量係数、[0,1.1]でクランプ）経由でしか
 * 使われず、市場VAPプレミアムが目標水準に近い/上回っている限り実質的に飽和して
 * ほぼ効果が出ない（実測: VAP社のVAP商品貢献利益/tはBALANCED社とほぼ同一、例
 * VAP_TAILWINDで$4,070.8 vs $4,076.4/t）ことが判明した。つまりこの投資は
 * 「効果がほとんど無いのに環境非依存の固定費だけがかかる」状態になっており、
 * VAP_DIFFERENTIATIONの累計利益を4環境すべてで平均以下へ押し下げる主因の一つ
 * だった。decision/sales.ts側の消費ロジックはこのタスクのスコープ外（decision/*.ts
 * 変更禁止）のため直接は直せないが、少なくとも「効果の薄い投資に払うコスト」を
 * 縮小することは本ファイルのスコープ内であるため、0.5倍（$200,000/四半期、
 * 累計$6.4M）へ引き下げる。VAP能力係数は投資額が半分でも複数四半期をかけて
 * 依然として上限近くへ収束する設計（idle decayとのバランス上、標準予算比0.5倍
 * でも定常状態のスコアはさほど下がらない）ため、能力面の意図はおおむね維持しつつ、
 * 固定費側の重荷だけを軽くする。
 */
const VAP_PRODUCT_DEVELOPMENT_INVESTMENT_RATIO = 0.5;

/**
 * 商品戦略プロファイルに基づく、会社別のVAP商品開発投資額（当四半期ぶん、USD）を
 * 計算する（純粋関数・決定論的）。投資額はstandardBudgetUsd ×
 * VAP_PRODUCT_DEVELOPMENT_INVESTMENT_RATIO（2026-08-01調整、旧1.0倍から0.5倍へ縮小）。
 * investmentOverlay.vapProductDevelopmentを要求しない戦略プロファイルの会社は
 * マップに含めない（＝投資額0、既存のidle decay挙動のまま）。
 */
export function computeStrategyProfileProductDevelopmentInvestment(
  companyIds: readonly CompanyId[],
  standardBudgetUsd: number
): ReadonlyMap<CompanyId, number> {
  const result = new Map<CompanyId, number>();
  for (const companyId of companyIds) {
    const profile = resolveStrategyProfile(companyId);
    if (profile.investmentOverlay.vapProductDevelopment) {
      result.set(companyId, standardBudgetUsd * VAP_PRODUCT_DEVELOPMENT_INVESTMENT_RATIO);
    }
  }
  return result;
}
