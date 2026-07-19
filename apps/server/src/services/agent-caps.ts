/**
 * 电脑环境能力归一化：文件系统 / Shell / 浏览器 / 桌面是一套，不可拆开限制。
 */

export function isComputerEnvEnabled(caps: {
  enableShell?: boolean;
  enableComputer?: boolean;
  enableBrowser?: boolean;
}): boolean {
  return Boolean(caps.enableComputer || caps.enableBrowser || caps.enableShell);
}

/** 将「电脑环境」归一成整套标志；记忆仍为独立 opt-in。 */
export function normalizeCaps(input: {
  /** 电脑环境总开关；也兼容旧的 shell/browser 字段 */
  enableComputer?: boolean;
  enableShell?: boolean;
  enableBrowser?: boolean;
  enableFs?: boolean;
  enableMemory?: boolean;
}) {
  const computerOn =
    input.enableComputer ?? Boolean(input.enableShell || input.enableBrowser);
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

export function needsContainer(caps: {
  enableShell: boolean;
  enableComputer: boolean;
  enableBrowser: boolean;
}): boolean {
  return isComputerEnvEnabled(caps);
}
