import { Suspense } from "react";
import { PageLoading } from "@/components/ui/progress-linear";
import OauthAuthorizePage from "./authorize-client";

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <OauthAuthorizePage />
    </Suspense>
  );
}
