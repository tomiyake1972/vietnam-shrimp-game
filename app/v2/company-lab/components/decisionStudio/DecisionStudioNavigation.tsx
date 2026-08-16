// ShrimpX V2 — Decision Studio Navigation（7タブ、ウィザードではなく自由往復）
//
// タブを押すだけで画面を切り替える。フォームの送信や検証をまたいで次のタブへ
// 進む、という制約は一切持たない（Sales→Production→Salesのように自由に往復できる）。
// 現在位置は選択中タブのハイライトで示す。

export type DecisionStudioScreenKey = "info" | "sales" | "production" | "worker" | "procurement" | "investment" | "finance";

export interface DecisionStudioNavigationItem {
  readonly key: DecisionStudioScreenKey;
  readonly label: string;
  /** タブ右肩に出す小さな注意バッジ（例: 警告件数）。0以下・undefinedなら表示しない。 */
  readonly badgeCount?: number;
}

const NAV_ITEMS: readonly DecisionStudioNavigationItem[] = [
  { key: "info", label: "INFO" },
  { key: "sales", label: "SALES" },
  { key: "production", label: "PRODUCTION" },
  { key: "worker", label: "WORKER" },
  { key: "procurement", label: "PROCUREMENT" },
  { key: "investment", label: "INVESTMENT" },
  { key: "finance", label: "FINANCE" },
];

interface DecisionStudioNavigationProps {
  readonly active: DecisionStudioScreenKey;
  readonly onSelect: (key: DecisionStudioScreenKey) => void;
  /** タブごとのバッジ件数（例: { sales: 1, production: 3 }）。省略したタブはバッジ無し。 */
  readonly badgeCounts?: Readonly<Partial<Record<DecisionStudioScreenKey, number>>>;
}

export default function DecisionStudioNavigation({ active, onSelect, badgeCounts }: DecisionStudioNavigationProps) {
  return (
    <nav
      className="flex flex-wrap gap-1 border-b border-gray-700 sticky top-0 z-10 bg-gray-950/95 backdrop-blur px-1 py-1"
      data-testid="decision-studio-navigation"
      role="tablist"
      aria-label="Decision Studio"
    >
      {NAV_ITEMS.map((item) => {
        const isActive = item.key === active;
        const badgeCount = badgeCounts?.[item.key] ?? 0;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`decision-studio-tab-${item.key}`}
            onClick={() => onSelect(item.key)}
            className={`relative px-3 py-2 text-xs font-semibold rounded-t-lg transition-colors ${
              isActive ? "bg-gray-800 text-gray-50 border-t border-x border-gray-600" : "text-gray-400 hover:text-gray-200 hover:bg-gray-900/60"
            }`}
          >
            {item.label}
            {badgeCount > 0 && (
              <span
                className="ml-1.5 inline-flex items-center justify-center rounded-full bg-amber-600 text-white text-[10px] leading-none px-1.5 py-0.5"
                data-testid={`decision-studio-tab-badge-${item.key}`}
              >
                {badgeCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
