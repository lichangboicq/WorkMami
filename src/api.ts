// 统一封装 invoke，集中类型与错误处理。
// 走 Tauri 原生还是本地 axum bridge，由 dev-bridge 在 main.tsx 里判定好，
// 挂到 window.__WM_INVOKE__，这里每次调用时动态读取，避免模块加载时序竞争。
type AnyInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>;
const rawInvoke: AnyInvoke = async (cmd, args) => {
  const fn = (globalThis as any).__WM_INVOKE__ as AnyInvoke | undefined;
  if (fn) {
    try {
      return await fn(cmd, args);
    } catch (e) {
      // bridge 不可达（典型场景：release 构建下 dev_bridge 未编译），
      // fallback 到原生 Tauri invoke。
      if (e && String(e).includes("Failed to fetch")) {
        // fallthrough 到下面
      } else {
        throw e;
      }
    }
  }
  const m = await import("@tauri-apps/api/core");
  return m.invoke(cmd as any, args as any);
};
// 包一层泛型签名，让原有 invoke<T>(...) 调用全部编译通过。
function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return rawInvoke(cmd, args) as Promise<T>;
}
import type {
  Account,
  AccountBilling,
  AppInfo,
  AppSettings,
  BalancePoint,
  CheckinResult,
  CheckinStatus,
  CreditLedger,
  DashboardSummary,
  DataItem,
  HeatCell,
  ModelInfo,
  OAuthPoll,
  OAuthStart,
  ProxyStatus,
  RefreshResult,
  RequestRow,
  Summary,
  SyncResult,
  TopItem,
  TravelOverview,
  TrendPoint,
} from "./types";

export const api = {
  // 通用 / 系统
  appInfo: () => invoke<AppInfo>("app_info"),
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<void>("save_settings", { settings }),
  proxyStatus: () => invoke<ProxyStatus>("proxy_status"),

  // 账号
  listAccounts: () => invoke<Account[]>("list_accounts"),
  credentialStatus: (uid: string) =>
    invoke<boolean>("credential_status", { uid }),
  setAccountEnabled: (uid: string, enabled: boolean) =>
    invoke<void>("set_account_enabled", { uid, enabled }),
  setAccountTags: (uid: string, tags: string[]) =>
    invoke<void>("set_account_tags", { uid, tags }),
  deleteAccount: (uid: string) => invoke<void>("delete_account", { uid }),
  refreshQuota: (uids?: string[]) =>
    invoke<RefreshResult[]>("refresh_quota", { uids: uids ?? null }),
  creditLedger: (uid: string, days: number) =>
    invoke<CreditLedger>("credit_ledger", { uid, days }),

  // WorkBuddy 内置模型列表（实时）
  listModels: (uid?: string) =>
    invoke<ModelInfo[]>("list_models", { uid: uid ?? null }),

  // OAuth
  oauthBegin: () => invoke<OAuthStart>("oauth_begin"),
  oauthPoll: (sessionId: string) =>
    invoke<OAuthPoll>("oauth_poll", { sessionId }),

  // 签到
  checkinStatus: (uid: string) =>
    invoke<CheckinStatus>("checkin_status", { uid }),
  checkinAll: () => invoke<CheckinResult[]>("checkin_all"),
  checkinOne: (uid: string) => invoke<CheckinResult>("checkin_one", { uid }),

  // 猫猫旅行
  travelOverview: () => invoke<TravelOverview>("travel_overview"),
  travelDepart: (uid: string, locationId: number) =>
    invoke<unknown>("travel_depart", { uid, locationId }),
  travelClaim: (uid: string) => invoke<unknown>("travel_claim", { uid }),

  // 成长计划：按钮 disabled 已在 UI 层保证只在已记忆时调用
  openGrowthCenter: (uid: string) =>
    invoke<{
      browser?: string;
      profileDir?: string;
      url: string;
    }>("open_growth_center", { uid }),
  // 登录/记忆：拉起独立窗口供扫码建立网页登录态（退出账号重新登录的落点）
  bindGrowthCenter: (uid: string) =>
    invoke<{ browser: string; profileDir: string; url: string }>("bind_growth_center", {
      uid,
    }),
  // 各账号是否已记忆网页登录态：{uid: boolean}
  growthBoundAll: () => invoke<Record<string, boolean>>("growth_bound_all"),

  // 数据管理
  dataUids: () => invoke<string[]>("data_uids"),
  dataCurrentUid: () => invoke<string | null>("data_current_uid"),
  dataList: (category: string, uid?: string) =>
    invoke<DataItem[]>("data_list", { category, uid: uid ?? null }),
  dataRead: (item: DataItem) => invoke<string>("data_read", { item }),
  dataDelete: (items: DataItem[]) => invoke<number>("data_delete", { items }),
  dataExport: (item: DataItem, destDir: string) =>
    invoke<string>("data_export", { item, destDir }),
  dataBackup: (items: DataItem[], label: string, destDir?: string) =>
    invoke<string>("data_backup", { items, label, destDir: destDir || null }),
  dataMigrate: (fromUid: string, toUid: string, categories: string[]) =>
    invoke<number>("data_migrate", { fromUid, toUid, categories }),

  // 看板
  dashboardSummary: (fromMs: number, toMs: number) =>
    invoke<DashboardSummary>("dashboard_summary", { fromMs, toMs }),
  dashboardTrend: (fromMs: number, toMs: number, granularity: string) =>
    invoke<TrendPoint[]>("dashboard_trend", { fromMs, toMs, granularity }),
  dashboardTop: (
    fromMs: number,
    toMs: number,
    kind: "models" | "sessions" | "accounts",
    limit?: number,
  ) => invoke<TopItem[]>("dashboard_top", { fromMs, toMs, kind, limit }),
  dashboardHeatmap: (fromMs: number, toMs: number) =>
    invoke<HeatCell[]>("dashboard_heatmap", { fromMs, toMs }),
  dashboardBalances: () => invoke<BalancePoint[]>("dashboard_balances"),
  dashboardImportApp: (uid?: string) =>
    invoke<number>("dashboard_import_app", { uid: uid ?? null }),
  dashboardRequests: (fromMs: number, toMs: number, limit?: number) =>
    invoke<RequestRow[]>("dashboard_requests", {
      fromMs,
      toMs,
      limit: limit ?? null,
    }),
  dashboardAccountBilling: (fromMs: number, toMs: number) =>
    invoke<AccountBilling>("dashboard_account_billing", { fromMs, toMs }),

  // IDE 自动配置
  syncAllIdes: () => invoke<SyncResult[]>("sync_all_ides"),
  ideSyncStatus: () => invoke<SyncResult[]>("ide_sync_status"),
};

// 错误信息规整：后端 WmError 序列化为 {code, message}，也可能是字符串。
export function errText(e: unknown): string {
  if (e == null) return "未知错误";
  if (typeof e === "string") return e;
  const obj = e as Record<string, unknown>;
  if (typeof obj.message === "string") return obj.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export type { Summary };
