import { Redis } from "@upstash/redis";
export const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! });

// @upstash/redis auto-deserializes JSON values, so redis.get() already returns
// a parsed object rather than a string. Handle both shapes defensively.
export function parseStored<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
