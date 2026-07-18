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
export interface CompanyState {
  cash: number;
  totalAssets: number;
  equity: number;
  debtEquityRatio: number;
  creditScore: number;
  farmingArea: number;
  processingCapacity: number;
  // 貸借対照表詳細（オプション：旧データとの後方互換のため省略可）
  accountsReceivable?: number;    // 売掛金
  rawInventory?: number;          // 原料在庫
  finishedInventory?: number;     // 製品在庫
  buildingsNet?: number;          // 建物（純額）
  equipmentGross?: number;        // 設備（総額）
  accumulatedDepreciation?: number; // 減価償却累計額
  accountsPayable?: number;       // 買掛金
  shortTermLoans?: number;        // 短期借入金
  longTermLoans?: number;         // 長期借入金
  paidInCapital?: number;         // 資本金
}

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

// テストゲームの状態を丸ごと保存・復元するためのスナップショット（Step 5）。
// decisionsのキーは "{period}:{companyId}"（例 "2015Q1:A"）、resultsのキーは
// "{period}"（例 "2015Q1"）とし、複数四半期分をまとめて1つのスナップショットに含める。
export interface GameSnapshot {
  id: string;
  gameCode: string;
  createdAt: string;
  label: string;
  session: GameSession;
  companies: Record<CompanyId, CompanyState>;
  decisions: Record<string, CompanyDecision>;
  results: Record<string, TurnResult>;
}

export interface SnapshotSummary {
  id: string;
  label: string;
  createdAt: string;
  year: number;
  quarter: number;
  phase: number;
}
