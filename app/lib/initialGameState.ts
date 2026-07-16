import { COMPANIES, CompanyId } from "./gameData";
import { AppEnvironment } from "./env";
import { CompanyState, ConfirmedOrder, GameSession, PlayerType } from "./gameTypes";

// 会社の初期財務状態は、これまでapp/lib/gameData.ts（COMPANIES）と
// app/api/game/route.tsの2箇所に別々にハードコードされていた（値は完全に一致していた）。
// gameData.tsのCOMPANIESを唯一の情報源とし、ここから会社の初期CompanyStateを導出する。
export function createInitialCompanyStates(): Record<CompanyId, CompanyState> {
  const ids = Object.keys(COMPANIES) as CompanyId[];
  const states = {} as Record<CompanyId, CompanyState>;
  for (const id of ids) {
    const c = COMPANIES[id];
    states[id] = {
      cash: c.cash,
      totalAssets: c.totalAssets,
      equity: c.equity,
      debtEquityRatio: c.debtEquityRatio,
      creditScore: c.creditScore,
      farmingArea: c.farmingArea,
      processingCapacity: c.processingCapacity,
    };
  }
  return states;
}

export interface CreateGameSessionParams {
  gameCode: string;
  title: string;
  players: Record<CompanyId, PlayerType>;
  isTestGame: boolean;
  environment: AppEnvironment;
  randomSeed: string;
  createdAt: string;
  updatedAt: string;
}

// ゲーム作成・複製（初期状態として複製）・初期化のいずれからも呼び出される、
// 四半期進行状態の初期値を定義する唯一の場所。
export function createInitialGameSession(params: CreateGameSessionParams): GameSession {
  const defaultOrders: Record<CompanyId, ConfirmedOrder[]> = { A: [], B: [], C: [], D: [], E: [] };
  return {
    gameCode: params.gameCode,
    title: params.title,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
    currentYear: 2015,
    currentQuarter: 1,
    currentPhase: 0,
    status: "playing",
    players: params.players,
    confirmedOrders: defaultOrders,
    history: [],
    isTestGame: params.isTestGame,
    environment: params.environment,
    randomSeed: params.randomSeed,
  };
}
