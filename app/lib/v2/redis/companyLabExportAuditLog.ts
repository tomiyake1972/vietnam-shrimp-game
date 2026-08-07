// ShrimpX V2 — 読み取り専用エクスポートAPI（/api/v2/exports/**） 監査ログ
//
// 【書き込み権限の境界】エクスポートAPIは「ゲーム状態キー（current/draft/history/
// lock）には一切書き込まない・監査ログ専用キーへの追記だけは行う」という
// 境界を持つ（三宅さんの指示§「書き込み権限の境界」）。本モジュールは、
// companyLabExportLogKeyV2()が生成する1種類のキーパターンだけに対して
// LPUSH+LTRIM（件数上限つき追記）を行うAPIだけを公開し、それ以外のRedis操作
// （SET・DEL・任意キーへのeval等）を一切公開しない。呼び出し側（withExportApiContext.ts）
// は、このCompanyLabExportAuditLoggerだけを受け取り、生のCompanyLabRedisClientには
// アクセスできない。

import { AppEnvV2 } from "../core/version";
import { CompanyLabRedisClient } from "./companyLabTypes";
import { companyLabExportLogKeyV2 } from "./companyLabRedisKeys";

/** 監査ログ1件ぶんの記録内容。トークンの値・Authorizationヘッダーの値は絶対に含めない。 */
export interface CompanyLabExportLogEntry {
  readonly timestamp: string;
  readonly labId: string;
  readonly route: string;
  readonly turn: number | null;
  readonly companyIdScope: string | null;
  readonly scope: "all" | "company" | "market" | "index";
  readonly tokenScope: "gm";
  readonly status: number;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface CompanyLabExportAuditLogger {
  /** 監査ログを1件追記する（このメソッド以外に外部から呼べる操作はない）。 */
  append(entry: CompanyLabExportLogEntry): Promise<void>;
}

/** 監査ログの保持件数上限（ラボごと）。これを超えた古いエントリはLTRIMで自動的に切り捨てる。 */
export const COMPANY_LAB_EXPORT_LOG_MAX_ENTRIES = 500;

/**
 * LPUSH（先頭へ追加）してからLTRIMで直近N件だけを残すLuaスクリプト。
 * KEYS[1]は呼び出し側（append実装）がcompanyLabExportLogKeyV2()から計算した値
 * だけを渡す（任意の文字列をキーとして受け付ける汎用APIにはしない）。
 */
export const COMPANY_LAB_EXPORT_LOG_APPEND_LUA_SCRIPT = `
redis.call("LPUSH", KEYS[1], ARGV[1])
redis.call("LTRIM", KEYS[1], 0, ARGV[2])
return 1
`;

/**
 * 実Redisクライアント（またはテスト用フェイク）を受け取り、追記専用の
 * CompanyLabExportAuditLoggerを組み立てる。返すオブジェクトはappend()しか
 * 持たないため、呼び出し側はget/set/del/exists/zrange/evalへ直接触れられない。
 */
export function createCompanyLabExportAuditLogger(client: CompanyLabRedisClient, appEnv: AppEnvV2): CompanyLabExportAuditLogger {
  return {
    async append(entry: CompanyLabExportLogEntry): Promise<void> {
      const key = companyLabExportLogKeyV2(appEnv, entry.labId);
      await client.eval<[string, string], number>(COMPANY_LAB_EXPORT_LOG_APPEND_LUA_SCRIPT, [key], [
        JSON.stringify(entry),
        String(COMPANY_LAB_EXPORT_LOG_MAX_ENTRIES - 1),
      ]);
    },
  };
}
