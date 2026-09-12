export type AuthFlowKind = "device" | "pkce" | "sdk" | "paste";

export type AuthSessionStatus = "pending" | "complete" | "error" | "cancelled";

export type AuthSessionSnapshot = {
  loginId: string;
  kind: AuthFlowKind;
  status: AuthSessionStatus;
  userCode?: string;
  verificationUrl?: string;
  interval?: number;
  expiresIn?: number;
  hint?: string;
  error?: string;
};

export type AuthSubmitInput = {
  loginId?: string;
  code?: string;
  setupToken?: string;
  credentialsJson?: string;
};
