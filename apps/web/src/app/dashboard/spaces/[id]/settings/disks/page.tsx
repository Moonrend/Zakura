import { redirect } from "next/navigation";

// 数据盘已改为全局资源，旧的空间内入口跳转到全局页面。
export default function SpaceDisksRedirect() {
  redirect("/dashboard/disks");
}
