import { redirect } from "next/navigation";

/** 连接器详情已移入 Agent 内部；保留路由兼容旧链接 */
export default async function ConnectorDetailRedirect() {
  redirect("/dashboard/agents");
}
