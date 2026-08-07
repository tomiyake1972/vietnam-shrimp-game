// ShrimpX V2 — 会社経営統合テスト環境 品質ダッシュボード（Phase 7B） 2. 警告表示
//
// dashboardWarnings.buildWarningsが判定した表示専用の警告一覧をそのまま並べる。
// 経済ロジックには一切影響しない、表示専用コンポーネント。

import { WarningViewModel } from "../dashboardWarnings";

interface QualityWarningsListProps {
  readonly warnings: readonly WarningViewModel[];
}

const SEVERITY_STYLE: Record<string, string> = {
  重大: "bg-red-950/70 border-red-600 text-red-200",
  警戒: "bg-amber-950/70 border-amber-600 text-amber-200",
  注意: "bg-yellow-950/50 border-yellow-700/60 text-yellow-200",
};

export default function QualityWarningsList(props: QualityWarningsListProps) {
  const { warnings } = props;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-2">
      <h3 className="text-base font-semibold text-gray-100">警告</h3>
      {warnings.length === 0 ? (
        <p className="text-xs text-gray-500">当期は警告に該当する操業リスクはありません。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {warnings.map((w) => (
            <div key={w.key} className={`rounded-lg border px-3 py-1.5 text-xs flex items-center gap-2 ${SEVERITY_STYLE[w.severity] ?? SEVERITY_STYLE["注意"]}`}>
              <span className="font-semibold shrink-0">［{w.severity}］{w.label}</span>
              <span className="text-[11px]">{w.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
