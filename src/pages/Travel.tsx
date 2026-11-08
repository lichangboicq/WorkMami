import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  CompassOutlined,
  GiftOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { api, errText } from "../api";
import { staticMessage as message } from "../antdStatic";
import { useStore } from "../store";
import type { TravelOverview, TravelStatus, TravelLocation, TravelRecord } from "../types";

const { Text, Title } = Typography;

function formatCountdown(arriveAt: number, serverNow: number): string {
  // 用本地时间近似（serverNow 仅用于校准偏移）
  const offsetSec = Math.floor(Date.now() / 1000) - serverNow;
  const remainSec = arriveAt - (Math.floor(Date.now() / 1000) - offsetSec);
  if (remainSec <= 0) return "已到站";
  const h = Math.floor(remainSec / 3600);
  const m = Math.floor((remainSec % 3600) / 60);
  const s = remainSec % 60;
  if (h > 0) return `${h}时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// 卡片右上角状态标签：idle 且服务端判定今日次数用完时，如实显示「明天再来」，而非「待出行」。
function statusTag(state: string, dailyLimitReached = false) {
  switch (state) {
    case "traveling":
      return <Tag color="processing">旅行中</Tag>;
    case "arrived":
      return <Tag color="success">可领取</Tag>;
    case "idle":
      return dailyLimitReached ? <Tag color="warning">明天再来</Tag> : <Tag>待出行</Tag>;
    default:
      return <Tag>待出行</Tag>;
  }
}

// unix 秒 -> 本地“月-日 时:分”绝对时刻，让用户知道具体几点出发/到站。
function fmtClock(unixSec: number): string {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// unix 秒 -> 本地"HH:mm"时刻（日期已在左栏单列一行，这里只展示时分）。
function fmtTime(unixSec: number): string {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// 与服务端 travel_date 对齐的本地日期串 YYYY-MM-DD。
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 旅行账单：直接取服务端台账，逐条列出“派出时间 / 领取时间 / 赚多少 / 是否到账”，
// 让用户一目了然地看到上次什么时候派猫出去、奖励又是什么时候领到手。
// 今天有记录则按今日逐条展示；今天没记录但历史有→回落到“上次旅行”单条（跨天也能看到时刻）。
function TodayLedger({ records }: { records?: TravelRecord[] }) {
  const all = records || [];
  const today = todayStr();
  const rows = all.filter((r) => r.travelDate === today);
  const total = rows.reduce((s, r) => s + r.rewardCredit, 0);
  const unclaimed = rows.filter((r) => !r.claimedAt).length;
  const last = all[0]; // 服务端按 travel_date 倒序，首条即最近一次已完成旅行
  const shown = rows.length ? rows : last ? [last] : [];
  return (
    <>
      {/* 底部锚定占位：卡片等高时把分割线压到同一水平线，minHeight 保证最紧凑时仍有间距 */}
      <div style={{ flex: 1, minHeight: 12 }} />
      <div style={{ paddingTop: 10, borderTop: "1px dashed rgba(128,128,128,.3)" }}>
      <Text strong style={{ fontSize: "var(--wm-text-ui-size)" }}>
        {rows.length ? (
          <>
            今日旅行账单：{rows.length} 次 · 共 +{total} 分
            {unclaimed > 0 && (
              <Tag color="warning" style={{ marginLeft: 8 }}>
                {unclaimed} 笔待领取
              </Tag>
            )}
          </>
        ) : (
          <>上次旅行{last ? ` : ${last.travelDate}` : ""}</>
        )}
      </Text>
      {shown.length === 0 ? (
        <Text type="secondary" style={{ display: "block", marginTop: 4, fontSize: "var(--wm-text-ui-size)" }}>
          还没有任何旅行记录。
        </Text>
      ) : (
        <div style={{ marginTop: 6 }}>
          {shown.map((r) => (
            <div
              key={r.recordId}
              style={{ padding: "2px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <div style={{ fontSize: "var(--wm-text-num-size)", opacity: 0.85 }}>
                <div>{r.locationName}</div>
                <div>{fmtTime(r.departAt)} 已派出</div>
                <div>{r.claimedAt ? `${fmtTime(r.claimedAt)} 已领奖` : "未领奖"}</div>
              </div>
              <div style={{ textAlign: "right", fontSize: "var(--wm-text-ui-size)", whiteSpace: "nowrap" }}>
                <div>
                  <Text strong style={{ fontSize: "var(--wm-text-ui-size)" }}>+{r.rewardCredit} 分</Text>
                </div>
                <div>
                  {r.claimedAt ? (
                    <Text type="success" style={{ fontSize: "var(--wm-text-ui-size)" }}>已到账</Text>
                  ) : (
                    <Text type="warning" style={{ fontSize: "var(--wm-text-ui-size)" }}>待领取</Text>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </>
  );
}

export default function Travel() {
  const [data, setData] = useState<TravelOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setTick] = useState(0); // 驱动倒计时刷新
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api.travelOverview();
      setData(res);
    } catch (e) {
      if (!silent) message.error(errText(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 每秒刷新倒计时（本地，不走网）；每 5 分钟静默重拉一次状态，避免高频调用官方接口；后台自动派/领为小时级，5 分钟足够。
    timerRef.current = setInterval(() => setTick((t) => t + 1), 1000);
    const refresh = setInterval(() => void load(true), 300000);
    return () => {
      clearInterval(timerRef.current);
      clearInterval(refresh);
    };
  }, [load]);

  const handleDepart = async (uid: string, locationId: number) => {
    try {
      await api.travelDepart(uid, locationId);
      message.success("已派猫出发！");
      void load();
    } catch (e) {
      message.error(errText(e));
    }
  };

  const handleClaim = async (uid: string) => {
    try {
      await api.travelClaim(uid);
      message.success("奖励已领取！");
      void load();
    } catch (e) {
      message.error(errText(e));
    }
  };

  const toggleAuto = async (checked: boolean) => {
    const s = { ...settings, travel: { ...settings.travel, autoEnabled: checked } };
    await saveSettings(s);
  };

  const changePolicy = async (v: string) => {
    const s = { ...settings, travel: { ...settings.travel, locationPolicy: v } };
    await saveSettings(s);
  };

  // 兼容旧值：官方协议下 4 个地点时长与奖励相同，longest/shortest 与随机等价，统一按 random 展示与保存
  const policy = settings.travel.locationPolicy === "rotate" ? "rotate" : "random";

  if (!data) {
    return (
      <div style={{ padding: 24 }}>
        <Card loading={loading}>加载中...</Card>
      </div>
    );
  }

  return (
    <div className="wm-page" style={{ padding: 24, overflow: "auto", height: "100%" }}>
      {/* 顶部设置区 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={24} align="middle">
          <Col>
            <Space>
              <Text strong>自动旅行捡分</Text>
              <Switch
                checked={settings.travel.autoEnabled}
                onChange={toggleAuto}
                checkedChildren="开"
                unCheckedChildren="关"
              />
            </Space>
          </Col>
          <Col>
            <Space>
              <Text strong>地点策略</Text>
              <Select
                value={policy}
                onChange={changePolicy}
                style={{ width: 120 }}
                options={[
                  { label: "随机", value: "random" },
                  { label: "轮换", value: "rotate" },
                ]}
              />
            </Space>
          </Col>
          <Col flex="auto" style={{ textAlign: "right" }}>
            <Button icon={<ReloadOutlined />} onClick={() => load()} loading={loading}>
              刷新
            </Button>
          </Col>
        </Row>
      </Card>

      {/* 各账号旅行卡片：auto-fill 网格，压到内容不截断的最小宽度才换行 */}
      <div className="wm-travel-grid">
        {data.accounts.map((item) => {
          const st = item.status as TravelStatus;
          const isError = "error" in item.status;
          return (
            <Card
              key={item.uid}
              title={
                <Space>
                  <CompassOutlined />
                  <span>{item.nickname || item.uid.slice(0, 8)}</span>
                </Space>
              }
              extra={
                isError ? <Tag color="error">查询失败</Tag> : statusTag(st.state, st.dailyLimitReached)
              }
              size="small"
            >
              {isError ? (
                <Text type="danger">{(item.status as { error: string }).error}</Text>
              ) : (
                <>
                  {st.state === "traveling" && (
                    <>
                      <Title level={5} style={{ margin: "2px 0" }}>
                        {st.locationName || "旅行中"}
                      </Title>
                      <Text type="secondary" style={{ display: "block" }}>
                        出发时刻：{fmtClock(st.departAt)}
                      </Text>
                      <Text type="secondary" style={{ display: "block" }}>
                        预计到达：{fmtClock(st.arriveAt)}
                      </Text>
                      <Text strong style={{ display: "block", marginTop: 4 }}>
                        还有 {formatCountdown(st.arriveAt, st.serverNow)} 到站
                      </Text>
                    </>
                  )}
                  {st.state === "arrived" && (
                    <>
                      <Title level={5} style={{ margin: "2px 0" }}>
                        {st.locationName || "已到达"}
                      </Title>
                      <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>
                        到站时刻：{fmtClock(st.arriveAt)}
                      </Text>
                      {settings.travel.autoEnabled && (
                        <Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
                          托管将在下次巡检（≤ 10 分钟）自动领取，也可点下方按钮立即领取。
                        </Text>
                      )}
                      <Button
                        type="primary"
                        icon={<GiftOutlined />}
                        onClick={() => handleClaim(item.uid)}
                      >
                        立即领取
                      </Button>
                    </>
                  )}
                  {st.state === "idle" && (
                    <>
                      {st.dailyLimitReached ? (
                        <Alert
                          type="warning"
                          showIcon
                          style={{ marginBottom: 12 }}
                          message="猫猫跑累了，明天再来"
                        />
                      ) : (
                        <>
                          <Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
                            {settings.travel.autoEnabled
                              ? `将在今日 01:00–06:00 的随机时刻自动出发${policy === "rotate" ? "，按轮换顺序选目的地" : "，目的地随机"}。`
                              : "猫猫在家休息，可手动选目的地出发，或开启自动托管。"}
                          </Text>
                          <Select
                            placeholder={settings.travel.autoEnabled ? "手动立即出发（可选）" : "选择目的地出发"}
                            style={{ width: "100%", marginBottom: 8 }}
                            onChange={(v: number) => handleDepart(item.uid, v)}
                            options={data.config.map((loc: TravelLocation) => ({
                              label: `${loc.name} (${loc.durationMinHours}-${loc.durationMaxHours}h)`,
                              value: loc.id,
                            }))}
                          />
                        </>
                      )}
                    </>
                  )}
                  <TodayLedger records={item.records} />
                </>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
