import type { CSSProperties } from "react";

// WorkBuddy 官方图标集（取自 www.workbuddy.cn usercenter 前端 bundle，TDesign 图标，
// currentColor 单色，随文字着色/置灰）。与 Accounts.tsx 的 GrowthPlanIcon 同源、同风格。
// 仅用项目锁定的这一套 SVG 图标，不混用 emoji / 其它图标库（P0-1）。

type IconProps = { style?: CSSProperties; onClick?: () => void };

function baseStyle(style?: CSSProperties): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    verticalAlign: "-0.125em",
    ...style,
  };
}

// 账单 / 积分清单：收据形（左下/右下锯齿），对应 WorkBuddy「套餐积分账单」入口
export function BillIcon({ style, onClick }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={baseStyle(style)}
      onClick={onClick}
    >
      <path
        d="M5 3H19M5 3V20L7.5 18L9.75 20L12 18L14.25 20L16.5 18L19 20V3M5 3H3M19 3H21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path
        d="M9 8H15M10 12H14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}

// 信息提示：圆环 + 「i」，对应原 ⓘ 信息图标
export function InfoIcon({ style, onClick }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={baseStyle(style)}
      onClick={onClick}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M12 11V16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7.6" r="1.3" fill="currentColor" />
    </svg>
  );
}
