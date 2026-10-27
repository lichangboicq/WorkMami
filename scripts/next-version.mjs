#!/usr/bin/env node
/**
 * 发版版本号计算：纯十进制 X.Y.Z，无后缀计数器，不依赖 git tag。
 *
 * 用法：
 *   node scripts/next-version.mjs <nightly|beta|stable> [baseVersion]
 *   baseVersion 缺省取 package.json 的 version 字段
 *
 * 规则（base = 目标分支 package.json 的 version）：
 *   nightly: patch +0.0.1；patch 满 10 十进制进位到 minor（0.6.9 → 0.7.0）
 *   beta   : minor +0.1.0，patch 归零（nightly 计数归零）
 *   stable : major +1.0.0，minor/patch 全归零（beta 与 nightly 计数归零）
 *
 * 输出：纯版本号字符串到 stdout，供 CI 的 GITHUB_OUTPUT 使用。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const channel = process.argv[2];
if (!["stable", "beta", "nightly"].includes(channel)) {
  console.error(`[next-version] 未知渠道: ${channel}（可选 stable|beta|nightly）`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const base = process.argv[3] ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(base)) {
  console.error(`[next-version] base 版本不合法: ${base}（应为 X.Y.Z）`);
  process.exit(1);
}

const [maj, min, pat] = base.split(".").map(Number);

let next;
if (channel === "stable") {
  next = [maj + 1, 0, 0];
} else if (channel === "beta") {
  next = [maj, min + 1, 0];
} else {
  // nightly：patch 十进制递增，满 10 进位到 minor
  next = pat + 1 >= 10 ? [maj, min + 1, 0] : [maj, min, pat + 1];
}
console.log(next.join("."));
