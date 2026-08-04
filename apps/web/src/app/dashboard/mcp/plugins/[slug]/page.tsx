import { redirect } from "next/navigation";

export default function LegacyPluginDetailPage() {
  redirect("/dashboard/connectors");
}
