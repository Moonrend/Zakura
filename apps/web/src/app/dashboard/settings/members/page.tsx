import { redirect } from "next/navigation";

export default function LegacyMembersPage() {
  redirect("/dashboard/settings/team");
}
