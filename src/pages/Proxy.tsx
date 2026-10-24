import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tooltip,
  message,
} from "antd";
import { CopyOutlined, ReloadOutlined } from "@ant-design/icons";
import { api, errText } from "../api";
import { useStore } from "../store";
import type { ModelInfo, ProxySettings as PS } from "../types";

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

// IDE 演示 GIF 登记表：图片产出后放入 public/ 再按 ide.id 登记，hover 时以 tooltip 展示；未登记的回退为状态文字
const IDE_DEMO_GIFS: Record<string, string> = {};

const FIELD_LABELS: Record<string, string> = {
  host: "监听地址",
  port: "端口",
  strategy: "积分调度策略",
  reasoningEffort: "默认思考强度",
  apiKey: "API Key",
};

export default function Proxy() {
  const settings = useStore((s) => s.settings);
  const proxy = useStore((s) => s.proxy);
  const saveSettings = useStore((s) => s.saveSettings);
  const syncStatus = useStore((s) => s.syncStatus);
  const refreshSyncStatus = useStore((s) => s.refreshSyncStatus);

  // form 内部状态：受控的 PS 值 + 额外 saveStatus
  const [formValues, setFormValues] = useState<PS>(settings.proxy);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveErrorMsg, setSaveErrorMsg] = useState<string>("");
  const [writingProgress, setWritingProgress] = useState(false);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

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

  // —— 模型列表 ——
  const loadModels = async (silent = false) => {
    setModelsLoading(true);
    try {
      const list = await api.listModels();
      setModels(list);
      if (list.length === 0) {
        if (!silent) message.warning("未获取到模型，可能当前账号无权限");
      } else if (!silent) {
        message.success(`已获取 ${list.length} 个 WorkBuddy 模型`);
      }
    } catch (e) {
      message.warning(errText(e) || "获取模型列表失败");
    } finally {
      setModelsLoading(false);
      // list_models 返回前已等待 IDE 同步写盘完成，这里刷新即拿到真实状态
      void refreshSyncStatus();
    }
  };
  useEffect(() => {
    loadModels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabled = formValues.enabled;
  const apiKey = formValues.apiKey;

  const running = Boolean(proxy?.running);

  // —— SaveStatus 指示（点为主，仅错误态带文字） ——
  const saveStatusBadge = useMemo(() => {
    if (saveStatus === "error") {
      return (
        <Tooltip title={saveErrorMsg || "保存失败"}>
          <span className="wm-save-status is-error" onClick={retrySave}>
            <span className="wm-save-status__dot" />
            重试
          </span>
        </Tooltip>
      );
    }
    if (saveStatus === "saving") {
      return (
        <span className="wm-save-status is-saving">
          <span className="wm-save-status__dot" />
        </span>
      );
    }
    if (hasUnsaved) {
      return (
        <span className="wm-save-status is-dirty" title="有未保存的改动">
          <span className="wm-save-status__dot" />
        </span>
      );
    }
    return (
      <span className="wm-save-status is-idle" title="已自动保存">
        <span className="wm-save-status__dot" />
      </span>
    );
  }, [saveStatus, saveErrorMsg, hasUnsaved]);

  // —— 脏红点 ——
  const dirtyDot = (field: keyof PS) =>
    dirty.has(field) ? <span title="已修改，等待保存" className="wm-dirty-dot" /> : null;

  // —— 检测到的 IDE：自动配置，仅标题行轻量示状态 ——
  const ideCards = syncStatus.filter((s) => s.detected);

  return (
    <div className="wm-page">
      {/* ============ 顶部细进度条 ============ */}
      {writingProgress && <div aria-hidden className="wm-top-progress" />}

      {/* ============ Card 1：WorkMami 开关 + 参数 ============ */}
      <Card
        size="small"
        className="wm-proxy-card"
        title={
          <div className="wm-card-title">
            {/* Switch 开关 + 运行状态，放标题行最左侧 */}
            <div className="wm-switch-row">
              <Switch
                checked={enabled}
                checkedChildren="开"
                unCheckedChildren="关"
                onChange={onToggleEnabled}
              />
              {dirtyDot("enabled")}
              {(running || enabled) && (
                <span className={`wm-run-state${running ? " is-live" : ""}`}>
                  {running ? "运行中" : "待启动"}
                </span>
              )}
            </div>
            {/* 保存状态徽章 */}
            {saveStatusBadge}
          </div>
        }
      >
        {/* 字段网格 */}
        <div className="wm-field-grid">
          {/* API Key */}
          <div className="wm-field-grid__wide">
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

        </div>
      </Card>

      {/* ============ Card 2：IDE 自动配置 + 支持的大模型 ============ */}
      <Card
        size="small"
        className="wm-proxy-card"
        title={
          <div className="wm-card-title">
            {/* IDE 自动配置状态：轻量示状态 */}
            <div className="wm-ide-row">
              {ideCards.map((ide) => {
                const statusText = ide.error || (ide.synced ? "已自动配置" : "待配置");
                const demoGif = IDE_DEMO_GIFS[ide.id];
                return (
                  <Tooltip
                    key={ide.id}
                    title={
                      demoGif ? (
                        <img
                          className="wm-ide-demo-gif"
                          src={demoGif}
                          alt={`${ide.label} 自动配置演示`}
                        />
                      ) : (
                        statusText
                      )
                    }
                    classNames={demoGif ? { root: "wm-ide-gif-tooltip" } : undefined}
                  >
                    <span
                      className={`wm-ide-chip${
                        ide.error ? " is-error" : ide.synced ? " is-ok" : " is-pending"
                      }`}
                    >
                      <span className="wm-ide-chip__dot" />
                      {ide.label}
                    </span>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        }
      >
        {/* 支持的大模型 */}
        <div className="wm-field-label">
          <span className="wm-field-label__text">支持的模型</span>
          <Tooltip title="刷新">
            <ReloadOutlined
              style={{ color: "#8a8a8a", cursor: "pointer", fontSize: 13 }}
              onClick={() => loadModels()}
            />
          </Tooltip>
        </div>

        {/* 模型 chip 网格 */}
        {modelsLoading ? (
          <div className="wm-model-gallery-loading">加载中…</div>
        ) : models.length === 0 ? (
          <Empty description="暂无数据" />
        ) : (
          <div className="wm-model-gallery">
            {models.map((m) => {
              const badges = (m.tags || [])
                .filter((t) => t.startsWith("badge:"))
                .map((t) => {
                  const mm = t.match(/^badge:([^:#]+)(?::(#[0-9a-fA-F]{3,8}))?$/);
                  return mm ? { name: mm[1], color: mm[2] || "#8a8f98" } : { name: t.slice(6), color: "#8a8f98" };
                });
              const credits = (m.credits || "").match(/x[\d.]+/)?.[0] || "";
              return (
                <div key={m.id} className="wm-model-chip">
                  <div className="wm-model-chip__name">{m.name}</div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    {badges.map((b) => (
                      <span
                        key={b.name}
                        className="wm-model-chip__badge"
                        style={{ color: b.color, borderColor: b.color }}
                      >
                        {b.name}
                      </span>
                    ))}
                    {credits && <span className="wm-model-chip__credits">{credits}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
