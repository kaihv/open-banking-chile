import { describe, expect, it } from "vitest";
import {
  buildChromeArgs,
  getChromeSandboxArgs,
  getChromeSandboxWarning,
  isRootProcess,
  type RuntimeInfo,
} from "./chrome-args.js";

const linuxUser: RuntimeInfo = { platform: "linux", getuid: () => 1000 };
const linuxRoot: RuntimeInfo = { platform: "linux", getuid: () => 0 };
const macUser: RuntimeInfo = { platform: "darwin", getuid: () => 501 };
const windowsRuntime: RuntimeInfo = { platform: "win32", getuid: () => 0 };
const unknownUid: RuntimeInfo = { platform: "linux" };

describe("chrome args", () => {
  it("mantiene el sandbox de Chrome para usuarios normales", () => {
    const args = buildChromeArgs({ runtime: linuxUser });

    expect(args).not.toContain("--no-sandbox");
    expect(args).not.toContain("--disable-setuid-sandbox");
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args).toContain("--disable-gpu");
    expect(args).toContain("--window-size=1280,900");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
  });

  it("desactiva el sandbox solo cuando el proceso corre como root", () => {
    const args = buildChromeArgs({ runtime: linuxRoot });

    expect(args.slice(0, 2)).toEqual(["--no-sandbox", "--disable-setuid-sandbox"]);
  });

  it("no asume root en Windows aunque exista getuid", () => {
    expect(isRootProcess(windowsRuntime)).toBe(false);
    expect(getChromeSandboxArgs(windowsRuntime)).toEqual([]);
  });

  it("no desactiva el sandbox si el runtime no expone getuid", () => {
    expect(isRootProcess(unknownUid)).toBe(false);
    expect(buildChromeArgs({ runtime: unknownUid })).not.toContain("--no-sandbox");
  });

  it("permite omitir window-size para launchers que configuran viewport aparte", () => {
    const args = buildChromeArgs({ includeWindowSize: false, runtime: macUser });

    expect(args).not.toContain("--window-size=1280,900");
  });

  it("agrega extraArgs sin cambiar la política de sandbox por defecto", () => {
    const args = buildChromeArgs({
      runtime: linuxUser,
      extraArgs: ["--disable-notifications"],
    });

    expect(args).toContain("--disable-notifications");
    expect(args).not.toContain("--no-sandbox");
  });

  it("avisa cuando Chrome se va a iniciar sin sandbox", () => {
    expect(getChromeSandboxWarning(linuxUser)).toBeNull();
    expect(getChromeSandboxWarning(linuxRoot)).toContain("root");
    expect(getChromeSandboxWarning(linuxRoot)).toContain("sin sandbox");
  });
});
