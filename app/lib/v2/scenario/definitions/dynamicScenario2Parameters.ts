// ShrimpX V2 — Dynamic Scenario 2 の数値候補（Phase 2A）
//
// DS2 が DS1 から変える数値をここへ集める。現時点は MASS の初期借入のみ。

import { InitialCompanyDebtOverride } from "../types";

/**
 * 会社別の初期借入（USD）の上書き。
 *
 * 【MASS】共有フィクスチャでは短期 35M ＋ 長期 45M ＝ 80M で、5社中最大の借入を
 * 背負って始まる（最大の固定資産を持つ設備先行投資型という設定のため）。DS1 の
 * 32ターンテストでは、この利払いと元本返済が序盤の現金を圧迫し、原料調達が
 * 細り、赤字が固定化する流れが見えた。借入の重さが単独でどれだけ効いているかを
 * 測るため、短期・長期を同じ比率で半分にして合計 40M とする。
 *
 * 短期／長期の比率（35:45）を保ったのは、返済スケジュールと金利構成の性格を
 * 変えずに「金額だけ」を動かして寄与を切り分けたいから。
 *
 * ここに載せない会社（BAL / JPQ / VAP / CONSV）は共有フィクスチャのまま。
 */
export const DS2_INITIAL_COMPANY_DEBT_USD: Readonly<Record<string, InitialCompanyDebtOverride>> = {
  MASS: {
    shortTermLoans: 17_500_000,
    longTermLoans: 22_500_000,
  },
};

/** MASS の初期借入合計（テスト・ベンチマークの期待値として参照する）。 */
export const DS2_MASS_TOTAL_DEBT_USD = 40_000_000;
