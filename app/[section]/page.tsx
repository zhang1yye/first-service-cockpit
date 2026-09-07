import CockpitApp from "../components/CockpitApp";

const sections = new Set([
  "analysis",
  "alerts",
  "business",
  "command",
  "payment",
  "daily",
  "finance",
  "collection",
  "projects",
  "tasks",
  "ai-alerts",
  "ai-report",
  "reports",
  "review",
  "admin",
]);

export default async function SectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  return <CockpitApp section={sections.has(section) ? section : "overview"} />;
}
