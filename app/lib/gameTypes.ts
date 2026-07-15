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

// gm-test: 非本番環境でGMがテストゲームの会社画面を代理操作して提出した場合。
// ai: 将来のAI自動意思決定用に予約（Step 4時点では設定されない）。
// unknown: 提出者情報が存在しない旧データ用のフォールバック。
export type SubmittedBy = "player" | "gm-test" | "ai" | "unknown";

export interface CompanyDecision {
  companyId: CompanyId;
  gameCode: string;
  year: number;
  quarter: number;
  submittedAt: string; // 後方互換のため維持。常に最新提出時刻（lastSubmittedAtと同値）に更新する。
  phases: Record<string, string>;
  // Step 4で追加。既存データには存在しないため、Redisから読み込む際は
  // 必ず app/lib/decision.ts の normalizeDecision() を通して既定値を補うこと。
  submissionCount: number;
  firstSubmittedAt: string;
  lastSubmittedAt: string;
  submittedBy: SubmittedBy;
}

export interface CompanySubmissionStatus {
  companyId: CompanyId;
  companyName: string;
  playerType: PlayerType;
  submitted: boolean;
  submissionCount: number;
  firstSubmittedAt: string | null;
  lastSubmittedAt: string | null;
  submittedBy: SubmittedBy;
  isResubmission: boolean;
}

export interface SubmissionStatusResponse {
  gameCode: string;
  year: number;
  quarter: number;
  phase: number;
  submittedCount: number;
  totalCompanies: number;
  allSubmitted: boolean;
  updatedAt: string;
  companies: CompanySubmissionStatus[];
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
