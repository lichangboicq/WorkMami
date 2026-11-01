import { Input } from "antd";
import type { InputProps } from "antd";
import type { ReactNode } from "react";

export type WmWidth = "fluid" | "full";

interface WmShellProps {
  /** fluid：壳宽随内容（上限为容器宽）；full：填满父容器 */
  width?: WmWidth;
  size?: InputProps["size"];
  /** 前缀格（如"标签"），由壳渲染，带独立底色与分隔线 */
  addonBefore?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * 三层输入壳：外层带边框，承载 hover/focus 视觉；内部一律 antd borderless 输入，
 * 宽度用 field-sizing: content 跟随内容。边框/圆角/高度/背景全在壳上，内部组件透明化。
 */
export function WmShell({
  width = "fluid",
  size,
  addonBefore,
  className,
  children,
}: WmShellProps) {
  const cls = [
    "wm-input-shell",
    width === "full" ? "wm-input-shell--full" : "wm-input-shell--fluid",
    size === "small" ? "wm-input-shell--sm" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls}>
      {addonBefore != null && (
        <span className="wm-input-shell__addon">{addonBefore}</span>
      )}
      {children}
    </span>
  );
}

export interface WmInputProps extends InputProps {
  width?: WmWidth;
  addonBefore?: ReactNode;
}

/** 常规文本输入 = 壳 + borderless Input；InputNumber / Input.Password 直接用 WmShell 包 */
export function WmInput({
  width = "fluid",
  addonBefore,
  className,
  ...rest
}: WmInputProps) {
  return (
    <WmShell width={width} size={rest.size} addonBefore={addonBefore} className={className}>
      <Input variant="borderless" {...rest} />
    </WmShell>
  );
}
