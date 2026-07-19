import { Suspense } from "react";
import OauthAuthorizePage from "./authorize-client";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen place-items-center text-xs text-muted-foreground">
          加载授权页…
        </div>
      }
    >
      <OauthAuthorizePage />
    </Suspense>
  );
}
