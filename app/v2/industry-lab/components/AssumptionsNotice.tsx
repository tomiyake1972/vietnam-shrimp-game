// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 暫定前提の明示
//
// 実装指示 §5「画面にも『会社意思決定未接続の暫定前提』であることを表示する」
// に対応する。

import { INDUSTRY_LAB_ASSUMPTIONS_V1 } from "../../../lib/v2/industryLab";

export default function AssumptionsNotice() {
  return (
    <details className="bg-amber-950/40 border border-amber-700/50 rounded-lg px-4 py-3 text-xs sm:text-sm text-amber-200">
      <summary className="cursor-pointer font-semibold text-amber-300">
        ⚠️ 会社意思決定未接続の暫定前提（校正前）— クリックして詳細を表示
      </summary>
      <div className="mt-2 space-y-1.5 leading-relaxed">
        <p>
          販売・5社の調達意思決定・海外生産者の価格反応はまだ実装されていません。以下は、市場計算に必要だが
          現時点のゲームからは取得できない入力を仮置きした結果です（パラメータバージョン:{" "}
          <code className="bg-amber-900/50 px-1 rounded">{INDUSTRY_LAB_ASSUMPTIONS_V1.parametersVersion}</code>）。
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            ベトナム国内調達希望量（5社＋NPC集計値）: ターン1はシナリオの初期値をそのまま使用。ターン2以降は
            「直近実績（過去4四半期）の国内買付移動平均 ×{" "}
            {INDUSTRY_LAB_ASSUMPTIONS_V1.domesticProcurementIntentToTrailingAverageRatio}」という単純な仮定（会社は直近と同水準を
            買うつもりでいる、という代替）。
          </li>
          <li>過去4四半期の国内買付平均: シナリオモジュールが実際の市場結果（フィードバック）から算出（新規の仮置きではありません）。</li>
          <li>初期の前期HOSO価格・初期需要: シナリオの前史データ（2〜4年分）から取得（新規の仮置きではありません）。</li>
          <li>PD・VAP需要構成: シナリオモジュールの既存パラメータ（地域別需要合計に対する固定シェア）から按分（新規の仮置きではありません）。</li>
          <li>海外生産者の価格反応: 記録用の型（ScenarioTurnFeedback.externalProducerResponses）のみ用意し、次期の供給計算へは未反映です。</li>
        </ul>
      </div>
    </details>
  );
}
