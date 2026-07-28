import { redirect } from "next/navigation";

export default function LegacyTenantSettingsPage() {
  redirect("/dashboard/settings/team");
}
