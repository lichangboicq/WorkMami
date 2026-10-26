#!/usr/bin/env node
/**
 * 发版版本号计算：stable / beta / nightly 三渠道自动递增。
 *
 * 用法：
 *   node scripts/next-version.mjs <stable|beta|nightly> [baseVersion]
 *   baseVersion 缺省取 package.json 的 version 字段
 *
 * 规则（base = 目标分支 package.json 的 version）：
 *   stable : max(base, 仓库中最新 stable tag vX.Y.Z)；
 *            若该值已作为 stable tag 发过，则 patch +0.0.1
 *            （例：base=0.6.0、已有 v0.6.0 → 0.6.1；base=0.7.0、最新 tag 0.6.0 → 0.7.0）
 *   beta   : base-beta.N，N = 已有 *-beta.N tag 最大值 + 1（无则 1）
 *   nightly: base-nightly.N，N = 已有 *-nightly.N tag 最大值 + 1（无则 1）
 *
 * 输出：纯版本号字符串到 stdout，供 CI 的 GITHUB_OUTPUT 使用。
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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

const tags = execSync("git tag -l", { cwd: root }).toString().trim().split("\n").filter(Boolean);

const parse = (v) => v.split(".").map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

if (channel === "stable") {
  // 只认纯 stable tag（vX.Y.Z，不带 -beta./-nightly. 后缀）
  let latest = [0, 0, 0];
  for (const t of tags) {
    const m = t.match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const v = [+m[1], +m[2], +m[3]];
      if (cmp(v, latest) > 0) latest = v;
    }
  }
  // base 领先于最新 stable tag → 直接发 base；否则从最新 tag 顺延 patch
  const next = cmp(parse(base), latest) > 0 ? parse(base) : [latest[0], latest[1], latest[2] + 1];
  console.log(next.join("."));
} else {
  // beta / nightly：各自渠道的构建计数 +1
  let last = 0;
  const re = new RegExp(`-${channel}\\.(\\d+)$`);
  for (const t of tags) {
    const m = t.match(re);
    if (m) last = Math.max(last, Number(m[1]));
  }
  console.log(`${base}-${channel}.${last + 1}`);
}
