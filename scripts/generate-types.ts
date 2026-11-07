import { mkdir, readFile, writeFile } from "node:fs/promises";

const path = new URL("../src/generated/models.ts", import.meta.url);
const generated = Bun.spawnSync(
  [
    "cargo",
    "run",
    "--quiet",
    "--locked",
    "-p",
    "brokeboy-core",
    "--features",
    "typescript",
    "--example",
    "generate-types",
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
const formatted = Bun.spawnSync(
  ["bunx", "biome", "format", "--stdin-file-path=src/generated/models.ts"],
  { stdin: generated.stdout, stdout: "pipe", stderr: "pipe" },
);
if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
const output = formatted.stdout.toString();
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output)
    throw new Error(
      "Rust DTO declarations changed. Run bun run types:generate.",
    );
} else {
  await mkdir(new URL("../src/generated", import.meta.url), {
    recursive: true,
  });
  await writeFile(path, output);
}
