import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Divider,
  Form,
  Input,
  InputNumber,
  message,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
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

export default function Proxy() {
  const settings = useStore((s) => s.settings);
  const proxy = useStore((s) => s.proxy);
  const saveSettings = useStore((s) => s.saveSettings);
  const reloadProxy = useStore((s) => s.reloadProxy);

  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  // 手工配置 WorkBuddy 的镜像 UI 收归按钮后面：模型已自动写入 WorkBuddy 的 models.json，
  // 一般不需要手工配置，用户主动点击后才展示。
  const [showManualGuide, setShowManualGuide] = useState(false);

  useEffect(() => {
    const p = settings.proxy;
    form.setFieldsValue(p);
    // 密钥为空时自动生成一串 SK- 开头的随机 key，用户无需自己设置。
    if (!p.apiKey) form.setFieldValue("apiKey", genApiKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.proxy]);

  // 进入页面即拉取一次 WorkBuddy 内置模型列表（实时，服务端上新即反映）。
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

  // 选中模型后，以其官方参数为准自动回填上下文窗口 / 思考强度（仍可手动微调）。
  const onModelChange = (id: string) => {
    const m = models.find((x) => x.id === id);
    if (!m) return;
    if (m.contextWindow > 0) form.setFieldValue("contextWindow", m.contextWindow);
    if (m.defaultEffort) form.setFieldValue("reasoningEffort", m.defaultEffort);
  };

  const onSave = async () => {
    try {
      const v = await form.validateFields();
      // apiKey 已不绑定 Form.Item（只在右栏镜像卡展示/刷新），需显式并入，避免保存时丢值。
      const next: PS = { ...settings.proxy, ...v, apiKey: form.getFieldValue("apiKey") || v.apiKey };
      setSaving(true);
      await saveSettings({ ...settings, proxy: next });
      message.success("代理设置已保存");
      await reloadProxy();
    } catch (e) {
      if (errText(e)) message.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const enabled = Form.useWatch("enabled", form);
  const apiKey = Form.useWatch("apiKey", form);
  const defaultModel = Form.useWatch("defaultModel", form);

  // 模型下拉：以官方列表为准；仿 WorkBuddy 界面展示模型名、id、积分倍率与徽章。
  // 若已保存的默认模型不在列表中（自定义/未刷新），补进去以免丢失显示。
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
      // 未命中已拉取列表时（如列表为空），默认模型统一以品牌名展示，底层值仍是真实上游 id。
      opts.unshift({ value: defaultModel, label: "WorkMami Model" });
    }
    return opts;
  }, [models, defaultModel]);
  const selectedModel = models.find((m) => m.id === defaultModel);

  // 监听地址若为 0.0.0.0（监听所有网卡），给本地客户端展示回环地址；其余情况按实际 host 展示。
  const displayHost = settings.proxy.host === "0.0.0.0" ? "127.0.0.1" : settings.proxy.host;
  const baseUrl = `http://${displayHost}:${settings.proxy.port}/v1`;

  const running = Boolean(proxy?.running);

  // —— 镜像卡：1:1 复刻 WorkBuddy「编辑模型」弹窗，值自动填好，用户照着复制/勾选 ——
  // 注意：下面的勾选框「不可改」是刻意设计——每种 LLM 有与之匹配的独特能力参数，
  // 必须和官方一致模型才能正常工作；小白用户不需要也不应该改，照抄即可。请勿改为可交互。
  const capChecks: { label: string; checked: boolean; tip: string }[] = [
    {
      label: "工具调用",
      checked: Boolean(selectedModel?.supportsToolCall),
      tip: "自动跟随所选模型",
    },
    {
      label: "图片输入",
      checked: Boolean(selectedModel?.supportsImages),
      tip: "自动跟随所选模型",
    },
    {
      label: "思考模式",
      checked: Boolean(selectedModel?.supportsReasoning),
      tip: "自动跟随所选模型",
    },
    {
      label: "仅思考模式",
      checked: Boolean(selectedModel?.raw?.onlyReasoning),
      tip: "自动跟随所选模型",
    },
    {
      label: "允许关闭思考",
      checked: Boolean(
        (selectedModel?.raw?.reasoning as Record<string, unknown> | undefined)?.canDisableThinking,
      ),
      tip: "自动跟随所选模型",
    },
    {
      label: "自定义协议",
      checked: false,
      tip: "无需勾选",
    },
  ];

  const mirrorLabel = (t: string) => <Text strong>{t}</Text>;

  return (
    <div className="wm-page">
      <Row gutter={16}>
        {/* ============ 左：WorkMami 自己的设置 ============ */}
        <Col xs={24} lg={14}>
          <Card title="WorkMami 设置" size="small" style={{ marginBottom: 16 }}>
            <Form form={form} layout="vertical" initialValues={settings.proxy}>
              <Space size="large" wrap align="center">
                <Form.Item name="enabled" valuePropName="checked" style={{ marginBottom: 0 }}>
                  <Switch checkedChildren="已开启" unCheckedChildren="已关闭" />
                </Form.Item>
                <Tag color={running ? "green" : enabled ? "orange" : "default"}>
                  {running ? "服务运行中" : enabled ? "待保存后启动" : "未启动"}
                </Tag>
              </Space>

              {!enabled && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 12 }}
                  message="未开启：开启并保存后，右侧接入信息才可用。"
                />
              )}

              <Divider style={{ margin: "20px 0 12px" }} />
              <Button type="primary" loading={saving} onClick={onSave}>
                保存设置
              </Button>
              <Text type="secondary" style={{ marginLeft: 12 }}>
                保存后 WorkBuddy 即可自动发现模型（已同步到 WorkBuddy 模型列表）。
              </Text>

              {/* —— 小白不需要动的高级参数，折叠收起 —— */}
              <Collapse
                ghost
                defaultActiveKey={["adv"]}
                style={{ marginTop: 12 }}
                items={[
                  {
                    key: "adv",
                        label: "高级设置（WorkMami 独有参数，一般不用动）",
                        children: (
                          <>
                            <Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
                              仅在 WorkMami 生效，WorkBuddy 无对应项，保持默认即可。
                            </Text>
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item name="host" label="监听地址">
                            <Input style={{ width: "100%" }} placeholder="默认 127.0.0.1" />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="port" label="端口">
                            <InputNumber style={{ width: "100%" }} min={1} max={65535} placeholder="默认 8787" />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="strategy" label="积分调度策略">
                            <Select
                              options={[
                                { value: "expiring-first", label: "先消耗临近到期的积分" },
                                { value: "smart", label: "先消耗余额多的账号" },
                                { value: "drain", label: "先消耗余额少的账号" },
                                { value: "round-robin", label: "各账号平均消耗" },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name="contextWindow"
                            label="上下文窗口(tokens)"
                            extra={
                              selectedModel?.contextWindow
                                ? `所选模型上限 ${selectedModel.contextWindow.toLocaleString()}，可手动调低`
                                : undefined
                            }
                          >
                            <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="reasoningEffort" label="默认思考强度">
                            <Select
                              options={[
                                { value: "none", label: "关闭" },
                                { value: "low", label: "低" },
                                { value: "medium", label: "中" },
                                { value: "high", label: "高" },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="stickyTtlMin" label="会话粘性窗口(分钟)">
                            <InputNumber style={{ width: "100%" }} min={0} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="maxRetries" label="Failover 最大换号数">
                            <InputNumber style={{ width: "100%" }} min={1} max={10} />
                          </Form.Item>
                        </Col>
                      </Row>
                          </>
                    ),
                  },
                ]}
              />
            </Form>
          </Card>
        </Col>

        {/* ============ 右：WorkBuddy 配置向导（默认自动同步；手工配置收归按钮后） ============ */}
        <Col xs={24} lg={10}>
          <Card title="WorkBuddy 配置向导" size="small" style={{ marginBottom: 16 }}>
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message="已自动配置：WorkMami 会把支持的模型自动写入 WorkBuddy 的模型列表，重启 WorkBuddy 即可直接选用，通常无需手工配置。"
            />

            {!showManualGuide ? (
              <div style={{ textAlign: "center", padding: "16px 0" }}>
                <Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
                  自动配置失败或需要逐项核对时，可打开手工配置向导。
                </Text>
                <Button onClick={() => setShowManualGuide(true)}>
                  打开手工配置向导
                </Button>
              </div>
            ) : (
              <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="WorkBuddy 设置 → 模型 → 添加模型，逐项照抄、复制粘贴即可。"
            />

            <Space direction="vertical" style={{ width: "100%" }} size={4}>
              {mirrorLabel("供应商（仅支持 OpenAI 兼容协议 API）")}
              <Input readOnly value="自定义" className="wm-mono" />

              <div style={{ marginTop: 6 }}>{mirrorLabel("接口地址")}</div>
              <Space.Compact style={{ width: "100%" }}>
                <Input readOnly value={baseUrl} className="wm-mono" />
                <Tooltip title="复制">
                  <Button
                    icon={<CopyOutlined />}
                    onClick={() => copyText(baseUrl, "已复制接口地址")}
                  />
                </Tooltip>
              </Space.Compact>

              <div style={{ marginTop: 6 }}>{mirrorLabel("API Key")}</div>
              <Space.Compact style={{ width: "100%" }}>
                <Input.Password readOnly value={apiKey || ""} className="wm-mono" visibilityToggle />
                <Tooltip title="复制">
                  <Button
                    icon={<CopyOutlined />}
                    onClick={() => copyText(apiKey || "", "已复制 API Key")}
                  />
                </Tooltip>
                <Tooltip title="随机生成新密钥，生成后记得回左边保存">
                  <Button
                    icon={<ReloadOutlined />}
                    onClick={() => {
                      form.setFieldValue("apiKey", genApiKey());
                      message.success("已生成新密钥，记得回左边保存");
                    }}
                  />
                </Tooltip>
              </Space.Compact>

              <div style={{ marginTop: 6 }}>{mirrorLabel("模型名称")}</div>
              <Space.Compact style={{ width: "100%" }}>
                <Select
                  showSearch
                  style={{ width: "100%" }}
                  value={defaultModel || undefined}
                  placeholder="选择模型"
                  optionFilterProp="label"
                  loading={modelsLoading}
                  options={modelOptions}
                  onChange={(id) => {
                    form.setFieldValue("defaultModel", id);
                    onModelChange(id);
                  }}
                  notFoundContent={
                    modelsLoading ? "加载中…" : modelsError || "点右侧刷新获取模型"
                  }
                />
                <Tooltip title="刷新模型列表">
                  <Button
                    icon={<ReloadOutlined />}
                    loading={modelsLoading}
                    onClick={() => loadModels()}
                  />
                </Tooltip>
              </Space.Compact>
              {modelsError && (
                <div style={{ color: "#ff4d4f", fontSize: 12 }}>{modelsError}</div>
              )}

              <div style={{ marginTop: 8 }}>
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

              <div style={{ marginTop: 6 }}>
                {mirrorLabel("默认思考强度")}
                <Select
                  disabled
                  value="auto"
                  style={{ width: "100%", marginTop: 4 }}
                  options={[{ value: "auto", label: "自动" }]}
                />
              </div>
            </Space>

            <Divider style={{ margin: "12px 0 8px" }} />
            <Text strong>最后一步</Text>
            <Text type="secondary" style={{ display: "block" }}>
              在 WorkBuddy 弹窗点「测试连接」，成功后保存即可；WorkMami 会在后台自动分配账号与积分。
            </Text>
              </>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
