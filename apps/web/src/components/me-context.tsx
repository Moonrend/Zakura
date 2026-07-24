"use client";

import { createContext, useContext } from "react";

export type MeInfo = {
  tenant: {
    id?: string;
    name: string;
    onboardingCompleted?: boolean;
  };
  isPlatformAdmin?: boolean;
  multiTenant?: boolean;
  role?: string;
  edition?: "oss" | "saas" | string;
  /** SaaS：是否授权使用本机 Local Runner；自托管恒为 true */
  canUseLocalRunner?: boolean;
};

const MeContext = createContext<MeInfo | null>(null);

export function MeProvider({
  value,
  children,
}: {
  value: MeInfo;
  children: React.ReactNode;
}) {
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeInfo {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe must be used within MeProvider");
  return me;
}

export function useMeOptional(): MeInfo | null {
  return useContext(MeContext);
}
