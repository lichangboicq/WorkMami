import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from "antd";
import { GiftOutlined } from "@ant-design/icons";
import { enable as enableAutoStart, disable as disableAutoStart, isEnabled as isAutoStartEnabled } from "@tauri-apps/plugin-autostart";
import { api, errText } from "../api";
import { useStore } from "../store";
import type { CheckinResult } from "../types";

export default function Checkin() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);

  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, CheckinResult>>({});
  const [autostart, setAutostart] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(false);

  useEffect(() => {
    isAutoStartEnabled().then(setAutostart).catch(() => {});
  }, []);

  const toggleAutostart = async (v: boolean) => {
    setAutostartLoading(true);
    try {
      if (v) await enableAutoStart();
      else await disableAutoStart();
      setAutostart(v);
      message.success(v ? "已开启开机自启" : "已关闭开机自启");
    } catch (e) {
      message.error(errText(e) || "设置失败");
    } finally {
      setAutostartLoading(false);
    }
  };

  const toggleCheckin = async (v: boolean) => {
    try {
      await saveSettings({ ...settings, checkin: { ...settings.checkin, autoEnabled: v } });
    } catch (e) {
      message.error(errText(e));
    }
  };

  const toggleNotify = async (v: boolean) => {
    try {
      await saveSettings({ ...settings, checkin: { ...settings.checkin, notify: v } });
    } catch (e) {
      message.error(errText(e));
    }
  };

  const eligible = accounts.filter((a) => a.has_local_token);
  // 今日已签数：兼顾持久化的 today_checked_in 与本次刚签成功的结果（刚签到后 store 未重载也能即时反映）。
  const checkedToday = eligible.filter(
    (a) => a.today_checked_in || results[a.uid]?.ok
  ).length;

  const runAll = async () => {
    if (!eligible.length) {
      message.warning("没有可签到的账号（需先导入凭证）");
      return;
    }
    setRunning(true);
    try {
      const rs = await api.checkinAll();
      const map: Record<string, CheckinResult> = {};
      for (const r of rs) map[r.uid] = r;
      setResults(map);
      const ok = rs.filter((r) => r.ok && !r.already).length;
      message.success(`签到完成：新增 ${ok}，已签 ${rs.filter((r) => r.already).length}`);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setRunning(false);
    }
  };

  const runOne = async (uid: string) => {
    try {
      const r = await api.checkinOne(uid);
      setResults((prev) => ({ ...prev, [uid]: r }));
      if (r.ok && !r.already) message.success(`${r.nickname || uid} 签到成功 +${r.reward}`);
      else if (r.already) message.info(`${r.nickname || uid} 今日已签到`);
      else message.warning(r.message || "签到失败");
    } catch (e) {
      message.error(errText(e));
    }
  };

  return (
    <div className="wm-page">
      <Row gutter={16} wrap={false}>
        <Col flex="auto">
          <Card
            size="small"
            title={
              <Space>
                <GiftOutlined />
                <span>
                  今日签到：{checkedToday}/{eligible.length}
                </span>
              </Space>
            }
          >
            <Alert
              style={{ marginBottom: 12 }}
              type="info"
              showIcon
              message="Buddy 加油站活动：每日签到可得约 100 积分。签到后会自动刷新积分余额。"
            />
            <Table
              rowKey="uid"
              size="small"
              pagination={false}
              dataSource={accounts}
              columns={[
                { title: "昵称", dataIndex: "nickname", render: (t, r) => t || r.uid },
                {
                  title: "类型",
                  dataIndex: "account_type",
                  width: 80,
                  render: (t: string) => (
                    <Tag color={t === "enterprise" ? "gold" : "blue"}>
                      {t === "enterprise" ? "企业" : "个人"}
                    </Tag>
                  ),
                },
                {
                  title: "凭证",
                  width: 90,
                  render: (_, r) =>
                    r.has_local_token ? (
                      <Tag color="green">就绪</Tag>
                    ) : (
                      <Tag color="red">需授权</Tag>
                    ),
                },
                {
                  title: "今日",
                  width: 90,
                  render: (_, r) => {
                    const res = results[r.uid];
                    const done = res ? res.ok : r.today_checked_in;
                    return done ? (
                      <Tag color="purple">已签</Tag>
                    ) : (
                      <Tag>未签</Tag>
                    );
                  },
                },
                {
                  title: "连续",
                  width: 90,
                  render: (_, r) => {
                    const streak = results[r.uid]?.streak ?? r.streak_days;
                    return <span>{streak} 天</span>;
                  },
                },
                {
                  title: "结果",
                  render: (_, r) => {
                    const res = results[r.uid];
                    if (!res) return <span style={{ opacity: 0.6 }}>—</span>;
                    if (res.already) return <Tag>已签到过</Tag>;
                    if (res.ok) return <Tag color="green">+{res.reward}</Tag>;
                    return <Tag color="red">{res.message || "失败"}</Tag>;
                  },
                },
                {
                  title: "操作",
                  width: 100,
                  render: (_, r) => (
                    <Button
                      size="small"
                      disabled={!r.has_local_token}
                      onClick={() => runOne(r.uid)}
                    >
                      签到
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col flex="none">
          <Card size="small" title="签到设置">
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              <Space>
                <Switch
                  checked={settings.checkin.autoEnabled}
                  onChange={toggleCheckin}
                />
                <span>自动签到</span>
              </Space>
              <Space>
                <Switch
                  checked={settings.checkin.notify}
                  onChange={toggleNotify}
                />
                <span>完成后系统通知</span>
              </Space>
              <Space>
                <Switch
                  checked={autostart}
                  loading={autostartLoading}
                  onChange={toggleAutostart}
                />
                <span>开机自动启动</span>
              </Space>
              <Button
                type="primary"
                loading={running}
                onClick={runAll}
                icon={<GiftOutlined />}
              >
                一键全部签到
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
