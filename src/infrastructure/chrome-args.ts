export interface RuntimeInfo {
  platform: string;
  getuid?: () => number;
}

export interface ChromeArgsOptions {
  extraArgs?: string[];
  includeWindowSize?: boolean;
  runtime?: RuntimeInfo;
}

const SANDBOX_DISABLED_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"];

function currentRuntime(): RuntimeInfo {
  return {
    platform: process.platform,
    getuid: typeof process.getuid === "function" ? process.getuid.bind(process) : undefined,
  };
}

export function isRootProcess(runtime: RuntimeInfo = currentRuntime()): boolean {
  return runtime.platform !== "win32" && typeof runtime.getuid === "function" && runtime.getuid() === 0;
}

export function getChromeSandboxArgs(runtime?: RuntimeInfo): string[] {
  return isRootProcess(runtime) ? [...SANDBOX_DISABLED_ARGS] : [];
}

export function getChromeSandboxWarning(runtime?: RuntimeInfo): string | null {
  if (!isRootProcess(runtime)) return null;

  return "Aviso: el proceso corre como root; Chrome se iniciará sin sandbox. En producción conviene correr el scraper con un usuario no-root.";
}

export function buildChromeArgs(options: ChromeArgsOptions = {}): string[] {
  const { extraArgs = [], includeWindowSize = true, runtime } = options;
  const args = [
    ...getChromeSandboxArgs(runtime),
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];

  if (includeWindowSize) {
    args.push("--window-size=1280,900");
  }

  args.push("--disable-blink-features=AutomationControlled", ...extraArgs);
  return args;
}
