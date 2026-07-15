import { CompanyId } from "./gameData";
import { AppEnvironment } from "./env";
export type PlayerType = "human" | "ai-a" | "ai-b" | "ai-c";
export interface GameSession {
  gameCode: string; title: string; createdAt: string; updatedAt: string;
  currentYear: number; currentQuarter: number; currentPhase: number;
  status: "setup" | "playing" | "finished";
  players: Record<CompanyId, PlayerType>;
  confirmedOrders: Record<CompanyId, ConfirmedOrder[]>;
  history: string[];
  // テスト環境（Step 3）関連。既存データには存在しないため、Redisから読み込む際は
  // 必ず app/lib/gameSession.ts の normalizeGameSession() を通して既定値を補うこと。
  isTestGame: boolean;
  environment: AppEnvironment;
  randomSeed: string;
}
export interface ConfirmedOrder { destination: string; product: string; quantity: number; price: number; deliveryQuarter: number; }
export interface CompanyState { cash: number; totalAssets: number; equity: number; debtEquityRatio: number; creditScore: number; farmingArea: number; processingCapacity: number; }

export interface CompanyDecision {
  companyId: CompanyId;
  gameCode: string;
  year: number;
  quarter: number;
  submittedAt: string;
  phases: Record<string, string>;
}

export interface CompanyTurnResult {
  companyId: CompanyId;
  year: number;
  quarter: number;
  submitted: boolean;
  revenue: number;
  cogs: number;
  processingCost: number;
  interestExpense: number;
  overhead: number;
  netIncome: number;
  rawMaterialAvailable: number;
  rawMaterialUsed: number;
  productOutput: { bulk: number; vap: number };
  salesByMarket: Record<string, number>;
  stateBefore: CompanyState;
  stateAfter: CompanyState;
  notes: string[];
}

export interface TurnResult {
  gameCode: string;
  year: number;
  quarter: number;
  processedAt: string;
  companies: Record<CompanyId, CompanyTurnResult>;
}
