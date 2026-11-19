import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const folderName = "grandpas-new-ears";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function excluded(rel) {
  const name = rel.split(path.sep).join("/");
  if (name === ".git" || name.startsWith(".git/")) return true;
  if (name === "node_modules" || name.startsWith("node_modules/")) return true;
  if (name === "dist" || name.startsWith("dist/")) return true;
  if (name === "build" || name.startsWith("build/")) return true;
  if (name === ".wrangler" || name.startsWith(".wrangler/")) return true;
  if (name === ".github" || name.startsWith(".github/")) return false;
  if (name.endsWith(".log")) return true;
  if (/\.(mp3|wav|m4a|aac|ogg|silk)$/i.test(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.endsWith("project.private.config.json")) return true;
  if (name.endsWith(".zip")) return true;
  if (name.endsWith(".DS_Store")) return true;
  return false;
}

function walk(dir, list) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (excluded(rel)) return;
    if (entry.isDirectory()) walk(full, list);
    else if (entry.isFile()) list.push(rel.split(path.sep).join("/"));
  });
  return list;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function readAppId(rel) {
  const config = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  if (config.appid !== "touristappid") {
    throw new Error(rel + " appid must stay touristappid");
  }
  return config.appid;
}

const outArg = argValue("--out");
const outPath = path.resolve(root, outArg || path.join("build", "grandpas-new-ears-miniprogram.zip"));
fs.mkdirSync(path.dirname(outPath), { recursive: true });

readAppId("project.config.json");
readAppId("miniprogram/project.config.json");
const rootConfig = JSON.parse(fs.readFileSync(path.join(root, "project.config.json"), "utf8"));
if (rootConfig.miniprogramRoot !== "miniprogram/") {
  throw new Error("root project.config.json must point at miniprogram/");
}

const files = walk(root, []).sort();
if (!files.includes("project.config.json")) throw new Error("missing root project.config.json");
if (!files.includes("miniprogram/app.json")) throw new Error("missing miniprogram/app.json");
files.forEach((rel) => {
  if (rel.includes("node_modules/") || rel.startsWith(".git/") || rel.includes(".env")) {
    throw new Error("pack included a forbidden path: " + rel);
  }
});

const commit = git(["rev-parse", "HEAD"]) || "unknown";
const dirty = git(["status", "--porcelain"]);
const note = [
  "爷爷的新耳朵小程序导入包",
  "commit: " + commit,
  "dirty: " + (dirty ? "yes" : "no"),
  "导入时选择解压后的 grandpas-new-ears 目录，这一层有 project.config.json。",
  "AppID 仍是 touristappid。请在微信开发者工具的详情里手选，不要把真实 AppID 写回仓库。",
  "这个压缩包不是微信开发者工具或真机通过的证明。"
].join("\n") + "\n";

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "gne-pack-"));
const notePath = path.join(staging, "IMPORT.txt");
fs.writeFileSync(notePath, note);
const manifest = {
  root: root,
  commit: commit,
  dirty: Boolean(dirty),
  files: files.concat(["IMPORT.txt"]),
  note: notePath
};
const manifestPath = path.join(staging, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

const python = [
  "import json, os, sys, zipfile",
  "manifest = json.load(open(sys.argv[1], encoding='utf-8'))",
  "out = sys.argv[2]",
  "root = manifest['root']",
  "folder = sys.argv[3]",
  "with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as zf:",
  "    for rel in manifest['files']:",
  "        if rel == 'IMPORT.txt':",
  "            src = manifest['note']",
  "        else:",
  "            src = os.path.join(root, rel)",
  "        zf.write(src, folder + '/' + rel)",
  "    names = zf.namelist()",
  "    needed = folder + '/project.config.json'",
  "    if needed not in names:",
  "        raise SystemExit('zip missing ' + needed)",
  "    for name in names:",
  "        lowered = name.lower()",
  "        if '/node_modules/' in name or name.startswith(folder + '/.git/') or name.endswith('.env') or '/.env.' in name:",
  "            raise SystemExit('forbidden zip entry ' + name)",
  "        if lowered.endswith(('.mp3', '.wav', '.m4a', '.aac', '.ogg', '.silk')):",
  "            raise SystemExit('audio in zip ' + name)",
  "print(len(names))"
].join("\n");
const packed = spawnSync("python3", ["-c", python, manifestPath, outPath, folderName], { encoding: "utf8" });
if (packed.status !== 0) {
  throw new Error(packed.stderr || packed.stdout || "python zip failed");
}
const fileCount = Number(String(packed.stdout || "").trim());
const sha = crypto.createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
const summary = {
  path: outPath,
  bytes: fs.statSync(outPath).size,
  sha256: sha,
  files: fileCount,
  commit: commit,
  dirty: Boolean(dirty),
  appid: "touristappid",
  importDirectory: folderName
};
fs.writeFileSync(outPath + ".sha256", sha + "  " + path.basename(outPath) + "\n");
console.log(JSON.stringify(summary, null, 2));
