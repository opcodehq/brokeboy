import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
export type NativeHandle = {
  registerRequest(id: string): void;
  cancelRequest(id: string): boolean;
  call(method: string, input: string, id: string): Promise<string>;
  webhook(headers: string, body: Buffer, id: string): Promise<string>;
  close(): Promise<void>;
};
export type NativeAddon = {
  NativeBilling: {
    open(
      configuration: string,
      onEvent?: (event: string) => Promise<void>,
    ): Promise<NativeHandle>;
  };
  validateCatalog(input: string): void;
  rateUsage(rate: string, quantity: string, properties: string): string;
  addInterval(start: number, interval: string, count: number): number;
};
export function nativeTarget(): string {
  const platform = process.platform,
    arch = process.arch;
  if (
    !(
      (platform === "linux" && (arch === "x64" || arch === "arm64")) ||
      (platform === "darwin" && (arch === "x64" || arch === "arm64")) ||
      (platform === "win32" && arch === "x64")
    )
  )
    throw new Error(
      `Brokeboy native billing does not support ${platform}/${arch}. Workers/D1 require the 0.1 maintenance line.`,
    );
  const header = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const musl =
    platform === "linux" &&
    !header?.header?.glibcVersionRuntime &&
    existsSync(`/lib/ld-musl-${arch === "arm64" ? "aarch64" : "x86_64"}.so.1`);
  return `${platform}-${arch}${platform === "linux" ? (musl ? "-musl" : "-gnu") : platform === "win32" ? "-msvc" : ""}`;
}
let cached: NativeAddon | undefined;
export function loadNative(): NativeAddon {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const target = nativeTarget();
  const local = new URL("../target/debug/brokeboy.node", import.meta.url);
  if (existsSync(local)) {
    cached = require(fileURLToPath(local)) as NativeAddon;
    return cached;
  }
  const packaged = new URL(
    `../native/${target}/brokeboy.node`,
    import.meta.url,
  );
  if (existsSync(packaged)) {
    cached = require(fileURLToPath(packaged)) as NativeAddon;
    return cached;
  }
  try {
    cached = require(`@opcodehq/brokeboy-${target}`) as NativeAddon;
    return cached;
  } catch {
    throw new Error(
      `The Brokeboy native binary for ${target} is unavailable. Install the matching native package. Repository contributors can run bun run native:build. No alternative billing engine was selected.`,
    );
  }
}
