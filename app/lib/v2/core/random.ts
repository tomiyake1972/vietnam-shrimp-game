// ShrimpX V2 — 決定論的疑似乱数（Phase 0B）
//
// 要件: Math.random() を使わない、文字列シードから再現可能な乱数列を生成する、
// Redis/グローバル状態に依存しない、消費順序が明示的。
//
// 実装: 文字列シードを cyrb53 相当のハッシュで32bit整数へ変換し、
// mulberry32 アルゴリズム（軽量・高品質・依存ゼロ）でストリームを生成する。
// 追加npmパッケージは導入しない（要件どおり既存依存で完結）。
//
// 消費順序: RandomStream のインスタンスは呼び出しごとに内部stateを1つ進める
// ミュータブルなオブジェクトであり、next()/nextInt()/pick()等の呼び出し順が
// そのまま消費順序になる。同じシードから作った2つのStreamは独立しており、
// 片方を進めても他方には影響しない（内部stateはインスタンスごとに保持）。

export class RandomValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RandomValidationError";
  }
}

/** 文字列シードを32bit符号なし整数へ変換する（cyrb53の下位32bitを利用した簡易ハッシュ）。 */
function hashSeedToUint32(seed: string): number {
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h1 >>>= 0;
  // 0は mulberry32 の初期stateとして退化しやすい（すぐ0を返し続ける）ため避ける。
  return h1 === 0 ? 0x9e3779b9 : h1;
}

/** mulberry32: 32bit stateから[0,1)の疑似乱数を生成する軽量PRNG。 */
function mulberry32Next(state: number): { value: number; nextState: number } {
  let t = (state + 0x6d2b79f5) | 0;
  const nextState = t >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextState };
}

/**
 * 文字列シードから決定論的な乱数列を生成するストリーム。
 * Redis/グローバル状態には一切依存せず、内部stateのみで完結する。
 * JSON化・保存が必要な場合は seed と消費回数を別途記録すること
 * （本クラス自体はplainオブジェクトではないため、そのままRedisへは保存しない）。
 */
export class RandomStream {
  private state: number;
  private readonly seed: string;
  private drawCount = 0;

  constructor(seed: string) {
    if (typeof seed !== "string" || seed.length === 0) {
      throw new RandomValidationError("RandomStream のシードは空でない文字列である必要があります。");
    }
    this.seed = seed;
    this.state = hashSeedToUint32(seed);
  }

  /** このストリームが生成された元のシード文字列。 */
  getSeed(): string {
    return this.seed;
  }

  /** ここまでに消費した乱数の個数（消費順序の検証・デバッグ用）。 */
  getDrawCount(): number {
    return this.drawCount;
  }

  /** [0,1) の浮動小数点数を1つ消費する。 */
  next(): number {
    const { value, nextState } = mulberry32Next(this.state);
    this.state = nextState;
    this.drawCount += 1;
    return value;
  }

  /** [min, max) の整数を1つ消費する（min <= 戻り値 < max）。 */
  nextInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) {
      throw new RandomValidationError(
        `nextInt の範囲が不正です。min < max の整数である必要があります。受け取った値: min=${min}, max=${max}`
      );
    }
    const span = max - min;
    return min + Math.floor(this.next() * span);
  }

  /** 確率 p（[0,1]）で true を返す判定を1回消費する。 */
  chance(p: number): boolean {
    if (typeof p !== "number" || Number.isNaN(p) || p < 0 || p > 1) {
      throw new RandomValidationError(`chance の確率pは[0,1]の数である必要があります。受け取った値: ${p}`);
    }
    return this.next() < p;
  }

  /** 配列から要素を1つ等確率で選ぶ（空配列は例外）。 */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RandomValidationError("pick には空でない配列を渡す必要があります。");
    }
    const idx = this.nextInt(0, items.length);
    return items[idx];
  }
}

/** 文字列シードから新しい RandomStream を作る。V2ドメインエンジンからの唯一の生成経路。 */
export function createRandomStream(seed: string): RandomStream {
  return new RandomStream(seed);
}
