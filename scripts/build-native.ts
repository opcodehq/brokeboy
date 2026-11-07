import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const result = Bun.spawnSync(
  ["cargo", "build", "--locked", "-p", "brokeboy-node"],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (result.exitCode !== 0) process.exit(result.exitCode);
const library =
  process.platform === "win32"
    ? "brokeboy_node.dll"
    : process.platform === "darwin"
      ? "libbrokeboy_node.dylib"
      : "libbrokeboy_node.so";
await copyFile(
  resolve("target/debug", library),
  resolve("target/debug/brokeboy.node"),
);

const typescript = Bun.spawnSync(["bun", "run", "build"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (typescript.exitCode !== 0) process.exit(typescript.exitCode);
