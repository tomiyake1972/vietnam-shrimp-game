// ShrimpX V2 — Standard AI経営説明レポート機能 キャッシュ（MVP）
//
// 【設計方針】
//   - 実Redis接続は既存の CompanyLabRedisClient（app/lib/v2/redis/companyLabTypes.ts）＋
//     createDefaultCompanyLabRedisClient（app/lib/v2/redis/companyLabClient.ts）を
//     そのまま再利用する。新しいRedis接続経路は作らない。
//   - キャッシュキーは labId・companyId・turn・promptVersion・contextSchemaVersion・
//     contextHash（ExplanationContextのJSON.stringify結果のsha256）から決定論的に
//     組み立てる。contextHashがキーに含まれているため、Standard AIの提案・診断
//     情報・自社状態・公開市場情報のいずれかが変わればcontextHashも変わり、
//     キー自体が変わる＝古いレポートを誤って再利用することはない
//     （「Contextが変わった場合に古いレポートを再利用してはならない」という要件は、
//     このキー設計そのものによって自動的に満たされる。追加の無効化ロジックは不要）。

import { createHash } from "crypto";
import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import { ExplanationContext } from "./buildExplanationContext";
import { StandardAiManagementReport } from "./reportSchema";

export interface StoredExplanationReport {
  readonly generatedAt: string;
  readonly result: "success" | "failure";
  readonly report?: StandardAiManagementReport;
  readonly errorCategory?: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly contextSchemaVersion: number;
  readonly contextHash: string;
}

/**
 * ExplanationContextをキー生成に使える決定論的な文字列へ直列化する。
 * JSON.stringifyはオブジェクトキーの挿入順序に依存するため、buildExplanationContext.ts
 * が常に同じ順序でキーを組み立てている前提に依存しすぎないよう、キーを再帰的に
 * ソートしてから直列化する（同一内容なら常に同一文字列になることを保証する）。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeContextHash(context: ExplanationContext): string {
  return createHash("sha256").update(stableStringify(context)).digest("hex");
}

export interface ExplanationCacheKeyInput {
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
  readonly promptVersion: string;
  readonly contextSchemaVersion: number;
  readonly contextHash: string;
}

/** キャッシュキーを組み立てる。既存の会社ラボRedisキー命名（companylab:v2:...）を踏襲する。 */
export function buildExplanationCacheKey(input: ExplanationCacheKeyInput): string {
  return `companylab:v2:${input.labId}:${input.companyId}:${input.turn}:aiExplanation:${input.promptVersion}:${input.contextSchemaVersion}:${input.contextHash}`;
}

export async function loadCachedReport(client: CompanyLabRedisClient, key: string): Promise<StoredExplanationReport | null> {
  const raw = await client.get(key);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as StoredExplanationReport;
    } catch {
      return null;
    }
  }
  // @upstash/redisは値が既にJSONとしてパース可能な場合、自動でオブジェクトを返すことがある。
  return raw as StoredExplanationReport;
}

export async function saveReport(client: CompanyLabRedisClient, key: string, value: StoredExplanationReport): Promise<void> {
  await client.set(key, JSON.stringify(value));
}
