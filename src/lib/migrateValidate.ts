// 迁移表单校验：目标账号必选；源账号为空串表示“全部（其它所有账号）”，合法；
// 源与目标相同时报错。返回错误提示文案；通过时返回 null。
export function validateMigrate(fromUid: string, toUid: string): string | null {
  if (!toUid) return "请选择目标账号";
  if (fromUid && fromUid === toUid) return "源账号与目标账号不能相同";
  return null;
}
