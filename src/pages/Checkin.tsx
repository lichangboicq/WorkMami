import { useState } from "react";
import {
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import { GiftOutlined } from "@ant-design/icons";
import { api, errText } from "../api";
import { staticMessage as message } from "../antdStatic";
import { useStore } from "../store";
import type { CheckinResult } from "../types";

export default function Checkin() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);

  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, CheckinResult>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());

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
  // 今日已领数：兼顾持久化的 today_checked_in 与本次刚领取成功的结果（store 未重载也能即时反映）。
  const checkedToday = eligible.filter(
    (a) => a.today_checked_in || results[a.uid]?.ok
  ).length;

  const runAll = async () => {
    if (!eligible.length) {
      message.warning("没有可领取的账号（需先导入凭证）");
      return;
    }
    setRunning(true);
    try {
      const rs = await api.checkinAll();
      const map: Record<string, CheckinResult> = {};
      for (const r of rs) map[r.uid] = r;
      setResults(map);
      const ok = rs.filter((r) => r.ok && !r.already).length;
      message.success(`领取完成：新增 ${ok}，已领 ${rs.filter((r) => r.already).length}`);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setRunning(false);
    }
  };

  const runOne = async (uid: string) => {
    setPending((p) => new Set(p).add(uid));
    try {
      const r = await api.checkinOne(uid);
      setResults((prev) => ({ ...prev, [uid]: r }));
    } catch (e) {
      const acc = accounts.find((a) => a.uid === uid);
      setResults((prev) => ({
        ...prev,
        [uid]: {
          uid,
          nickname: acc?.nickname || uid,
          ok: false,
          reward: 0,
          already: false,
          streak: 0,
          message: errText(e) || "领取失败",
        },
      }));
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(uid);
        return n;
      });
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
                  今日领取：{checkedToday}/{eligible.length}
                </span>
              </Space>
            }
          >
            <Table
              size="small"
              rowKey="uid"
              pagination={false}
              tableLayout="auto"
              dataSource={accounts}
              locale={{ emptyText: <Empty description="暂无数据" /> }}
              columns={[
                { title: "昵称", dataIndex: "nickname", render: (t, r) => t || r.uid },
                {
                  title: "累计已领取",
                  render: (_, r) => {
                    const total = results[r.uid]?.totalCredits ?? r.total_credits ?? 0;
                    return <span>{Math.round(total).toLocaleString("zh-CN")}积分</span>;
                  },
                },
                {
                  title: "操作",
                  render: (_, r) => {
                    const res = results[r.uid];
                    if (pending.has(r.uid))
                      return <Button size="small" loading onClick={() => runOne(r.uid)}>领取</Button>;
                    if (res) {
                      if (res.ok && !res.already) return <Tag color="green">+{res.reward}</Tag>;
                      if (res.already) return <Tag color="purple">已经领取</Tag>;
                      return (
                        <Space size={4}>
                          <Tag
                            color="red"
                            style={{ marginInlineEnd: 0, maxWidth: 180, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                            title={res.message}
                          >
                            {res.message || "失败"}
                          </Tag>
                          <a onClick={() => runOne(r.uid)}>重试</a>
                        </Space>
                      );
                    }
                    if (r.today_checked_in) return <Tag color="purple">已经领取</Tag>;
                    return (
                      <Button
                        size="small"
                        disabled={!r.has_local_token}
                        title={r.has_local_token ? undefined : "需先授权"}
                        onClick={() => runOne(r.uid)}
                      >
                        领取
                      </Button>
                    );
                  },
                },
              ]}
            />
          </Card>
        </Col>

        <Col flex="none">
          <Card size="small" title="领取设置">
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              <Space>
                <Switch
                  checked={settings.checkin.autoEnabled}
                  onChange={toggleCheckin}
                />
                <span>自动领取</span>
              </Space>
              <Space>
                <Switch
                  checked={settings.checkin.notify}
                  onChange={toggleNotify}
                />
                <span>领取后系统通知</span>
              </Space>
              <Button
                type="primary"
                loading={running}
                onClick={runAll}
                icon={<GiftOutlined />}
              >
                一键全部领取
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
