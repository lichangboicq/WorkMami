import { useEffect, useMemo, useState } from "react";
import { ConfigProvider, Layout, Menu, Segmented, theme as antdTheme } from "antd";
import type { ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  CloudServerOutlined,
  CompassOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  GiftOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { useStore } from "./store";
import logo from "./assets/logo.png";
import wechatQr from "./assets/wechat-qr.jpg";
import Accounts from "./pages/Accounts";
import ProxySettings from "./pages/Proxy";
import DataPage from "./pages/Data";
import Checkin from "./pages/Checkin";
import Travel from "./pages/Travel";
import Dashboard from "./pages/Dashboard";

const { Sider, Content, Header } = Layout;

const MENU = [
  { key: "accounts", label: "账号管理", icon: <TeamOutlined /> },
  { key: "proxy", label: "自定义模型", icon: <CloudServerOutlined /> },
  { key: "data", label: "数据管理", icon: <DatabaseOutlined /> },
  { key: "checkin", label: "签到中心", icon: <GiftOutlined /> },
  { key: "travel", label: "猫猫旅行", icon: <CompassOutlined /> },
  { key: "dashboard", label: "Token 看板", icon: <DashboardOutlined /> },
];

function useSystemDark() {
  const [sysDark, setSysDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);
  return sysDark;
}

function SiderFooter({ isDark }: { isDark: boolean }) {
  const sub = isDark ? "#9a9aa6" : "#5b5568";
  const faint = isDark ? "#6f6f7a" : "#8a8397";
  const divider = isDark ? "#1f1f26" : "#ece8ef";
  return (
    <div
      style={{
        marginTop: "auto",
        padding: "14px 16px 16px",
        textAlign: "center",
        userSelect: "text",
      }}
    >
      <img
        src={wechatQr}
        alt="老马公众号二维码"
        style={{
          width: 104,
          height: 104,
          borderRadius: 8,
          display: "block",
          margin: "0 auto 6px",
          background: "#fff",
          padding: 4,
        }}
      />
      <div style={{ fontSize: 12, color: sub, marginBottom: 8 }}>
        扫一扫关注老马公众号
      </div>
      <div style={{ fontSize: 12, color: sub, lineHeight: 1.7 }}>
        <div>个人博客：www.majiabin.com</div>
      </div>
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: `1px solid ${divider}`,
          fontSize: 11,
          color: faint,
          lineHeight: 1.6,
        }}
      >
        本工具仅供个人学习研究使用
        <br />
        一切非法用途责任自负
      </div>
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState("accounts");
  const init = useStore((s) => s.init);
  const themePref = useStore((s) => s.settings.theme);
  const setThemePref = useStore((s) => s.setThemePref);
  const sysDark = useSystemDark();

  useEffect(() => {
    void init();
  }, [init]);

  const isDark = themePref === "dark" || (themePref === "system" && sysDark);

  const theme = useMemo<ThemeConfig>(
    () => ({
      token: {
        // 品牌色：与 Logo 玫瑰粉渐变同色系，替换默认 antd 蓝
        colorPrimary: "#ec4899",
        colorInfo: "#ec4899",
        borderRadius: 10,
        // fontSize 回到 antd 默认 14 —— 之前 13 让全页面缩小一截
        fontSize: 14,
        controlHeight: 36,
        controlHeightSM: 30,
        controlItemBgHover: isDark ? "rgba(236,72,153,0.16)" : "rgba(236,72,153,0.08)",
        colorBgLayout: isDark ? "#0b0b0d" : "#f6f5f7",
        colorBgContainer: isDark ? "#141418" : "#ffffff",
        colorBorderRadiusSecondary: 8,
        wireframe: false,
        ...(isDark
          ? {
              colorText: "rgba(255,255,255,0.88)",
              colorTextSecondary: "rgba(255,255,255,0.65)",
              colorTextTertiary: "rgba(255,255,255,0.45)",
              colorTextDisabled: "rgba(255,255,255,0.4)",
            }
          : {
              colorTextSecondary: "rgba(22,16,28,0.62)",
              colorTextTertiary: "rgba(22,16,28,0.42)",
              colorTextPlaceholder: "rgba(22,16,28,0.38)",
              colorTextDisabled: "rgba(22,16,28,0.42)",
            }),
      },
      algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    }),
    [isDark],
  );

  const siderBg = isDark ? "#0f0f13" : "#ffffff";
  const siderBorder = isDark ? "#1f1f26" : "#ece8ef";
  const headerBg = isDark ? "#141418" : "#ffffff";
  const contentBg = isDark ? "#0b0b0d" : "#f6f5f7";
  const subText = isDark ? "#9a9aa6" : "#5b5568";
  const faintText = isDark ? "#6f6f7a" : "#8a8397";
  const divider = isDark ? "#1f1f26" : "#ece8ef";

  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <Layout style={{ height: "100vh" }}>
        <Sider width={240} theme={isDark ? "dark" : "light"}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100vh",
              background: siderBg,
              borderRight: `1px solid ${siderBorder}`,
            }}
          >
          <div
            style={{
              height: 72,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 16px",
              borderBottom: `1px solid ${siderBorder}`,
            }}
          >
            <img
              src={logo}
              alt="WorkMami"
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                display: "block",
                boxShadow: "0 3px 14px rgba(236,72,153,0.35)",
              }}
            />
            <div style={{ lineHeight: 1.15 }}>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  letterSpacing: 7,
                  marginRight: -7,
                  background: "linear-gradient(95deg,#ec4899 0%,#f472b6 55%,#fb7185 100%)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                WorkMami
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: subText,
                  marginTop: 2,
                  letterSpacing: 0.3,
                  whiteSpace: "nowrap",
                }}
              >
                WorkBuddy的妈咪稳稳接住你
              </div>
            </div>
          </div>
          <Menu
            theme={isDark ? "dark" : "light"}
            mode="inline"
            selectedKeys={[active]}
            items={MENU}
            onClick={(e) => setActive(e.key)}
          />
          <SiderFooter isDark={isDark} />
          </div>
        </Sider>
        <Layout>
          <Header
            style={{
              background: headerBg,
              padding: "0 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              height: 56,
              lineHeight: "56px",
              borderBottom: `1px solid ${divider}`,
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0.2 }}>
              {MENU.find((m) => m.key === active)?.label}
            </span>
            <Segmented
              value={themePref}
              onChange={(v) => setThemePref(v as string)}
              options={[
                { label: "跟随系统", value: "system" },
                { label: "暗色", value: "dark" },
                { label: "亮色", value: "light" },
              ]}
            />
          </Header>
          <Content style={{ background: contentBg }}>
            {active === "accounts" && <Accounts />}
            {active === "proxy" && <ProxySettings />}
            {active === "data" && <DataPage />}
            {active === "checkin" && <Checkin />}
            {active === "travel" && <Travel />}
            {active === "dashboard" && <Dashboard />}
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
