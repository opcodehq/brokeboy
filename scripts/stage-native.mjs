// Stage reviewable npm artifacts. This script never publishes packages.
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const targets = {
  "linux-x64-gnu": {
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    library: "libbrokeboy_node.so",
  },
  "linux-arm64-gnu": {
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    library: "libbrokeboy_node.so",
  },
  "linux-x64-musl": {
    os: "linux",
    cpu: "x64",
    libc: "musl",
    library: "libbrokeboy_node.so",
  },
  "linux-arm64-musl": {
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    library: "libbrokeboy_node.so",
  },
  "darwin-x64": { os: "darwin", cpu: "x64", library: "libbrokeboy_node.dylib" },
  "darwin-arm64": {
    os: "darwin",
    cpu: "arm64",
    library: "libbrokeboy_node.dylib",
  },
  "win32-x64-msvc": { os: "win32", cpu: "x64", library: "brokeboy_node.dll" },
};
const { values } = parseArgs({
  options: {
    platform: { type: "string" },
    input: { type: "string", default: "target/release" },
    out: { type: "string", default: "target/npm" },
    primary: { type: "boolean", default: false },
  },
});
const cargo = await readFile("Cargo.toml", "utf8");
const version = cargo.match(/^version = "([^"]+)"$/m)?.[1];
if (!version || !/^0\.2\.\d+-[\w.-]+$/.test(version))
  throw new Error("Only unpublished 0.2 prerelease staging is enabled.");
const out = resolve(values.out);
const write = async (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
if (values.primary) {
  const { cp } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  await mkdir(out, { recursive: true });
  const runtime = new Set([
    "native.js",
    "native-cli.js",
    "native-loader.js",
    "native-bridge.js",
    "native-effect.js",
    "native-effect-bridge.js",
    "billing-bridge.js",
    "core/effect.js",
    "core/errors.js",
    "core/urls.js",
    "server.js",
    "generated/models.js",
  ]);
  await cp("dist", join(out, "dist"), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => {
      const path = relative("dist", source).replaceAll("\\", "/");
      if (!path.endsWith(".js") && !path.endsWith(".js.map")) return true;
      const module = path.endsWith(".map") ? path.slice(0, -4) : path;
      return (
        runtime.has(module) ||
        module.startsWith("react/") ||
        module.startsWith("schemas/")
      );
    },
  });
  await copyFile("docs/native.md", join(out, "README.md"));
  await copyFile("LICENSE", join(out, "LICENSE"));
  const exports = {
    ...manifest.exports,
    ".": manifest.exports["./native"],
    "./effect": manifest.exports["./native/effect"],
  };
  for (const key of ["./memory", "./stripe", "./drizzle"]) delete exports[key];
  await write(join(out, "package.json"), {
    name: manifest.name,
    version,
    description: manifest.description,
    license: "MIT",
    type: "module",
    repository: manifest.repository,
    files: ["dist", "LICENSE", "README.md"],
    exports,
    bin: { brokeboy: "./dist/native-cli.js" },
    dependencies: { effect: manifest.dependencies.effect },
    optionalDependencies: Object.fromEntries(
      Object.keys(targets).map((platform) => [
        `@opcodehq/brokeboy-${platform}`,
        version,
      ]),
    ),
    peerDependencies: {
      react: manifest.peerDependencies.react,
      "drizzle-orm": manifest.peerDependencies["drizzle-orm"],
    },
    peerDependenciesMeta: {
      react: { optional: true },
      "drizzle-orm": { optional: true },
    },
    engines: manifest.engines,
  });
  console.log(
    JSON.stringify({
      staged: "brokeboy",
      version,
      directory: out,
      published: false,
    }),
  );
} else {
  const target = targets[values.platform];
  if (!target)
    throw new Error(
      `Choose --platform from ${Object.keys(targets).join(", ")}`,
    );
  await mkdir(out, { recursive: true });
  const executable =
    target.os === "win32" ? "brokeboy-native.exe" : "brokeboy-native";
  const files = [
    [target.library, "brokeboy.node"],
    [executable, executable],
  ];
  const measurements = {};
  for (const [source, destination] of files) {
    const bytes = await readFile(join(values.input, source));
    await writeFile(join(out, destination), bytes, { flag: "wx" });
    measurements[destination] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await chmod(join(out, executable), 0o755);
  await copyFile("LICENSE", join(out, "LICENSE"));
  await write(join(out, "package.json"), {
    name: `@opcodehq/brokeboy-${values.platform}`,
    version,
    license: "MIT",
    main: "brokeboy.node",
    exports: { ".": "./brokeboy.node", "./cli": `./${executable}` },
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    files: ["brokeboy.node", executable, "LICENSE", "measurements.json"],
  });
  await write(join(out, "measurements.json"), {
    platform: values.platform,
    version,
    profile: "release",
    measurements,
  });
  console.log(
    JSON.stringify({
      staged: values.platform,
      directory: out,
      published: false,
      measurements,
    }),
  );
}
