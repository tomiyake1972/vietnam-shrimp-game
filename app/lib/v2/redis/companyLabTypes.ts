// ShrimpX V2 — 会社ラボ専用Redisアダプター 共通型（Phase 8C-1）
//
// 既存のV2RedisClient（redis/types.ts）はget/set/exists/delのみを公開しており、
// 四半期確定の原子コミットに必要なevalを持たない。app/lib/redis.ts（V1/V2共有の
// facade）自体もevalを公開していない。本Phaseの実装指示「既存のRedisクライアント
// 型がevalを公開していない場合は、会社ラボRepository用の依存インターフェースに
// 必要最小限のeval能力を定義して構わない」に従い、会社ラボ専用の狭いインターフェース
// をここへ新設する（既存のapp/lib/redis.ts・redis/types.tsは一切変更しない）。

/**
 * set()のオプション（Phase 8C-2で追加）。四半期処理ロックの取得
 * （SET NX PX相当。@upstash/redisのset(key, value, {nx, px})に対応）にのみ使う。
 */
export interface CompanyLabRedisSetOptions {
  /** trueの場合、キーが存在しないときだけ書き込む（SET NX）。既存キーがあれば書き込まれずnullが返る。 */
  readonly nx?: boolean;
  /** 指定した場合、キーにミリ秒TTLを設定する（SET PX）。 */
  readonly pxMilliseconds?: number;
}

export interface CompanyLabRedisClient {
  get(key: string): Promise<unknown>;
  /**
   * 値の書き込み。optionsを指定しない場合は無条件SET。
   * options.nx=trueで既存キーにより書き込めなかった場合はnullが返る（@upstash/redisの挙動に合わせる）。
   */
  set(key: string, value: string, options?: CompanyLabRedisSetOptions): Promise<unknown>;
  exists(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
  /**
   * Redis EVAL（Luaスクリプト実行）。@upstash/redisのRedis#evalと同じ引数形状
   * （script, keys, args）に合わせる。四半期確定の原子コミット（atomicCommit.ts）・
   * ラボの原子的作成（atomicCreateLab.ts）・ロックの安全な解放（processingLock.ts）
   * だけがこれを呼ぶ。
   */
  eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData>;
  /** ZADD（履歴indexへturn番号を冪等に追加するために使う。atomicCommitのLuaスクリプト内でのみ使用、
   * TypeScript側から直接呼ぶことはないが、読み出し側（loadHistoryIndex）がZRANGE相当を必要とするため
   * 公開しておく）。 */
  zrange(key: string, start: number, end: number): Promise<unknown[]>;
}
