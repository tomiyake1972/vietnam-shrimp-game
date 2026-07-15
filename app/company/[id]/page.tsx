import { COMPANIES, PHASES, CompanyId } from "../../lib/gameData";
import CompanyDashboard from "../../components/CompanyDashboard";
import { notFound } from "next/navigation";
export default async function CompanyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ game?: string }> }) {
  const { id } = await params;
  const { game: gameCode } = await searchParams;
  const companyId = id.toUpperCase() as CompanyId;
  const profile = COMPANIES[companyId];
  if (!profile) return notFound();
  return <CompanyDashboard profile={profile} phases={PHASES} gameCode={gameCode} />;
}
export function generateStaticParams() { return ["A","B","C","D","E"].map((id) => ({ id })); }
