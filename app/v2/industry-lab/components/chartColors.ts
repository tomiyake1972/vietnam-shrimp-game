// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） グラフ配色

import { CountryId, DemandMarketId } from "../../../lib/v2/market/types";

export const COUNTRY_COLORS: Readonly<Record<CountryId, string>> = {
  EC: "#f59e0b",
  IN: "#10b981",
  ID: "#6366f1",
  VN: "#ef4444",
};

export const COUNTRY_NAMES: Readonly<Record<CountryId, string>> = {
  EC: "エクアドル",
  IN: "インド",
  ID: "インドネシア",
  VN: "ベトナム",
};

export const DEMAND_MARKET_COLORS: Readonly<Record<DemandMarketId, string>> = {
  CN: "#f59e0b",
  US: "#3b82f6",
  EU: "#a855f7",
  JP: "#10b981",
  OTHER: "#94a3b8",
};

export const DEMAND_MARKET_NAMES: Readonly<Record<DemandMarketId, string>> = {
  CN: "中国",
  US: "米国",
  EU: "EU",
  JP: "日本",
  OTHER: "その他",
};
