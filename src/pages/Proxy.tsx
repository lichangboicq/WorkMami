import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { CopyOutlined, ReloadOutlined } from "@ant-design/icons";
import { api, errText } from "../api";
import { useStore } from "../store";
import type { ModelInfo, ProxySettings as PS } from "../types";

const { Text } = Typography;

/// 生成一串 SK- 开头的随机访问密钥（无需用户自设）。
function genApiKey(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  return `SK-${hex}`;
}

const copyText = (s: string, tip: string) => {
  navigator.clipboard.writeText(s);
  message.success(tip);
};

/** 浅比较两个对象的某个字段是否不同（支持嵌套 proxy 对象 + 标量字段） */
function isDifferent(a: unknown, b: unknown): boolean {
  if (a === b) return false;
  if (a == null || b == null) return true;
  if (typeof a !== typeof b) return true;
  if (typeof a === "object") return JSON.stringify(a) !== JSON.stringify(b);
  return true;
}

type SaveStatus = "idle" | "saving" | "error";

const FIELD_LABELS: Record<string, string> = {
  host: "监听地址",
  port: "端口",
  strategy: "积分调度策略",
  contextWindow: "上下文窗口(tokens)",
  reasoningEffort: "默认思考强度",
  stickyTtlMin: "会话粘性窗口(分钟)",
  maxRetries: "Failover 最大换号数",
  apiKey: "API Key",
  defaultModel: "默认模型",
};

export default function Proxy() {
  const settings = useStore((s) => s.settings);
  const proxy = useStore((s) => s.proxy);
  const saveSettings = useStore((s) => s.saveSettings);
  const reloadProxy = useStore((s) => s.reloadProxy);
  const syncStatus = useStore((s) => s.syncStatus);
  const syncAllIdes = useStore((s) => s.syncAllIdes);
  const proxyTestConnection = useStore((s) => s.proxyTestConnection);

  // form 内部状态：受控的 PS 值 + 额外 saveStatus
  const [formValues, setFormValues] = useState<PS>(settings.proxy);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveErrorMsg, setSaveErrorMsg] = useState<string>("");
  const [writingProgress, setWritingProgress] = useState(false);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");

  // Modal 状态
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideIdeId, setGuideIdeId] = useState<string>("workbuddy");

  // IDE 自动配置操作 loading
  const [syncAllLoading, setSyncAllLoading] = useState(false);
  const [testConnLoading, setTestConnLoading] = useState(false);

  // 防抖队列 + 写入中集合
  const writeQueueRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const writingSet = useRef<Set<string>>(new Set());

  // 顶部进度条淡出计时器
  const progressFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 组件卸载时清理所有未完成的 debounce 写入与进度条 timer
  useEffect(() => () => {
    Object.values(writeQueueRef.current).forEach(clearTimeout);
    if (progressFadeRef.current) clearTimeout(progressFadeRef.current);
  }, []);

  // 进入页面时同步 settings.proxy 到 formValues；密钥为空自动生成
  useEffect(() => {
    setFormValues((prev) => {
      const next: PS = { ...settings.proxy };
      if (!next.apiKey) next.apiKey = genApiKey();
      // 若原 apiKey 与 backend 一致且之前自动生成过的，保留新值
      return next;
    });
  }, [settings.proxy]);

  // —— 脏字段集合：当前 formValues 与 backend settings.proxy 逐字段比较 ——
  const dirty = useMemo(() => {
    const base = settings.proxy;
    const set = new Set<string>();
    for (const k of Object.keys(base) as (keyof PS)[]) {
      // apiKey 若 backend 为空而前端刚生成，不算 dirty（用户没改过）
      if (k === "apiKey" && !base.apiKey && formValues.apiKey && formValues.apiKey.startsWith("SK-")) {
        continue;
      }
      if (isDifferent(formValues[k], base[k])) set.add(k);
    }
    return set;
  }, [formValues, settings.proxy]);

  const hasUnsaved = dirty.size > 0;

  // —— 实时保存：触发顶部进度条动画 ——
  const triggerProgressBar = () => {
    setWritingProgress(true);
    if (progressFadeRef.current) clearTimeout(progressFadeRef.current);
    progressFadeRef.current = setTimeout(() => {
      setWritingProgress(false);
    }, 900);
  };

  // 通用：把合并后的完整 AppSettings 落盘
  const persistSettings = async (merged: typeof settings, immediateProgress = true) => {
    try {
      setSaveStatus("saving");
      if (immediateProgress) triggerProgressBar();
      await saveSettings(merged);
      setSaveStatus("idle");
      setSaveErrorMsg("");
    } catch (e) {
      setSaveStatus("error");
      setSaveErrorMsg(errText(e) || "保存失败");
    }
  };

  // —— 单字段 debounce 保存 ——
  // 使用 ref 跟踪最新 formValues，避免 setTimeout 闭包捕获旧值覆盖用户最新输入。
  const formValuesRef = useRef(formValues);
  formValuesRef.current = formValues;

  const onFieldChange = <K extends keyof PS>(name: K, next: PS[K]) => {
    // 更新本地表单值
    setFormValues((prev) => ({ ...prev, [name]: next }));

    // 防抖 300ms：同一字段连续修改只触发最后一次；
    // 新的修改进入时清掉上一次 timer，writingSet 保留该字段在写入中。
    if (writeQueueRef.current[name as string]) {
      clearTimeout(writeQueueRef.current[name as string]);
    }
    writingSet.current.add(name as string);

    writeQueueRef.current[name as string] = setTimeout(async () => {
      const merged: typeof settings = {
        ...settings,
        proxy: { ...formValuesRef.current, [name]: next },
      };
      await persistSettings(merged);
      writingSet.current.delete(name as string);
      delete writeQueueRef.current[name as string];
    }, 300);
  };

  // —— Switch toggle 立即保存 ——
  const onToggleEnabled = async (v: boolean) => {
    // 清掉所有 pending 的 debounce 写入，避免与本次 toggle 冲突
    Object.values(writeQueueRef.current).forEach(clearTimeout);
    writeQueueRef.current = {};

    const merged: typeof settings = { ...settings, proxy: { ...formValuesRef.current, enabled: v } };
    triggerProgressBar();
    try {
      setSaveStatus("saving");
      await saveSettings(merged);
      setSaveStatus("idle");
      setSaveErrorMsg("");
    } catch (e) {
      setSaveStatus("error");
      setSaveErrorMsg(errText(e) || "保存失败");
    }
  };

  // —— 手动重试保存（底部保存状态红点提示时）——
  const retrySave = async () => {
    // 把当前 formValues 全量落盘
    const merged: typeof settings = { ...settings, proxy: formValues };
    await persistSettings(merged);
  };

  // —— 一键自动配置全部 IDE ——
  const handleSyncAll = async () => {
    setSyncAllLoading(true);
    try {
      await syncAllIdes();
      message.success("自动配置完成");
    } catch (e) {
      message.error(errText(e) || "自动配置失败");
    } finally {
      setSyncAllLoading(false);
    }
  };

  // —— 测试连接 ——
  const handleTestConnection = async () => {
    setTestConnLoading(true);
    try {
      const r = await proxyTestConnection();
      if (r.ok) {
        message.success(
          `连接成功 · 状态 ${r.status ?? 200}${r.modelCount ? ` · 模型 ${r.modelCount}` : ""}`,
        );
      } else {
        message.error(r.message || r.error || "连接失败");
      }
    } catch (e) {
      message.error(errText(e) || "连接失败");
    } finally {
      setTestConnLoading(false);
    }
  };

  // —— 模型列表 ——
  const loadModels = async (silent = false) => {
    setModelsLoading(true);
    setModelsError("");
    try {
      const list = await api.listModels();
      setModels(list);
      if (list.length === 0) {
        setModelsError("未获取到模型，可能当前账号无权限");
      } else if (!silent) {
        message.success(`已获取 ${list.length} 个 WorkBuddy 模型`);
      }
    } catch (e) {
      setModelsError(errText(e) || "获取模型列表失败");
    } finally {
      setModelsLoading(false);
    }
  };
  useEffect(() => {
    loadModels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabled = formValues.enabled;
  const apiKey = formValues.apiKey;
  const defaultModel = formValues.defaultModel;

  // 选中模型后，以其官方参数为准自动回填上下文窗口 / 思考强度（仍可手动微调）。
  const onModelChange = (id: string) => {
    const m = models.find((x) => x.id === id);
    if (!m) return;
    const next: PS = { ...formValues, defaultModel: id };
    if (m.contextWindow > 0) next.contextWindow = m.contextWindow;
    if (m.defaultEffort) next.reasoningEffort = m.defaultEffort;
    setFormValues(next);
  };

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const badgeRe = /^badge:([^:#]+)(?::(#[0-9a-fA-F]{3,8}))?$/;
    const opts: { value: string; label: ReactNode }[] = models.map((m) => {
      seen.add(m.id);
      const badges = (m.tags || [])
        .filter((t) => t.startsWith("badge:"))
        .map((t) => {
          const mm = t.match(badgeRe);
          return mm ? { name: mm[1], color: mm[2] || "#8a8f98" } : { name: t.slice(6), color: "#8a8f98" };
        });
      const credits = (m.credits || "").match(/x[\d.]+/)?.[0] || "";
      const label = (
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", paddingRight: 8 }}>
          <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{m.name}</span>
          <div style={{ display: "flex", gap: 4, overflow: "hidden", flexShrink: 1 }}>
            {badges.map((b) => (
              <span
                key={b.name}
                style={{
                  color: b.color,
                  border: `1px solid ${b.color}`,
                  borderRadius: 4,
                  fontSize: 11,
                  lineHeight: "14px",
                  padding: "0 4px",
                  whiteSpace: "nowrap",
                }}
              >
                {b.name}
              </span>
            ))}
          </div>
          {credits && (
            <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: 12, whiteSpace: "nowrap" }}>
              {credits}
            </span>
          )}
        </div>
      );
      return { value: m.id, label };
    });
    if (defaultModel && !seen.has(defaultModel)) {
      opts.unshift({ value: defaultModel, label: "WorkMami Model" });
    }
    return opts;
  }, [models, defaultModel]);
  const selectedModel = models.find((m) => m.id === defaultModel);

  // 监听地址若为 0.0.0.0（监听所有网卡），给本地客户端展示回环地址
  const displayHost = formValues.host === "0.0.0.0" ? "127.0.0.1" : formValues.host;
  const baseUrl = `http://${displayHost}:${formValues.port}/v1`;

  const running = Boolean(proxy?.running);

  // —— SaveStatus 指示组件（跟随状态自动换色） ——
  const saveStatusBadge = useMemo(() => {
    if (saveStatus === "error") {
      return (
        <Tooltip title={saveErrorMsg || "保存失败"}>
          <span
            className="wm-save-status is-error"
            style={{ color: "#ff4d4f", cursor: "pointer" }}
            onClick={retrySave}
          >
            <span className="wm-save-status__dot" />
            ⚠ 保存失败 · 重试
          </span>
        </Tooltip>
      );
    }
    if (saveStatus === "saving") {
      return (
        <span className="wm-save-status is-saving" style={{ color: "#1677ff" }}>
          <span className="wm-save-status__dot" />
          保存中…
        </span>
      );
    }
    if (hasUnsaved) {
      return (
        <span className="wm-save-status is-dirty" style={{ color: "#fa8c16" }}>
          <span className="wm-save-status__dot" />
          ● 有未保存的改动
        </span>
      );
    }
    return (
      <span className="wm-save-status is-idle" style={{ color: "#52c41a" }}>
        <span className="wm-save-status__dot" />
        已自动保存
      </span>
    );
  }, [saveStatus, saveErrorMsg, hasUnsaved]);

  // —— 6 个能力复选框（Modal 内使用）——
  const capChecks: { label: string; checked: boolean; tip: string }[] = [
    { label: "工具调用", checked: Boolean(selectedModel?.supportsToolCall), tip: "自动跟随所选模型" },
    { label: "图片输入", checked: Boolean(selectedModel?.supportsImages), tip: "自动跟随所选模型" },
    { label: "思考模式", checked: Boolean(selectedModel?.supportsReasoning), tip: "自动跟随所选模型" },
    { label: "仅思考模式", checked: Boolean(selectedModel?.raw?.onlyReasoning), tip: "自动跟随所选模型" },
    {
      label: "允许关闭思考",
      checked: Boolean(
        (selectedModel?.raw?.reasoning as Record<string, unknown> | undefined)?.canDisableThinking,
      ),
      tip: "自动跟随所选模型",
    },
    { label: "自定义协议", checked: false, tip: "无需勾选" },
  ];

  // —— 脏红点 ——
  const dirtyDot = (field: keyof PS) =>
    dirty.has(field) ? <span title="已修改，等待保存" className="wm-dirty-dot" /> : null;

  // —— SyncResult 状态徽标 ——
  const ideStatusBadge = (synced: boolean, error?: string | null) => {
    if (error) return <Tag color="red">⚠ 错误</Tag>;
    if (synced) return <Tag color="green">✓ 已自动配置</Tag>;
    return <Tag color="orange">⚠ 检测到</Tag>;
  };

  // —— 可见的 IDE 卡：detected=false 的不渲染 ——
  const ideCards = syncStatus.filter((s) => s.detected);

  return (
    <div className="wm-page">
      {/* ============ 顶部细进度条 ============ */}
      {writingProgress && <div aria-hidden className="wm-top-progress" />}

      {/* ============ ① IDE 自动配置 网格 ============ */}
      {ideCards.length > 0 && (
        <div className="wm-section-wrap">
          <div className="wm-section-title">
            <span>① IDE 自动配置</span>
            <Space size={8}>
              <Button onClick={handleSyncAll} loading={syncAllLoading}>
                一键自动配置全部
              </Button>
              <Button onClick={handleTestConnection} loading={testConnLoading}>
                🔗 测试连接
              </Button>
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                自动触发：保存 / 启动反向代理 / 模型刷新
              </Text>
            </Space>
          </div>
          <div className="wm-ide-grid">
            {ideCards.map((ide) => (
              <Card
                key={ide.id}
                size="small"
                title={ide.label}
                style={{ borderRadius: 6 }}
                extra={ideStatusBadge(ide.synced, ide.error)}
              >
                {ide.error ? (
                  <div style={{ color: "#ff4d4f", fontSize: 12 }}>{ide.error}</div>
                ) : ide.synced ? (
                  <div style={{ fontSize: 12, color: "#52c41a" }}>
                    已同步 {ide.written} 个模型到 {ide.label} 模型列表
                  </div>
                ) : (
                  <Space size={8}>
                    <span style={{ fontSize: 12 }}>检测到 {ide.label} 未配置</span>
                    {ide.hasManualGuide && (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => {
                          setGuideIdeId(ide.id);
                          setGuideOpen(true);
                        }}
                      >
                        ？手工配置
                      </Button>
                    )}
                  </Space>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ============ ② WorkMami 设置 ============ */}
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>② WorkMami 设置</span>
            {saveStatusBadge}
          </div>
        }
      >
        {/* Switch 行 */}
        <div className="wm-switch-row">
          <Switch
            checked={enabled}
            checkedChildren="已开启"
            unCheckedChildren="已关闭"
            onChange={onToggleEnabled}
          />
          {dirtyDot("enabled")}
          <Tag color={running ? "green" : enabled ? "orange" : "default"}>
            {running ? "服务运行中" : enabled ? "待启动" : "未启用"}
          </Tag>
        </div>

        {/* 虚线分隔 */}
        <hr className="wm-divider-dashed" />

        {/* 字段网格 */}
        <div className="wm-field-grid">
          {/* 默认模型 —— 占 2 列 */}
          <div className="wm-field-grid__span-2">
            <label className="wm-field-label">
              <span className="wm-field-label__text">默认模型</span>
              {dirtyDot("defaultModel")}
            </label>
            <Space.Compact style={{ width: "100%" }}>
              <Select
                showSearch
                style={{ width: "100%" }}
                value={defaultModel || undefined}
                placeholder="选择模型"
                optionFilterProp="label"
                loading={modelsLoading}
                options={modelOptions}
                onChange={(id) => onModelChange(id)}
                notFoundContent={modelsLoading ? "加载中…" : modelsError || "点右侧刷新获取模型"}
              />
              <Tooltip title="刷新模型列表">
                <Button icon={<ReloadOutlined />} loading={modelsLoading} onClick={() => loadModels()} />
              </Tooltip>
            </Space.Compact>
            {modelsError && <div style={{ color: "#ff4d4f", fontSize: 12, marginTop: 2 }}>{modelsError}</div>}
          </div>

          {/* 监听地址 */}
          <div>
            <label className="wm-field-label">
              <span className="wm-field-label__text">{FIELD_LABELS.host}</span>
              {dirtyDot("host")}
            </label>
            <Input
              value={formValues.host}
              placeholder="默认 127.0.0.1"
              onChange={(e) => onFieldChange("host", e.target.value)}
            />
          </div>

          {/* 端口 */}
          <div>
            <label className="wm-field-label">
              <span className="wm-field-label__text">{FIELD_LABELS.port}</span>
              {dirtyDot("port")}
            </label>
            <InputNumber
              style={{ width: "100%" }}
              min={1}
              max={65535}
              placeholder="默认 8765"
              value={formValues.port}
              onChange={(v) => onFieldChange("port", (v ?? 0) as number)}
            />
          </div>

          {/* API Key —— 跨 3 列 */}
          <div className="wm-field-grid__span-3">
            <label className="wm-field-label">
              <span className="wm-field-label__text">{FIELD_LABELS.apiKey}</span>
              {dirtyDot("apiKey")}
            </label>
            <Space.Compact style={{ width: "100%" }}>
              <Input.Password
                value={apiKey}
                className="wm-mono"
                onChange={(e) => onFieldChange("apiKey", e.target.value)}
              />
              <Tooltip title="复制">
                <Button icon={<CopyOutlined />} onClick={() => copyText(apiKey, "已复制 API Key")} />
              </Tooltip>
              <Tooltip title="重生成新密钥">
                <Button
                  icon={<ReloadOutlined />}
                  onClick={() => {
                    const nk = genApiKey();
                    setFormValues((prev) => ({ ...prev, apiKey: nk }));
                    onFieldChange("apiKey", nk);
                    message.success("已生成新密钥，正在自动保存");
                  }}
                />
              </Tooltip>
            </Space.Compact>
          </div>

          {/* 积分调度策略 */}
          <div>
            <label className="wm-field-label">
              <span className="wm-field-label__text">{FIELD_LABELS.strategy}</span>
              {dirtyDot("strategy")}
            </label>
            <Select
              style={{ width: "100%" }}
              value={formValues.strategy}
              options={[
                { value: "expiring-first", label: "先消耗临近到期的积分" },
                { value: "smart", label: "先消耗余额多的账号" },
                { value: "drain", label: "先消耗余额少的账号" },
                { value: "round-robin", label: "各账号平均消耗" },
              ]}
              onChange={(v) => onFieldChange("strategy", v as PS["strategy"])}
            />
          </div>

          {/* 上下文窗口(tokens) */}
          <div>
            <label className="wm-field-label">
              <span className="wm-field-label__text">{FIELD_LABELS.contextWindow}</span>
              {dirtyDot("contextWindow")}
            </label>
            <InputNumber
              style={{ width: "100%" }}
              min={1000}
              step={1000}
              value={formValues.contextWindow}
              onChange={(v) => onFieldChange("contextWindow", (v ?? 0) as number)}
            />
            {selectedModel?.contextWindow && (
              <div style={{ fontSize: 11, color: "#8c8c8c", marginTop: 2 }}>
                所选模型上限 {selectedModel.contextWindow.toLocaleString()}，可手动调低
              </div>
            )}
          </div>

          {/* 默认思考强度 */}
          <div>
            <label className="wm-field-label">
              <span className="wm-field-label__text">{FIELD_LABELS.reasoningEffort}</span>
              {dirtyDot("reasoningEffort")}
            </label>
            <Select
              style={{ width: "100%" }}
              value={formValues.reasoningEffort}
              options={[
                { value: "none", label: "关闭" },
                { value: "low", label: "低" },
                { value: "medium", label: "中" },
                { value: "high", label: "高" },
              ]}
              onChange={(v) => onFieldChange("reasoningEffort", v as string)}
            />
          </div>

          {/* 会话粘性窗口(分钟) */}
          <div>
            <label className="wm-field-label">
              <span className="wm-field-label__text">{FIELD_LABELS.stickyTtlMin}</span>
              {dirtyDot("stickyTtlMin")}
            </label>
            <InputNumber
              style={{ width: "100%" }}
              min={0}
              value={formValues.stickyTtlMin}
              onChange={(v) => onFieldChange("stickyTtlMin", (v ?? 0) as number)}
            />
          </div>

          {/* Failover 最大换号数 */}
          <div>
            <label className="wm-field-label">
              <span className="wm-field-label__text">{FIELD_LABELS.maxRetries}</span>
              {dirtyDot("maxRetries")}
            </label>
            <InputNumber
              style={{ width: "100%" }}
              min={1}
              max={10}
              value={formValues.maxRetries}
              onChange={(v) => onFieldChange("maxRetries", (v ?? 1) as number)}
            />
          </div>
        </div>

        {/* 底部说明 */}
        <div className="wm-footer-note">
          自动保存后 WorkBuddy 即可自动发现模型（已自动配置到 WorkBuddy 模型列表）。
        </div>
      </Card>

      {/* ============ Modal: 手工配置向导 ============ */}
      <Modal
        open={guideOpen}
        onCancel={() => setGuideOpen(false)}
        title="WorkBuddy 手工配置向导"
        footer={null}
        width={560}
        maskClosable
        destroyOnHidden
      >
        <div style={{ color: "#8c8c8c", fontSize: 12, marginBottom: 16 }}>
          自动配置失败或需要逐项核对时使用。WorkMami 已把支持的模型自动写入 WorkBuddy 的模型列表，重启 WorkBuddy 即可直接选用，通常无需手工配置。
        </div>

        {/* 绿色通用区 */}
        <div className="wm-guide-block wm-guide-block--green">
          <div style={{ fontWeight: 500, marginBottom: 8 }}>接口地址 + API Key（填到 WorkBuddy 对应字段）</div>
          <div style={{ fontSize: 12, color: "#595959", marginBottom: 4 }}>接口地址</div>
          <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
            <Input readOnly value={baseUrl} className="wm-mono" />
            <Tooltip title="复制">
              <Button icon={<CopyOutlined />} onClick={() => copyText(baseUrl, "已复制接口地址")} />
            </Tooltip>
          </Space.Compact>

          <div style={{ fontSize: 12, color: "#595959", marginBottom: 4 }}>API Key</div>
          <Space.Compact style={{ width: "100%" }}>
            <Input.Password readOnly value={apiKey} className="wm-mono" visibilityToggle />
            <Tooltip title="复制">
              <Button icon={<CopyOutlined />} onClick={() => copyText(apiKey, "已复制 API Key")} />
            </Tooltip>
          </Space.Compact>
        </div>

        {/* 蓝色提示条 */}
        <div className="wm-guide-block wm-guide-block--blue">
          WorkBuddy 设置 → 模型 → 添加模型，逐项照抄、复制粘贴即可。
        </div>

        {/* 中间白区：供应商 + 模型名称 + 高级配置 + 默认思考强度 */}
        <div className="wm-guide-block wm-guide-block--white">
          <div style={{ marginBottom: 10 }}>
            <Text strong>供应商（仅支持 OpenAI 兼容协议 API）</Text>
            <div style={{ marginTop: 4 }}>
              <Input readOnly value="自定义" className="wm-mono" />
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <Text strong>模型名称</Text>
            <div style={{ marginTop: 4 }}>
              <Select
                showSearch
                style={{ width: "100%" }}
                value={defaultModel || undefined}
                placeholder="选择模型"
                optionFilterProp="label"
                loading={modelsLoading}
                options={modelOptions}
                onChange={(id) => onModelChange(id)}
                notFoundContent={modelsLoading ? "加载中…" : modelsError || "点右侧刷新获取模型"}
              />
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <Text strong>高级配置</Text>
            <Text type="secondary" style={{ display: "block", marginBottom: 6 }}>
              已按所选模型自动勾好，照此勾选：
            </Text>
            <Space size={14} wrap>
              {capChecks.map((c) => (
                <Tooltip title={c.tip} key={c.label}>
                  <Checkbox checked={c.checked} disabled>
                    {c.label}
                  </Checkbox>
                </Tooltip>
              ))}
            </Space>
          </div>

          <div>
            <Text strong>默认思考强度</Text>
            <Select
              disabled
              value="auto"
              style={{ width: "100%", marginTop: 4 }}
              options={[{ value: "auto", label: "自动" }]}
            />
          </div>
        </div>

        {/* 底部灰色区：最后一步 */}
        <div className="wm-guide-block wm-guide-block--gray">
          <Text strong>最后一步</Text>
          <div style={{ fontSize: 12, color: "#595959", marginTop: 4 }}>
            在 WorkBuddy 弹窗点「测试连接」，成功后保存即可；WorkMami 会在后台自动分配账号与积分。
          </div>
        </div>
      </Modal>
    </div>
  );
}
