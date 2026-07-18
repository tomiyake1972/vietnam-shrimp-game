// ShrimpX V2 — 共通単位型（Phase 0B）
//
// 設計選択: branded（nominal）type + スマートコンストラクタ関数
// -----------------------------------------------------------------------
// value object（クラス）ではなく branded type を選んだ理由:
//   1. 直列化のしやすさ: branded typeの実体はただのnumberなので、
//      JSON.stringify / JSON.parse（Redis保存・snapshot・API応答）を
//      素通しできる。クラスにすると toJSON/fromJSON の相互変換が別途必要になり、
//      Redisから読み戻した値は常にクラスのインスタンスではなくなる
//      （プレーンオブジェクトに壊れる）ため、二重管理になりやすい。
//   2. 演算のしやすさ: branded typeはnumberとして四則演算にそのまま使える
//      （crop先で unwrap() すら省略できる場面が多い）。value objectは演算の
//      たびに .value を取り出すか演算子オーバーロード相当の関数を経由する
//      必要があり、既存V1コード（プレーンnumberを直接計算式に書く書き方）
//      との落差が大きくなる。
//   3. ランタイムコストゼロ: branded typeはコンパイル時の型情報のみで、
//      実行時オブジェクトを新規に作らない。V1コードとの相互運用（V1の
//      プレーンnumberをそのまま渡す既存呼び出し規約）に近い書き味を保てる。
// トレードオフ:
//   - branded typeはコンパイル時の防御であり、`as HosoEqTons` のような
//     型アサーションを直接書けば境界検証を回避できてしまう。
//     この回避を防ぐため、ブランド型の生成は必ずこのファイルの
//     スマートコンストラクタ関数（hosoEqTons() 等）を経由させる運用とし、
//     ドメインコードから `as` によるアサーションを直接書かないことを
//     コードレビューの前提とする（ESLintルールでの機械的強制はPhase 0では未実施。
//     後続Phaseでの改善余地として明記する）。
//
// 丸め処理は本ファイルの round* 関数に集約し、計算途中の各所で
// 無秩序に Math.round を書かないこと（要件: 丸め位置の一元化）。

declare const brand: unique symbol;

/** ブランド型: 実行時はただのnumber/stringだが、コンパイル時に区別される。 */
type Brand<T, B extends string> = T & { readonly [brand]: B };

export class UnitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitValidationError";
  }
}

function assertFiniteNumber(n: unknown, label: string): asserts n is number {
  if (typeof n !== "number" || Number.isNaN(n) || !Number.isFinite(n)) {
    throw new UnitValidationError(
      `${label} は有限数である必要があります（NaN/Infinity/非number不可）。受け取った値: ${JSON.stringify(n)}`
    );
  }
}

// ---------------------------------------------------------------------
// HosoEqTons: HOSO換算トン。数量の基本単位（サイズ概念は扱わない、仕様書0章）。
// 負数量は物理的にありえないため 0 以上のみ許可する。
// ---------------------------------------------------------------------
export type HosoEqTons = Brand<number, "HosoEqTons">;

export function hosoEqTons(n: number): HosoEqTons {
  assertFiniteNumber(n, "HosoEqTons");
  if (n < 0) throw new UnitValidationError(`HosoEqTons は0以上である必要があります。受け取った値: ${n}`);
  return n as HosoEqTons;
}

// ---------------------------------------------------------------------
// UsdPerHosoEqKg: USD / HOSO換算kg。市場価格モジュール仕様書の基準単位
// （USD/kg, FOB）に対応。価格は0以上（市場価格がマイナスになる想定は
// 現時点の仕様に存在しない）。
// ---------------------------------------------------------------------
export type UsdPerHosoEqKg = Brand<number, "UsdPerHosoEqKg">;

export function usdPerHosoEqKg(n: number): UsdPerHosoEqKg {
  assertFiniteNumber(n, "UsdPerHosoEqKg");
  if (n < 0) throw new UnitValidationError(`UsdPerHosoEqKg は0以上である必要があります。受け取った値: ${n}`);
  return n as UsdPerHosoEqKg;
}

// ---------------------------------------------------------------------
// UsdM: USD百万。財務諸表項目の基本単位（V1のCompanyState/TurnResultと
// 同じ「$M」慣習を踏襲）。現金・純資産・純利益はマイナスを取りうるため
// （債務超過・赤字）、下限は設けない。
// ---------------------------------------------------------------------
export type UsdM = Brand<number, "UsdM">;

export function usdM(n: number): UsdM {
  assertFiniteNumber(n, "UsdM");
  return n as UsdM;
}

// ---------------------------------------------------------------------
// Ratio: 0以上1以下の比率（稼働率、生残率等）。
// ---------------------------------------------------------------------
export type Ratio = Brand<number, "Ratio">;

export function ratio(n: number): Ratio {
  assertFiniteNumber(n, "Ratio");
  if (n < 0 || n > 1) throw new UnitValidationError(`Ratio は[0,1]の範囲である必要があります。受け取った値: ${n}`);
  return n as Ratio;
}

// ---------------------------------------------------------------------
// Score0to100: 0以上100以下のスコア（信頼スコア、品質成熟度等）。
// ---------------------------------------------------------------------
export type Score0to100 = Brand<number, "Score0to100">;

export function score0to100(n: number): Score0to100 {
  assertFiniteNumber(n, "Score0to100");
  if (n < 0 || n > 100) throw new UnitValidationError(`Score0to100 は[0,100]の範囲である必要があります。受け取った値: ${n}`);
  return n as Score0to100;
}

// ---------------------------------------------------------------------
// ブランド型からプレーンnumberへ明示的に戻すためのヘルパー。
// 実体は同じnumberなので実行時は恒等関数だが、「ここでブランドを外している」
// ことをコード上明示する目的で用意する。
// ---------------------------------------------------------------------
export function unwrapUnit<B extends string>(v: Brand<number, B>): number {
  return v as unknown as number;
}

// ---------------------------------------------------------------------
// 丸め位置の一元化。
//
// 仕様書v0.1/v0.2はいずれも丸め桁数を明記していないため、Phase 0時点の
// 暫定値としてここに集約し、バランス調整フェーズで再検討する
// （ドキュメントの「仕様書から変更・補完した点」に明記）。
//   - UsdM            : 小数点2桁（$10,000単位）。V1のround2慣習を踏襲。
//   - HosoEqTons       : 小数点2桁（10kg単位）。V1の数量丸め慣習を踏襲。
//   - UsdPerHosoEqKg   : 小数点4桁。tonnage×price計算で誤差が拡大しやすいため
//                        価格自体は高めの精度を保持する。
//   - Ratio            : 小数点4桁。
//   - Score0to100      : 小数点2桁。
// ---------------------------------------------------------------------
function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  // JS Math.round は正負を問わず floor(x+0.5) と等価。
  return Math.round(n * factor) / factor;
}

export function roundUsdM(n: number): number {
  return roundTo(n, 2);
}

export function roundHosoEqTons(n: number): number {
  return roundTo(n, 2);
}

export function roundUsdPerHosoEqKg(n: number): number {
  return roundTo(n, 4);
}

export function roundRatio(n: number): number {
  return roundTo(n, 4);
}

export function roundScore(n: number): number {
  return roundTo(n, 2);
}
