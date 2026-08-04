import { redirect } from "next/navigation";

export default async function ConnectorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/connectors?connector=${encodeURIComponent(decodeURIComponent(id))}`);
}
