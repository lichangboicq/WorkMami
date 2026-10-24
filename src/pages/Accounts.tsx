import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Input,
  message,
  Modal,
  Progress,
  Row,
  Space,
  Switch,
  Tag,
  theme as antdTheme,
  Tooltip,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import { api, errText } from "../api";
import { useStore } from "../store";
import type { Account } from "../types";
import { BillIcon } from "../components/WBIcon";
import CreditLedgerDrawer from "./CreditLedgerDrawer";

function fmtTime(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("zh-CN");
}

// 到期时间展示：日期 + 相对天数；无到期视为长期有效。
function fmtExpire(ms?: number | null): { text: string; days: number | null } {
  if (!ms) return { text: "长期有效", days: null };
  const d = new Date(ms);
  if (isNaN(d.getTime())) return { text: "长期有效", days: null };
  const days = Math.ceil((ms - Date.now()) / 86400000);
  const date = d.toLocaleDateString("zh-CN");
  if (days < 0) return { text: `${date}（已过期）`, days };
  return { text: `${date}（剩 ${days} 天）`, days };
}

// 官方成长计划导航图标（取自 WorkBuddy usercenter 前端 bundle，currentColor 单色，随文字着色/置灰）
function GrowthPlanIcon({
  style,
  onClick,
}: {
  style?: CSSProperties;
  onClick?: () => void;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        verticalAlign: "-0.125em",
        ...style,
      }}
      onClick={onClick}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        transform="matrix(0.707107 0.707107 -0.707107 0.707107 7.99988 -0.000304222)"
        d="M10.7915 2.3866L10.7922 2.3851L10.8082 2.3531L10.8324 2.3046L10.8434 2.2826L10.8509 2.2674Q11.0516 1.8517 10.9643 1.4155Q10.8844 1.0156 10.5912 0.7226Q10.2981 0.4295 9.8983 0.3495Q9.4621 0.2624 9.0509 0.4609L9.034 0.4693L9.0092 0.4817L8.96 0.5062L8.9285 0.5219Q7.3825 1.2844 5.657 1.2845Q3.9315 1.2845 2.3841 0.5215L2.3525 0.5058L2.3047 0.4819L2.2826 0.4709L2.2674 0.4633Q1.8516 0.2627 1.4155 0.3499Q1.0156 0.4298 0.7225 0.7229Q0.4295 1.016 0.3495 1.4159Q0.2623 1.852 0.4608 2.2632L0.4692 2.2802L0.4817 2.3052L0.5062 2.3544L0.5219 2.3859Q1.2843 3.9319 1.2843 5.6573Q1.2843 7.3828 0.5213 8.9301L0.5056 8.9617L0.4817 9.0095L0.4707 9.0316L0.4632 9.0468Q0.2625 9.4625 0.3497 9.8987Q0.4296 10.2985 0.7227 10.5916Q1.0158 10.8847 1.4157 10.9647Q1.8518 11.0519 2.263 10.8534L2.28 10.845L2.305 10.8326L2.3542 10.8079L2.3859 10.7922Q3.9318 10.0299 5.6571 10.03Q7.3824 10.03 8.9297 10.793L8.9615 10.8087L9.0092 10.8326L9.0313 10.8437L9.0466 10.8512Q9.4623 11.0519 9.8984 10.9647Q10.2983 10.8848 10.5914 10.5917Q10.8845 10.2986 10.9644 9.8987Q11.0516 9.4626 10.8532 9.0514L10.8448 9.0343L10.8323 9.0093L10.8076 8.9598L10.7917 8.9278Q10.0296 7.3822 10.0296 5.6572Q10.0296 3.933 10.7915 2.3866ZM9.7333 1.8196L9.7166 1.8531L9.7159 1.8546Q8.8296 3.6525 8.8296 5.6572Q8.8297 7.662 9.7168 9.4613L9.7341 9.4961L9.7589 9.5457L9.7686 9.5651L9.7725 9.5731Q9.8182 9.6678 9.7429 9.7431Q9.6675 9.8185 9.5774 9.775L9.5677 9.7702L9.5456 9.7592L9.495 9.7339L9.4604 9.7167Q7.6622 8.83 5.6571 8.83Q3.6521 8.8299 1.8524 9.7173L1.8179 9.7345L1.7686 9.7591L1.7493 9.7687L1.7413 9.7727Q1.6466 9.8184 1.5713 9.7431Q1.4959 9.6678 1.5394 9.5775L1.5442 9.568L1.5552 9.5459L1.5805 9.4953L1.5975 9.4609Q2.4843 7.6625 2.4843 5.6573Q2.4843 3.6521 1.5967 1.8524L1.5797 1.818L1.5551 1.7687L1.5454 1.7494L1.5415 1.7415Q1.4958 1.6468 1.5711 1.5714Q1.6464 1.4961 1.7366 1.5396L1.7462 1.5443L1.7683 1.5554L1.8189 1.5807L1.8533 1.5977Q3.6518 2.4845 5.6571 2.4845Q7.6624 2.4844 9.4621 1.5967L9.4965 1.5797L9.5456 1.5551L9.5648 1.5454L9.5727 1.5416Q9.6674 1.4958 9.7428 1.5711Q9.8181 1.6465 9.7746 1.7367L9.7699 1.7462L9.7589 1.7683L9.7333 1.8196Z"
      />
    </svg>
  );
}

// 卡片底部操作项：仅图标 + Tooltip 说明，避免文字标签在小卡片里换行、在亮色主题下看不清。
function CardAction({
  icon,
  title,
  tooltip,
  onClick,
  danger,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  tooltip?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    // Tooltip 必须包住真实 DOM 节点（span），否则挂在函数组件上事件会丢失
    <Tooltip title={tooltip ?? title}>
      <span className="wm-card-action-wrap">
        <Button
          type="text"
          size="small"
          className="wm-card-action"
          icon={icon}
          onClick={onClick}
          danger={danger}
          disabled={disabled}
          aria-label={title}
        />
      </span>
    </Tooltip>
  );
}

export default function Accounts() {
  const accounts = useStore((s) => s.accounts);
  const reloadAccounts = useStore((s) => s.reloadAccounts);

  const [refreshing, setRefreshing] = useState(false);

  // 积分清单抽屉
  const [ledgerUid, setLedgerUid] = useState("");
  const [ledgerName, setLedgerName] = useState("");

  // OAuth 弹窗
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthSession, setOauthSession] = useState("");
  const [oauthStatus, setOauthStatus] = useState<
    "idle" | "pending" | "authorized" | "expired"
  >("idle");

  // 标签编辑
  const [tagOpen, setTagOpen] = useState(false);
  const [tagUid, setTagUid] = useState("");
  const [tagValue, setTagValue] = useState<string>("");

  // 各账号是否已在独立窗口记忆成长中心网页登录态：{uid: boolean}
  const [boundMap, setBoundMap] = useState<Record<string, boolean>>({});
  const refreshBound = async () => {
    try {
      setBoundMap(await api.growthBoundAll());
    } catch {
      /* 状态查询失败不影响主流程 */
    }
  };
  useEffect(() => {
    refreshBound();
  }, [accounts]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    // 只要有待抓取的会话就持续轮询，与弹窗是否显示无关（点「后台等待」也不会中断）。
    if (oauthSession && oauthStatus === "pending") {
      timer = setInterval(async () => {
        try {
          const res = await api.oauthPoll(oauthSession);
          if (res.status === "authorized") {
            setOauthStatus("authorized");
            message.success("登录成功，账号已入库，成长计划已记忆");
            await reloadAccounts();
            // 自动关闭弹窗并复位（登录用的是外部独立浏览器，无窗口需要后端关闭）
            setOauthOpen(false);
            setOauthSession("");
            setOauthStatus("idle");
            clearInterval(timer);
          } else if (res.status === "expired") {
            setOauthStatus("expired");
            setOauthSession("");
            clearInterval(timer);
          }
        } catch (e) {
          setOauthStatus("expired");
          setOauthSession("");
          clearInterval(timer);
          message.error(errText(e));
        }
      }, 2000);
    }
    return () => timer && clearInterval(timer);
  }, [oauthSession, oauthStatus, reloadAccounts]);

  const startOAuth = async () => {
    setOauthOpen(true);
    setOauthStatus("pending");
    setOauthSession("");
    try {
      const res = await api.oauthBegin();
      setOauthSession(res.sessionId);
    } catch (e) {
      setOauthStatus("expired");
      message.error(errText(e));
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const rs = await api.refreshQuota();
      const ok = rs.filter((r) => r.ok).length;
      message.success(`刷新完成：成功 ${ok}/${rs.length}`);
      await reloadAccounts();
    } catch (e) {
      message.error(errText(e));
    } finally {
      setRefreshing(false);
    }
  };

  const refreshOne = async (uid: string) => {
    try {
      const rs = await api.refreshQuota([uid]);
      if (rs[0]?.ok) message.success("积分已刷新");
      else message.warning(rs[0]?.error || "刷新失败");
      await reloadAccounts();
    } catch (e) {
      message.error(errText(e));
    }
  };

  const saveTags = async () => {
    const tags = tagValue
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      await api.setAccountTags(tagUid, tags);
      message.success("标签已更新");
      setTagOpen(false);
      await reloadAccounts();
    } catch (e) {
      message.error(errText(e));
    }
  };

  const totalRemaining = useMemo(
    () => accounts.reduce((s, a) => s + (a.quota?.remaining || 0), 0),
    [accounts],
  );

  return (
    <div className="wm-page">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="多绑多赚：每个账号每天都能签到领积分"
      />

      <div className="wm-toolbar">
        <Button type="primary" icon={<UserAddOutlined />} onClick={startOAuth}>
          网页授权添加账号
        </Button>
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={refreshAll}>
          刷新全部积分
        </Button>
        <span style={{ marginLeft: "auto", opacity: 0.8 }}>
          共 {accounts.length} 个账号 · 剩余积分合计 {Math.round(totalRemaining)}
        </span>
      </div>

      {accounts.length === 0 ? (
        <Empty description="暂无账号，点击「网页授权添加账号」开始" />
      ) : (
        <Row gutter={[16, 16]}>
          {accounts.map((a) => (
            <Col key={a.uid} xs={24} md={12} xl={8}>
              <AccountCard
                a={a}
                onRefresh={() => refreshOne(a.uid)}
                bound={!!boundMap[a.uid]}
                onOpenGrowth={async () => {
                  try {
                    const r = await api.openGrowthCenter(a.uid);
                    message.success(`已用 ${r.browser || "浏览器"} 打开成长计划`);
                  } catch (e) {
                    message.error(errText(e));
                  }
                }}
                onLedger={() => {
                  setLedgerUid(a.uid);
                  setLedgerName(a.nickname);
                }}
                onToggle={async (v) => {
                  await api.setAccountEnabled(a.uid, v);
                  await reloadAccounts();
                }}
                onDelete={async () => {
                  await api.deleteAccount(a.uid);
                  message.success("已删除");
                  await reloadAccounts();
                }}
                onTags={() => {
                  setTagUid(a.uid);
                  setTagValue(a.tags.join(", "));
                  setTagOpen(true);
                }}
              />
            </Col>
          ))}
        </Row>
      )}

      {/* OAuth 授权弹窗 */}
      <Modal
        open={oauthOpen}
        title="网页授权添加账号"
        onCancel={() => setOauthOpen(false)}
        footer={
          oauthStatus === "authorized" || oauthStatus === "expired"
            ? [
                <Button key="c" type="primary" onClick={() => setOauthOpen(false)}>
                  关闭
                </Button>,
              ]
            : [
                <Button key="c" onClick={() => setOauthOpen(false)}>
                  后台等待
                </Button>,
              ]
        }
      >
        {oauthStatus === "pending" && (
          <Alert
            type="info"
            showIcon
            message="请在打开的浏览器登录窗口中完成登录"
            description="已为你用独立浏览器 profile 打开 WorkBuddy 登录页，请使用微信扫码或手机号登录。登录成功后 WorkMami 会自动抓取凭证入库，并把该 profile 记忆到这个账号（成长计划直接带登录态），无需其他操作。"
          />
        )}
        {oauthStatus === "authorized" && (
          <Alert type="success" showIcon message="登录成功，账号已入库，成长计划已记忆" />
        )}
        {oauthStatus === "expired" && (
          <Alert
            type="error"
            showIcon
            message="未抓取到凭证"
            description="可能你关闭了浏览器登录窗口、登录超时，或该页面未把 token 存到可读位置。可重试；若反复失败请反馈。"
          />
        )}
      </Modal>

      {/* 标签编辑 */}
      <Modal
        open={tagOpen}
        title="编辑标签"
        onCancel={() => setTagOpen(false)}
        onOk={saveTags}
      >
        <Input
          value={tagValue}
          onChange={(e) => setTagValue(e.target.value)}
          placeholder="多个标签用逗号分隔，例如：主力,测试"
        />
      </Modal>

      {/* 积分清单抽屉 */}
      <CreditLedgerDrawer
        open={!!ledgerUid}
        onClose={() => setLedgerUid("")}
        uid={ledgerUid}
        nickname={ledgerName}
      />
    </div>
  );
}

function AccountCard({
  a,
  onRefresh,
  bound,
  onOpenGrowth,
  onLedger,
  onToggle,
  onDelete,
  onTags,
}: {
  a: Account;
  onRefresh: () => void;
  bound: boolean;
  onOpenGrowth: () => void;
  onLedger: () => void;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
  onTags: () => void;
}) {
  const q = a.quota;
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(false);
  const pct = q && q.total > 0 ? Math.round((q.remaining / q.total) * 100) : 0;
  // 卡片概览只列「还有剩余」的批次（按到期升序）：已用完的批次没有到期压力，
  // 列出「0 · 剩 X 天」会让用户困惑，故折叠成一句汇总，完整历史看积分清单抽屉。
  const activeResources = (q?.resources || [])
    .filter((r) => r.remaining > 0)
    .sort((a, b) => (a.expire_at ?? Infinity) - (b.expire_at ?? Infinity));
  const usedUpCount = (q?.resources?.length || 0) - activeResources.length;

  return (
    <Card
      size="small"
      className="wm-account-card"
      title={
        <Space size={8} className="wm-account-title-row">
          <Badge status={a.enabled ? "processing" : "default"} />
          <Tooltip title={`UID: ${a.uid}`}>
            <span className="wm-account-name">{a.nickname || "未命名"}</span>
          </Tooltip>
          <Tag color={a.account_type === "enterprise" ? "gold" : "blue"}>
            {a.account_type === "enterprise" ? "企业账号" : "个人账号"}
          </Tag>
        </Space>
      }
      extra={<Switch size="small" checked={a.enabled} onChange={onToggle} />}
      actions={[
        <CardAction
          key="r"
          icon={<ReloadOutlined />}
          title="刷新积分"
          onClick={onRefresh}
        />,
        <CardAction
          key="g"
          icon={<GrowthPlanIcon />}
          title="成长计划"
          tooltip={bound ? "成长计划" : "重新添加此账号即可访问成长计划"}
          disabled={!bound}
          onClick={onOpenGrowth}
        />,
        <CardAction key="l" icon={<BillIcon />} title="积分明细" onClick={onLedger} />,
        <CardAction key="t" icon={<EditOutlined />} title="编辑标签" onClick={onTags} />,
        <CardAction
          key="d"
          icon={<DeleteOutlined />}
          title="删除账号"
          danger
          onClick={() =>
            Modal.confirm({
              title: "确定删除该账号？",
              content: "仅移除 WorkMami 记录，您的 WorkBuddy 继续正常使用，无影响。",
              okText: "删除",
              okButtonProps: { danger: true },
              cancelText: "取消",
              onOk: onDelete,
            })
          }
        />,
      ]}
    >
      <Space direction="vertical" style={{ width: "100%" }} size={8}>
        <Space size={4} wrap>
          {a.today_checked_in && <Tag color="purple">今日已签</Tag>}
          {a.streak_days > 0 && <Tag>连续 {a.streak_days} 天</Tag>}
        </Space>

        {a.tags.length > 0 && (
          <Space size={4} wrap>
            {a.tags.map((t) => (
              <Tag key={t} color="cyan">
                {t}
              </Tag>
            ))}
          </Space>
        )}

        {q ? (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
              }}
            >
              <span>
                剩余{" "}
                <span style={{ fontSize: 22, fontWeight: 700 }}>
                  {fmtNum(q.remaining)}
                </span>{" "}
                <span className="wm-account-total">/ {fmtNum(q.total)}</span>
              </span>
              {q.expiring_soon && <Tag color="orange">有积分即将到期</Tag>}
            </div>
            <Progress
              percent={pct}
              status={pct < 15 ? "exception" : "normal"}
              showInfo={false}
            />
            <div className="wm-account-subtext">
              已用 {fmtNum(q.used)} · 更新于 {fmtTime(q.updated_at)}
            </div>
            {(activeResources.length > 0 || usedUpCount > 0) && (
              <div style={{ marginTop: 4 }}>
                {activeResources.length > 0 && (
                  <a
                    style={{ fontSize: 13 }}
                    onClick={() => setOpen((v) => !v)}
                  >
                    {open ? "收起" : "展开"}可用积分明细（{activeResources.length}）
                  </a>
                )}
                {open && activeResources.length > 0 && (
                  <div
                    style={{
                      marginTop: 6,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      background: token.colorFillQuaternary,
                      borderRadius: 6,
                      overflow: "hidden",
                    }}
                  >
                    <div style={{ maxHeight: 220, overflowY: "auto" }}>
                      {activeResources.map((r, i) => {
                        const e = fmtExpire(r.expire_at);
                        const color = r.expired
                          ? token.colorError
                          : r.expiring_soon
                            ? token.colorWarning
                            : undefined;
                        return (
                          <div
                            key={r.package_code + r.name + (r.expire_at ?? "") + i}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "4px 8px",
                              fontSize: 13,
                              gap: 8,
                            }}
                          >
                            <span className="wm-account-resource-name">{r.name}</span>
                            <span style={{ display: "flex", gap: 10 }}>
                              <b style={{ color }}>{fmtNum(r.remaining)}</b>
                              <span
                                style={{ color: color ?? token.colorTextTertiary }}
                              >
                                {e.text}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {usedUpCount > 0 && (
                  <div className="wm-account-faint">
                    另有 {usedUpCount} 笔已用完 · 完整记录见「积分清单」
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="wm-account-subtext">积分未同步，点击刷新</div>
        )}

        <div className="wm-account-subtext">
          最近使用：{fmtTime(a.last_used_at)}
        </div>
      </Space>
    </Card>
  );
}
