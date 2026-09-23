// ShrimpX V2 — Management Console 手動バランス調整（Run固有の手動上書き）
//
// 【目的】全社Standard AI運用のまま、Management Consoleから
// (a) 配当性向 (b) 販売市場価格指数 (c) 原料市場価格指数 を
// 次の未実行Turnから手動で上書きできるようにする。
//
// 【設計方針・vision/overrides.ts と同じ規律】
// 解決関数 resolveManualBalanceForTurn を唯一のSSoTとし、UI・Engine・Standard AI・
// 保存/再開のすべてがこの関数を通して「そのTurnに適用される設定」を読む。
// スケジュール配列を各所で自前に走査する経路を作らない
// （UIだけ変更してEngineが別の値を見る事故を構造的に防ぐ）。
//
// 【過去Turnをretroactiveに変更しない】この関数は「指定Turn時点で有効な設定」を
// 返す純粋関数である。確定済みTurnの記録（marketResult・AI capture）は書き換えない。
// 呼び出し側は必ず effectiveFromTurn へ「次の未実行Turn」を渡すこと。
//
// 【v1のスコープ】全社共通・全市場共通。会社別／市場別の細分化は行わない
// （Vision Calibration が会社別Recordであるのに対し、こちらはRun単位の1系列である）。
// 会社別が必要になった時点で、このファイルの型をRecord<companyId, ...>へ広げる。

/**
 * 配当性向の手動設定。
 *
 * 【明示的0%と未設定を型で区別する】0% は「配当しない」という**指示**であり、
 * 未設定（＝Standard AIの既定 dividendBasePayoutRatio を使う）とは意味が異なる。
 * number | undefined で表すと、JSON往復や `?? default` の一行で 0 が既定値へ
 * 化ける事故が起きるため、判別可能ユニオンで表現する。
 */
export type ManualDividendPayoutSetting =
  | { readonly kind: "unspecified" }
  | { readonly kind: "specified"; readonly payoutRatio: number };

/** 未設定を表す共有インスタンス。 */
export const UNSPECIFIED_DIVIDEND_PAYOUT: ManualDividendPayoutSetting = { kind: "unspecified" };

/**
 * 1エントリが保持する手動設定のスナップショット。
 *
 * 【スナップショット方式・マージしない】解決時に複数エントリを項目単位でマージ
 * すると、「画面に出ている最終適用値」と「Engineが使う値」を一致させる保証が
 * 弱くなる（どのエントリのどの項目が生き残ったかを画面で再現する必要が出る）。
 * そのため resolveManualBalanceForTurn は必ず**エントリを1件だけ選ぶ**。
 * 「販売価格指数だけ変えたい」場合は、販売のみ指定し他をundefinedにしたエントリを
 * 作る（＝他項目は手動補正なしとして扱われる）。
 */
export interface ManualBalanceSettings {
  readonly dividendPayout: ManualDividendPayoutSetting;
  /**
   * 販売市場価格指数。100 = 手動補正なし。95 = 補正前価格の95%。
   * undefined は「この項目は手動設定しない」。0以下・非有限は受け付けない
   * （空欄が0として送信される事故を validateManualBalanceSettings で弾く）。
   */
  readonly salesPriceIndex: number | undefined;
  /** 原料市場価格指数。100 = 手動補正なし。販売とは独立。 */
  readonly rawMarketPriceIndex: number | undefined;
}

/** 手動補正が一切ない設定（解除後・未設定Turnの表現）。 */
export const NEUTRAL_MANUAL_BALANCE_SETTINGS: ManualBalanceSettings = {
  dividendPayout: UNSPECIFIED_DIVIDEND_PAYOUT,
  salesPriceIndex: undefined,
  rawMarketPriceIndex: undefined,
};

/**
 * ターン別の個別設定。「次1ターンのみ」もこの形で保存する
 * （単発指定＝対象Turnが1つのperTurnエントリ。保存形式を分けない）。
 */
export interface ManualBalancePerTurnEntry {
  readonly kind: "perTurn";
  /** この設定を適用する対象Turn（1始まり）。 */
  readonly turn: number;
  readonly settings: ManualBalanceSettings;
  readonly source: "MANUAL_OVERRIDE";
  /** 記録時刻（ISO8601）。同一対象への複数記録の新旧判定に使う。 */
  readonly recordedAt: string;
}

/** 指定Turnから継続して適用される設定。 */
export interface ManualBalanceContinuingEntry {
  readonly kind: "continuing";
  /** この設定が有効になるTurn（1始まり）。以降のTurnへ継続して適用される。 */
  readonly effectiveFromTurn: number;
  readonly settings: ManualBalanceSettings;
  readonly source: "MANUAL_OVERRIDE";
  readonly recordedAt: string;
}

/**
 * 解除。指定Turn以降について、**これより前に記録された**設定をすべて無効化する
 * （リセット点。過去の確定Turnの記録は書き換えない）。
 */
export interface ManualBalanceReleaseEntry {
  readonly kind: "release";
  /** 解除が有効になるTurn（1始まり）。 */
  readonly effectiveFromTurn: number;
  readonly source: "MANUAL_OVERRIDE";
  readonly recordedAt: string;
}

export type ManualBalanceScheduleEntry = ManualBalancePerTurnEntry | ManualBalanceContinuingEntry | ManualBalanceReleaseEntry;

/**
 * Run単位の手動バランス調整スケジュール（追記のみ。変更履歴としてそのまま残す）。
 * 配列の順序には依存しない（解決時に recordedAt / 対象Turn で判定する）。
 */
export type ManualBalanceSchedule = readonly ManualBalanceScheduleEntry[];

export const EMPTY_MANUAL_BALANCE_SCHEDULE: ManualBalanceSchedule = [];

// --- 入力検証 -------------------------------------------------------------

/**
 * 価格指数の許容範囲。100が中立。
 *
 * 【単位間違いの防御】下限を1にすることで、0.95（=95%のつもりで比率を入力した）や
 * 空欄由来の0を弾く。これらは「95」と書くべき入力であり、そのまま通すと
 * 価格が1/100になって初めて気づくことになる。
 */
export const MANUAL_PRICE_INDEX_MIN = 1;
export const MANUAL_PRICE_INDEX_MAX = 1000;
/** 手動補正なしと同義の中立値。 */
export const MANUAL_PRICE_INDEX_NEUTRAL = 100;

export const MANUAL_DIVIDEND_PAYOUT_PERCENT_MIN = 0;
export const MANUAL_DIVIDEND_PAYOUT_PERCENT_MAX = 100;

export function isValidManualPriceIndex(value: number): boolean {
  return Number.isFinite(value) && value >= MANUAL_PRICE_INDEX_MIN && value <= MANUAL_PRICE_INDEX_MAX;
}

export function isValidManualDividendPayoutPercent(value: number): boolean {
  return (
    Number.isFinite(value) && value >= MANUAL_DIVIDEND_PAYOUT_PERCENT_MIN && value <= MANUAL_DIVIDEND_PAYOUT_PERCENT_MAX
  );
}

/** 検証エラー（UIへそのまま表示できる日本語メッセージ付き）。 */
export interface ManualBalanceValidationIssue {
  readonly field: "dividendPayout" | "salesPriceIndex" | "rawMarketPriceIndex";
  readonly message: string;
}

/**
 * 保存前の検証。空欄・単位間違い・非有限値をここで止める。
 * 「未設定（undefined）」は正常であり、エラーにしない。
 */
export function validateManualBalanceSettings(settings: ManualBalanceSettings): readonly ManualBalanceValidationIssue[] {
  const issues: ManualBalanceValidationIssue[] = [];

  if (settings.dividendPayout.kind === "specified") {
    const percent = settings.dividendPayout.payoutRatio * 100;
    if (!isValidManualDividendPayoutPercent(percent)) {
      issues.push({
        field: "dividendPayout",
        message: `配当性向は${MANUAL_DIVIDEND_PAYOUT_PERCENT_MIN}〜${MANUAL_DIVIDEND_PAYOUT_PERCENT_MAX}%の範囲で指定してください。`,
      });
    }
  }

  for (const [field, value] of [
    ["salesPriceIndex", settings.salesPriceIndex],
    ["rawMarketPriceIndex", settings.rawMarketPriceIndex],
  ] as const) {
    if (value === undefined) continue;
    if (!isValidManualPriceIndex(value)) {
      issues.push({
        field,
        message:
          `価格指数は${MANUAL_PRICE_INDEX_MIN}〜${MANUAL_PRICE_INDEX_MAX}の有限な正の数で指定してください` +
          `（100が補正なし、95が補正前価格の95%）。0.95のような比率ではなく95のように指定します。`,
      });
    }
  }

  return issues;
}

// --- 解決（SSoT） ---------------------------------------------------------

/** どのエントリがそのTurnの適用値を決めたか。 */
export type ManualBalanceAppliedSource =
  | { readonly kind: "none" }
  | { readonly kind: "perTurn"; readonly entry: ManualBalancePerTurnEntry }
  | { readonly kind: "continuing"; readonly entry: ManualBalanceContinuingEntry };

/** あるTurnに実際に適用される手動設定と、その根拠。 */
export interface ResolvedManualBalance {
  readonly turn: number;
  readonly settings: ManualBalanceSettings;
  readonly appliedSource: ManualBalanceAppliedSource;
}

function isNewer(a: { readonly recordedAt: string }, b: { readonly recordedAt: string }): boolean {
  // 文字列比較で十分（ISO8601は辞書順＝時刻順）。同時刻なら後勝ちにはしない（安定化のため厳密比較）。
  return a.recordedAt > b.recordedAt;
}

/**
 * 【SSoT】指定Turnに適用される手動バランス設定を解決する。
 *
 * 解決規則:
 *   1. 対象Turn以下で有効な解除（release）のうち最後に記録されたものを探す。
 *      それより**前に記録された**エントリはすべて無効（＝解除はリセット点）。
 *   2. 残った候補のうち、対象Turnをピンポイント指定するperTurnエントリを優先する
 *      （仕様: ターン別 > 継続）。同一Turnに複数あれば recordedAt が最新のもの。
 *   3. perTurnが無ければ、effectiveFromTurn <= turn の継続エントリのうち
 *      effectiveFromTurn が最大のもの（同値なら recordedAt が最新のもの）。
 *   4. いずれも無ければ手動補正なし。
 *
 * 【複利化しない理由（構造）】この関数は「そのTurnの指数そのもの」を返すだけで、
 * 前Turnの適用後価格を一切参照しない。継続指数95は毎Turn独立に95として解決され、
 * 適用側（market/index.ts）がそのTurnの補正前価格へ1回だけ掛ける。
 */
export function resolveManualBalanceForTurn(schedule: ManualBalanceSchedule | undefined, turn: number): ResolvedManualBalance {
  const entries = schedule ?? EMPTY_MANUAL_BALANCE_SCHEDULE;

  let latestRelease: ManualBalanceReleaseEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "release") continue;
    if (entry.effectiveFromTurn > turn) continue;
    if (latestRelease === null || isNewer(entry, latestRelease)) latestRelease = entry;
  }

  const afterRelease = (entry: { readonly recordedAt: string }): boolean =>
    latestRelease === null || isNewer(entry, latestRelease);

  let perTurn: ManualBalancePerTurnEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "perTurn") continue;
    if (entry.turn !== turn) continue;
    if (!afterRelease(entry)) continue;
    if (perTurn === null || isNewer(entry, perTurn)) perTurn = entry;
  }
  if (perTurn !== null) {
    return { turn, settings: perTurn.settings, appliedSource: { kind: "perTurn", entry: perTurn } };
  }

  let continuing: ManualBalanceContinuingEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "continuing") continue;
    if (entry.effectiveFromTurn > turn) continue;
    if (!afterRelease(entry)) continue;
    if (
      continuing === null ||
      entry.effectiveFromTurn > continuing.effectiveFromTurn ||
      (entry.effectiveFromTurn === continuing.effectiveFromTurn && isNewer(entry, continuing))
    ) {
      continuing = entry;
    }
  }
  if (continuing !== null) {
    return { turn, settings: continuing.settings, appliedSource: { kind: "continuing", entry: continuing } };
  }

  return { turn, settings: NEUTRAL_MANUAL_BALANCE_SETTINGS, appliedSource: { kind: "none" } };
}

/**
 * そのTurンの販売市場価格指数（中立なら undefined ではなく 100 を返す）。
 * Engine側は常にこの値を使い、`?? 100` を各所で書かない。
 */
export function resolvedSalesPriceIndex(resolved: ResolvedManualBalance): number {
  return resolved.settings.salesPriceIndex ?? MANUAL_PRICE_INDEX_NEUTRAL;
}

/** そのTurnの原料市場価格指数（中立なら100）。 */
export function resolvedRawMarketPriceIndex(resolved: ResolvedManualBalance): number {
  return resolved.settings.rawMarketPriceIndex ?? MANUAL_PRICE_INDEX_NEUTRAL;
}

/**
 * そのTurnにStandard AIへ実際に渡す配当性向（手動指定が無ければ null）。
 * 保存記録・画面表示と、下の applyManualDividendPayoutToParams が同じ値を使う。
 */
export function resolvedDividendPayoutRatio(resolved: ResolvedManualBalance): number | null {
  const setting = resolved.settings.dividendPayout;
  return setting.kind === "specified" ? setting.payoutRatio : null;
}

/**
 * 【D1・管理者指定配当の全社共通強制】
 * 管理者がManual Balanceで明示指定した配当性向を、操作主体（PLAYER / STANDARD_AI）に
 * 関係なく、その会社の最終意思決定へ「年度末精算の意思」として強制付与する。
 *
 * 【なぜ意思決定の組み立て側（draft/UI）ではなくここなのか】
 * PLAYERの提出値を作る buildDecisionInputFromDraft は金額指定配当しか出力せず、
 * Standard AI だけが annualDividendSettlement を出していた。そのため
 * 「PLAYER会社は利益があっても年度末精算のコードパスに入らない」という状態だった。
 * PLAYERのdraft側にだけ付け足すと、
 *   ・GM代理操作 / Independent Player / Company Lab の提出経路ごとに同じ処理が要る
 *   ・提出経路が増えるたびに付け忘れる
 * ため、**意思決定が誰由来かを問わない1か所**（runner.ts が全経路で必ず通る
 * 意思決定の正規化地点）で適用する。
 *
 * 【管理者指定は「配当義務」】管理者が率を指定した場合、Standard AI 側の任意
 * 見送りgate（新規CAPEX提案あり・Crisis・財務健全性など）が意思を出さなかった
 * としても、精算対象にする。管理者指定は会社の裁量ではなく外から課した条件である。
 *
 * 【明示0%と未指定を区別する】
 *   ・明示0%    → payoutRatio 0 の意思を付与する。年間配当目標0として
 *                 「精算した結果0だった」ことが記録に残る（無記録とは別物）。
 *   ・未指定     → 何もしない。decision をそのまま返す。
 *                 PLAYERはAIの既定率を強制されず金額指定配当だけが従来どおり効き、
 *                 STANDARD_AIは自前の任意配当policyがそのまま残る（挙動不変）。
 *
 * 【Q4時点の率だけを使う】呼び出し側は当Turnの解決結果を渡す。年度内の率を平均
 * しない。年度末（Q4）のTurnで解決された値がそのまま年間精算率になる。
 */
export function applyAdminAnnualDividendSettlementToDecision<
  T extends { readonly annualDividendSettlement?: { readonly payoutRatio: number; readonly payoutRatioSource: "MANUAL_OVERRIDE" | "STANDARD_AI" } }
>(decision: T, resolved: ResolvedManualBalance): T {
  const payoutRatio = resolvedDividendPayoutRatio(resolved);
  // 【未指定は素通し】同一オブジェクトをそのまま返すため、管理者指定が無いRunは
  // 既存Runとビット単位で同じ意思決定になる（回帰の担保）。
  if (payoutRatio === null) return decision;
  return { ...decision, annualDividendSettlement: { payoutRatio, payoutRatioSource: "MANUAL_OVERRIDE" } };
}

/**
 * 【重要・実装指示の明示要件「手動で指定した値がAI人格によって改変されないこと」】
 * 解決済みの手動配当性向を Standard AI パラメータへ適用する。
 *
 * 【必ず経営性格バイアスの"後"で呼ぶこと】
 * managementProfile.ts は base.dividendBasePayoutRatio へ会社ごとの比率バイアス
 * （±数%）を掛ける。手動指定値をバイアスの前に入れると、管理者が20%と指定しても
 * 会社によって19%や21%で実行され、画面の指定値と実行値が食い違う。
 * この関数はバイアス適用後のparamsを受け取り、手動指定値で**上書きする**ため、
 * 指定値はそのままStandard AIの配当計算へ届く。
 *
 * 【計算構造は変更しない】置き換えるのは配当性向の値だけである。
 * Q4のみ・直前確定四半期の純利益基準・distributableEarnings/cashによる上限クランプ
 * といった既存の配当計算構造（decision/dividend.ts）には一切触れない。
 * 年度累計（Q1〜Q4）での確定配当は #08 の未承認仕様であり、ここでは実装しない。
 *
 * 【明示的0%】payoutRatio=0 は「配当しない」という指示として尊重され、
 * 既定値0.15へフォールバックしない（kind:"unspecified" のときだけ既定値のまま）。
 */
export function applyManualDividendPayoutToParams<T extends { readonly dividendBasePayoutRatio: number }>(
  params: T,
  resolved: ResolvedManualBalance
): T {
  const payoutRatio = resolvedDividendPayoutRatio(resolved);
  if (payoutRatio === null) return params;
  return { ...params, dividendBasePayoutRatio: payoutRatio };
}

// --- スケジュール更新（純粋関数） ----------------------------------------

/** 継続設定を追加する（既存エントリは履歴として残す）。 */
export function withManualBalanceContinuingApplied(
  schedule: ManualBalanceSchedule | undefined,
  effectiveFromTurn: number,
  settings: ManualBalanceSettings,
  recordedAt: string
): ManualBalanceSchedule {
  const entry: ManualBalanceContinuingEntry = {
    kind: "continuing",
    effectiveFromTurn,
    settings,
    source: "MANUAL_OVERRIDE",
    recordedAt,
  };
  return [...(schedule ?? EMPTY_MANUAL_BALANCE_SCHEDULE), entry];
}

/** ターン別設定を追加する（「次1ターンのみ」も対象Turn1件のこれで表現する）。 */
export function withManualBalancePerTurnApplied(
  schedule: ManualBalanceSchedule | undefined,
  turn: number,
  settings: ManualBalanceSettings,
  recordedAt: string
): ManualBalanceSchedule {
  const entry: ManualBalancePerTurnEntry = {
    kind: "perTurn",
    turn,
    settings,
    source: "MANUAL_OVERRIDE",
    recordedAt,
  };
  return [...(schedule ?? EMPTY_MANUAL_BALANCE_SCHEDULE), entry];
}

/** 解除を追加する（指定Turn以降、それ以前に記録された設定を無効化する）。 */
export function withManualBalanceReleased(
  schedule: ManualBalanceSchedule | undefined,
  effectiveFromTurn: number,
  recordedAt: string
): ManualBalanceSchedule {
  const entry: ManualBalanceReleaseEntry = {
    kind: "release",
    effectiveFromTurn,
    source: "MANUAL_OVERRIDE",
    recordedAt,
  };
  return [...(schedule ?? EMPTY_MANUAL_BALANCE_SCHEDULE), entry];
}

/**
 * 画面の設定表・別Runへの持ち出し用に、指定Turn範囲の適用値を並べる。
 * 実際にEngineが使うのと同じ resolveManualBalanceForTurn を通すため、
 * 表示とEngineの値が構造的に食い違わない。
 */
export function manualBalanceScheduleTable(
  schedule: ManualBalanceSchedule | undefined,
  fromTurn: number,
  toTurn: number
): readonly ResolvedManualBalance[] {
  const rows: ResolvedManualBalance[] = [];
  for (let turn = fromTurn; turn <= toTurn; turn += 1) {
    rows.push(resolveManualBalanceForTurn(schedule, turn));
  }
  return rows;
}
