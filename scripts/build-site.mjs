import { cp, mkdir, rm } from "node:fs/promises";

const files = [
  "_headers",
  "assets",
  "health.html",
  "index.html",
  "manifest.webmanifest",
  "service-worker.js",
  "src"
];

await rm("dist", { force: true, recursive: true });
await mkdir("dist", { recursive: true });

for (const file of files) {
  await cp(file, `dist/${file}`, { recursive: true });
}

