import { describe, it, expect } from "vitest";
import { validateMigrate } from "./migrateValidate";

// 迁移校验：源账号为空串表示“全部（其它所有账号）”，是合法选择；
// 目标账号默认就是当前正在用的账号，仍必选；要求源 ≠ 目标。
describe("validateMigrate", () => {
  it("源为空串（全部）且目标有效时，校验通过", () => {
    expect(validateMigrate("", "uid-b")).toBeNull();
  });

  it("未选择目标账号时，提示选择目标账号", () => {
    expect(validateMigrate("uid-a", "")).toBe("请选择目标账号");
    expect(validateMigrate("", "")).toBe("请选择目标账号");
  });

  it("源账号与目标账号相同时报错", () => {
    expect(validateMigrate("uid-a", "uid-a")).toContain("相同");
  });

  it("源与目标都有效且不同时，校验通过", () => {
    expect(validateMigrate("uid-a", "uid-b")).toBeNull();
  });
});
