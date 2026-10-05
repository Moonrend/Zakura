import { redirect } from "next/navigation";

export default function AgentsIndexPage() {
  redirect("/dashboard/spaces");
}
