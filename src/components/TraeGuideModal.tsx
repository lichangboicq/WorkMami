// TRAE 手动配置指导页（所见即所得）：
// 1:1 复刻 TRAE「自定义模型」弹窗界面，把 WorkMami 的真实配置值
// （请求地址 / 模型 ID / 展示名称 / API 密钥）直接填进对应输入框，
// 用户点击输入框即可复制，再去真实的 TRAE 里粘贴完成配置。
// 注意：复刻面板固定使用 TRAE 的浅色视觉（对截图还原），不随应用主题切换。
import { useState } from "react";
import { Modal, Select, Tooltip, message } from "antd";
import {
  AppstoreOutlined,
  ApiOutlined,
  CodeOutlined,
  CopyOutlined,
  DesktopOutlined,
  DownOutlined,
  ExperimentOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileTextOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  LeftOutlined,
  LinkOutlined,
  NodeIndexOutlined,
  RightOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { ModelPool } from "../types";

interface TraeGuideModalProps {
  open: boolean;
  onClose: () => void;
  host: string;
  port: number;
  apiKey: string;
  pools: ModelPool[];
}

// TRAE 设置左侧导航（截图原样复刻；「模型」高亮）
const SIDE_ITEMS = [
  { label: "浏览器", icon: <GlobalOutlined /> },
  { label: "电脑控制", icon: <DesktopOutlined /> },
  { label: "桌面悬浮球", icon: <ExperimentOutlined /> },
  { label: "智能体", icon: <RobotOutlined /> },
  { label: "CUE", icon: <ThunderboltOutlined /> },
  { label: "模型", icon: <NodeIndexOutlined />, active: true },
  { label: "插件市场", icon: <AppstoreOutlined /> },
  { label: "MCP", icon: <ApiOutlined /> },
  { label: "技能与命令", icon: <CodeOutlined /> },
  { label: "规则与记忆", icon: <FileTextOutlined /> },
  { label: "Hooks", icon: <ApiOutlined /> },
  { label: "Beta", icon: <ExperimentOutlined /> },
];

const copyText = (s: string, tip: string) => {
  // 剪贴板 API 失败时回退 execCommand（WebView/受控浏览器里偶发权限拒绝）
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      message.success(tip);
    } catch {
      message.error("复制失败，请手动选择文本复制");
    }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(s)
      .then(() => message.success(tip))
      .catch(fallback);
  } else {
    fallback();
  }
};

export default function TraeGuideModal({
  open,
  onClose,
  host,
  port,
  apiKey,
  pools,
}: TraeGuideModalProps) {
  const [poolIdx, setPoolIdx] = useState(0);
  const [showKey, setShowKey] = useState(false);

  // 0.0.0.0 对用户无意义，展示时统一转 127.0.0.1（与后端同步逻辑一致）
  const displayHost = host === "0.0.0.0" || !host ? "127.0.0.1" : host;
  // TRAE 提示：填基础端点，/chat/completions 由 TRAE 自动补齐
  const baseUrl = `http://${displayHost}:${port}/v1`;

  const pool: ModelPool | undefined = pools[poolIdx] ?? pools[0];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={820}
      centered
      title="TRAE 自定义模型 · 配置指导"
    >
      {pools.length === 0 && (
        <div className="wm-trae-guide-empty">
          还没有模型池——先在下方「模型池」看板新建一个池，再来复制配置。
        </div>
      )}

      {pool && (
        <div className="wm-trae-guide" aria-label="TRAE 自定义模型界面复刻">
          {/* ======== 左侧导航（TRAE 设置页复刻） ======== */}
          <div className="wm-trae-guide__side">
            <div className="wm-trae-guide__search">Ctrl+F 搜索</div>
            {SIDE_ITEMS.map((it) => {
              const nav = (
                <div
                  key={it.label}
                  className={`wm-trae-guide__nav${it.active ? " is-active" : ""}`}
                >
                  <span className="wm-trae-guide__nav-icon">{it.icon}</span>
                  {it.label}
                </div>
              );
              return it.active ? (
                <Tooltip key={it.label} title="添加模型-自定义模型">
                  {nav}
                </Tooltip>
              ) : (
                nav
              );
            })}
          </div>

          {/* ======== 右侧：自定义模型弹窗复刻 ======== */}
          <div className="wm-trae-guide__panel">
            <div className="wm-trae-guide__head">
              <LeftOutlined className="wm-trae-guide__back" />
              <span className="wm-trae-guide__title">自定义模型</span>
            </div>

            <div className="wm-trae-guide__body">
              {/* API 格式 */}
              <div className="wm-trae-guide__label">
                <i>*</i>API 格式
              </div>
              <Tooltip title="维持默认">
                <div className="wm-trae-guide__select">
                  <span>OpenAI Chat Completions 格式</span>
                  <DownOutlined className="wm-trae-guide__chevron" />
                </div>
              </Tooltip>

              {/* 自定义请求地址 */}
              <div className="wm-trae-guide__label wm-trae-guide__label--row">
                <span>
                  <i>*</i>自定义请求地址
                </span>
                <span className="wm-trae-guide__fullurl">
                  <LinkOutlined />
                  完整 URL
                  <span className="wm-trae-guide__switch" aria-hidden />
                </span>
              </div>
              <p className="wm-trae-guide__hint">
                请填写兼容 OpenAI API 的服务端点地址，不要以斜杠结尾。/chat/completions
                将会被补齐到你填写的地址末尾。
              </p>
              <Tooltip title="点击复制请求地址">
                <div
                  className="wm-trae-guide__input is-copyable"
                  onClick={() => copyText(baseUrl, "已复制请求地址，去 TRAE 粘贴")}
                >
                  <span className="wm-mono">{baseUrl}</span>
                  <CopyOutlined className="wm-trae-guide__copy" />
                </div>
              </Tooltip>

              {/* 模型 ID：下拉框列出全部模型池，选中即复制 */}
              <div className="wm-trae-guide__label">
                <i>*</i>模型 ID
              </div>
              <Tooltip title="下拉选择模型池，选中即复制其模型 ID">
                <div className="wm-trae-guide__input is-select">
                  <Select
                    variant="borderless"
                    className="wm-trae-guide__pool-select"
                    value={pool.id}
                    options={pools.map((p) => ({ value: p.id, label: p.id }))}
                    onSelect={(v) => {
                      const idx = pools.findIndex((p) => p.id === v);
                      if (idx >= 0) setPoolIdx(idx);
                      copyText(String(v), `已复制模型 ID「${v}」，去 TRAE 粘贴`);
                    }}
                    popupMatchSelectWidth={false}
                    popupClassName="wm-trae-guide__pool-dropdown"
                  />
                </div>
              </Tooltip>

              {/* 模型展示名称 */}
              <div className="wm-trae-guide__label">模型展示名称</div>
              <p className="wm-trae-guide__hint">
                在模型列表中展示的名称，未设置时默认显示 Model ID。
              </p>
              <Tooltip title="点击复制展示名称">
                <div
                  className="wm-trae-guide__input is-copyable"
                  onClick={() => copyText(pool.name, "已复制展示名称，去 TRAE 粘贴")}
                >
                  <span>{pool.name}</span>
                  <span className="wm-trae-guide__counter">
                    {pool.name.length}/64
                  </span>
                </div>
              </Tooltip>

              {/* API 密钥 */}
              <div className="wm-trae-guide__label">
                <i>*</i>API 密钥
              </div>
              <Tooltip title="点击复制 API 密钥">
                <div
                  className="wm-trae-guide__input is-copyable"
                  onClick={() => copyText(apiKey, "已复制 API 密钥，去 TRAE 粘贴")}
                >
                  <span className="wm-mono">
                    {showKey ? apiKey : "•".repeat(Math.min(apiKey.length || 24, 32))}
                  </span>
                  <span className="wm-trae-guide__eye" onClick={(e) => { e.stopPropagation(); setShowKey((v) => !v); }}>
                    {showKey ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                  </span>
                  <CopyOutlined className="wm-trae-guide__copy" />
                </div>
              </Tooltip>

              {/* 高级配置 */}
              <div className="wm-trae-guide__advanced">
                <span>高级配置</span>
                <RightOutlined className="wm-trae-guide__chevron" />
              </div>

              {/* 底部：提示 + 按钮 */}
              <div className="wm-trae-guide__foot">
                <span className="wm-trae-guide__note">
                  <InfoCircleOutlined />
                  连通性测试会发起一次真实请求，会消耗少量模型Token
                </span>
                <span className="wm-trae-guide__btns">
                  <span className="wm-trae-guide__btn">重置</span>
                  <span className="wm-trae-guide__btn is-primary">添加模型</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
