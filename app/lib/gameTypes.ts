import { CompanyId } from "./gameData";
export type PlayerType = "human" | "ai-a" | "ai-b" | "ai-c";
export interface GameSession {
  gameCode: string; title: string; createdAt: string;
  currentYear: number; currentQuarter: number; currentPhase: number;
  status: "setup" | "playing" | "finished";
  players: Record<CompanyId, PlayerType>;
  confirmedOrders: Record<CompanyId, ConfirmedOrder[]>;
}
export interface ConfirmedOrder { destination: string; product: string; quantity: number; price: number; deliveryQuarter: number; }
export interface CompanyState { cash: number; totalAssets: number; equity: number; debtEquityRatio: number; creditScore: number; farmingArea: number; processingCapacity: number; }
