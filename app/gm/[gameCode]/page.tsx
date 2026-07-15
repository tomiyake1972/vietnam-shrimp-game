import { isProduction } from "../../lib/env";
import GmGameConsole from "./GmGameConsole";

export default async function GmGamePage({ params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  return <GmGameConsole gameCode={gameCode} isProduction={isProduction} />;
}
