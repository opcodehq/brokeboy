#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { nativeTarget } from "./native-loader.js";

try {
  const require = createRequire(import.meta.url);
  const name =
    process.platform === "win32" ? "brokeboy-native.exe" : "brokeboy-native";
  const local = new URL(`../target/debug/${name}`, import.meta.url);
  const executable = existsSync(local)
    ? fileURLToPath(local)
    : require.resolve(`@opcodehq/brokeboy-${nativeTarget()}/cli`);
  const result = spawnSync(executable, process.argv.slice(2), {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} catch {
  console.error(
    "The Brokeboy native CLI for this platform is unavailable. Install the matching native package, or build brokeboy-cli in this checkout.",
  );
  process.exit(1);
}
