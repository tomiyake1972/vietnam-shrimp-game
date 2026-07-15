import { CompanyId } from "./gameData";
export type PlayerType = "human" | "ai-a" | "ai-b" | "ai-c";
export interface GameSession {
  gameCode: string; title: string; createdAt: string;
  currentYear: number; currentQuarter: number; currentPhase: number;
  status: "setup" | "playing" | "finished";
  players: Record<CompanyId, PlayerType>;
  confirmedOrders: Record<CompanyId, ConfirmedOrder[]>;
  history: string[];
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
