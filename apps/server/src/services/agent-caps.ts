/**
 * 电脑环境能力：文件系统 / Shell / 浏览器 / 桌面是一套，不可拆开限制。
 */

export function isComputerEnvEnabled(caps: { enableComputer?: boolean }): boolean {
  return Boolean(caps.enableComputer);
}

/** 将「电脑环境」归一成整套标志；记忆仍为独立 opt-in。 */
export function normalizeCaps(input: {
  enableComputer?: boolean;
  enableMemory?: boolean;
}) {
  const computerOn = Boolean(input.enableComputer);
  const enableMemory = input.enableMemory ?? false;

  return {
    workspaceProfile: computerOn ? ("computer" as const) : ("files" as const),
    enableFs: computerOn,
    enableShell: computerOn,
    enableComputer: computerOn,
    enableBrowser: computerOn,
    enableMemory,
  };
}

export function needsContainer(_caps: { enableComputer: boolean }): boolean {
  // All agents get at least a shell container (lite image) for ACP / file ops.
  return true;
}
