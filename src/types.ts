// 与 Rust 后端 serde 输出对齐的 TS 类型。
// 注意：Account/QuotaSnapshot/AuthTokens 为 snake_case，其余带 rename_all 的为 camelCase。

export interface QuotaResource {
  package_code: string;
  name: string;
  used: number;
  total: number;
  remaining: number;
  expire_at?: number | null; // 毫秒；null = 长期有效
  expired: boolean;
  expiring_soon: boolean;
}

export interface QuotaSnapshot {
  used: number;
  total: number;
  remaining: number;
  plan: string;
  soonest_expire_at?: number | null; // 毫秒
  expiring_soon: boolean;
  resources: QuotaResource[];
  updated_at: string;
}

export interface Account {
  uid: string;
  uin: string;
  account_type: string;
  nickname: string;
  source: string; // scan / oauth / manual
  tags: string[];
  enabled: boolean;
  quota?: QuotaSnapshot | null;
  last_used_at?: string | null;
  today_checked_in: boolean;
  streak_days: number;
  has_local_token: boolean;
  created_at: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at?: number | null;
  refresh_expires_at?: number | null;
  scope: string;
}

export interface RefreshResult {
  uid: string;
  nickname: string;
  ok: boolean;
  quota?: QuotaSnapshot | null;
  error?: string | null;
}

// 积分清单（后端 camelCase）
export interface CreditReward {
  name: string;
  reason: string;
  used: number;
  total: number;
  remaining: number;
  expireAt?: number | null;
  status: string; // 使用中 / 已用完 / 已过期
}

export interface CreditUsageRow {
  time: string;
  ts: number;
  requestId: string;
  credits: number;
  model: string;
  client: string;
}

export interface CreditLedger {
  rewards: CreditReward[];
  rewardCount: number;
  rewardRemaining: number;
  usage: CreditUsageRow[];
  usageTotal: number;
  days: number;
}

export interface CheckinResult {
  uid: string;
  nickname: string;
  ok: boolean;
  reward: number;
  already: boolean;
  streak: number;
  message: string;
}

export type Strategy = "round-robin" | "smart" | "drain" | "expiring-first";

// —— 模型池（虚拟模型，WorkBuddy 侧只见池名）——

// 池内成员：真实模型 id + 展示名（name 为空时前端回退用本机真实模型名）
export interface PoolMember {
  id: string;
  name: string;
  /** 成员级启用时段（三选一）："" = 全天；"夜间" = 23:00–次日 08:00；"避开高峰" = 工作日 09:00–12:00、14:00–18:00 之外（周末全天）。旧版 "HH:mm-HH:mm" 自定义窗口仍兼容评估 */
  schedule?: string;
}

export interface ModelPool {
  id: string; // 与 name 保持一致（如 "文员"），WorkBuddy 侧用作文档模型名与 models.json 的 id
  name: string; // 展示名（与 id 同步）
  rate: number; // 倍率，如 0.00 / 0.05 / 0.85
  thinking: string; // 思考档位三选一：「快闪」/「斟酌」/「精算」
  /** 池级忙闲筛选（星级式阈值）：前端点第 N 档存前缀集合（idle/normal/busy/congested）；空 = 不筛选。「不可用」不对用户开放，后端查到即硬性避开；查询失败/未知 = fail-open 视为正常 */
  busyFilter?: string[];
  models: PoolMember[]; // 池内成员，自上而下 = 调度优先级
}

export interface ProxySettings {
  enabled: boolean;
  host: string;
  port: number;
  apiKey: string;
  strategy: Strategy;
  defaultModel: string;
  pools?: ModelPool[]; // 后端 serde default 注入，旧配置可能缺省
}

export interface CheckinSettings {
  autoEnabled: boolean;
  notify: boolean;
}

export interface TravelSettings {
  autoEnabled: boolean;
  locationPolicy: string; // "longest" | "shortest" | "rotate"
}

export interface AppSettings {
  proxy: ProxySettings;
  checkin: CheckinSettings;
  travel: TravelSettings;
  theme: string; // dark / light / system
  autostart: boolean;
}

export interface ProxyStatus {
  running: boolean;
  enabled: boolean;
  /** 启动失败原因（监听地址无法解析/端口被占用等），正常时为 null */
  error?: string | null;
  host: string;
  port: number;
  baseUrl: string;
}

export interface AppInfo {
  platform: string;
  version: string;
  paths: {
    workmamiRoot: string;
    workbuddyHome: string;
    desktopInfo?: string | null;
  };
}

export interface DataItem {
  id: string;
  category: string; // sessions/memory/agent-config/skills/artifacts
  name: string;
  path: string;
  size: number;
  modified: number; // ms
  meta?: Record<string, unknown> | null;
}

export interface Summary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  credits: number;
  requests: number;
  success: number;
  successRate: number;
  avgTokensPerReq: number;
  cacheHitRate: number;
  avgLatencyMs: number;
}

export interface DashboardSummary {
  current: Summary;
  previous: Summary;
}

export interface TrendPoint {
  bucket: string;
  tokens: number;
  credits: number;
  requests: number;
}

export interface TopItem {
  key: string;
  label: string;
  tokens: number;
  credits: number;
  requests: number;
}

export interface HeatCell {
  weekday: number; // 0=Mon
  hour: number; // 0-23
  tokens: number;
}

export interface BalancePoint {
  ts: number;
  uid: string;
  remaining: number;
}

// 请求流水（本工具转发/导入的每条记录）
export interface RequestRow {
  ts: number;
  uid: string;
  model: string;
  source: string; // proxy / app
  totalTokens: number;
  credits: number;
  latencyMs: number;
  status: number;
  ok: boolean;
}

// 各账号真实扣费（来自官方账单）
export interface AccountBillingItem {
  uid: string;
  nickname: string;
  credits: number;
  requests: number;
}

export interface AccountBilling {
  days: number;
  total: number;
  items: AccountBillingItem[];
}

// WorkBuddy 内置模型（实时拉取，字段以官方客户端为准）
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number; // 上下文窗口（输入上限）
  maxOutputTokens: number;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  defaultEffort: string; // low/medium/high/none，可能为空
  description: string;
  credits: string; // 官方积分倍率，如 "x0.69"，可能为空
  tags: string[]; // 官方原始 tags（含 badge:名称:#颜色 徽章项）
  isDefault: boolean; // 官方默认模型标记
  vendor: string; // 官方厂商标识
  raw: Record<string, unknown>; // 官方接口返回的完整原始对象
}

export interface OAuthStart {
  sessionId: string;
}

export interface OAuthPoll {
  status: "pending" | "authorized" | "expired";
  account?: Account;
}

export interface CheckinStatus {
  checkedIn: boolean;
  streakDays: number;
  status: unknown;
  activity: unknown;
}

// ---------- 猫猫旅行 ----------
export interface TravelLocation {
  id: number;
  name: string;
  durationMinHours: number;
  durationMaxHours: number;
}

export interface TravelStatus {
  state: string; // idle / traveling / arrived
  locationName: string;
  departAt: number; // unix 秒
  arriveAt: number; // unix 秒
  serverNow: number; // unix 秒
  /** 服务端判定今日旅行次数已达上限：state 仍为 idle 但再派猫会被拒 */
  dailyLimitReached: boolean;
}

export interface TravelAccountStatus {
  uid: string;
  nickname: string;
  status: TravelStatus | { error: string };
  records?: TravelRecord[];
}

// 单次旅行台账（服务端真实记录）
export interface TravelRecord {
  recordId: number;
  locationName: string;
  travelDate: string; // YYYY-MM-DD
  departAt: number; // unix 秒
  arriveAt: number;
  claimedAt: number; // 0 = 尚未领取
  rewardCredit: number;
}

export interface TravelOverview {
  config: TravelLocation[];
  accounts: TravelAccountStatus[];
  autoEnabled: boolean;
  locationPolicy: string;
}

// —— IDE 自动配置（sync_targets）——

export interface SyncResult {
  id: string;
  label: string;
  detected: boolean;
  synced: boolean;
  written: number;
  error?: string | null;
}
