// 全局状态：账号列表、设置、主题、自定义模型状态。
import { create } from "zustand";
import { api, errText } from "./api";
import type {
  Account,
  AppInfo,
  AppSettings,
  ProxyStatus,
  SyncResult,
} from "./types";

export const defaultSettings: AppSettings = {
  proxy: {
    enabled: false,
    host: "127.0.0.1",
    port: 8765,
    apiKey: "",
    strategy: "smart",
    contextWindow: 128000,
    reasoningEffort: "medium",
    defaultModel: "wb-balanced",
    stickyTtlMin: 30,
    maxRetries: 3,
  },
  checkin: { autoEnabled: false, dailyTime: "09:00", notify: true },
  travel: { autoEnabled: true, locationPolicy: "longest" },
  theme: "light",
  autostart: false,
};

interface Store {
  info?: AppInfo;
  settings: AppSettings;
  accounts: Account[];
  proxy?: ProxyStatus;
  syncStatus: SyncResult[];
  loading: boolean;

  init: () => Promise<void>;
  reloadAccounts: () => Promise<void>;
  reloadProxy: () => Promise<void>;
  saveSettings: (s: AppSettings) => Promise<void>;
  setThemePref: (t: string) => void;
  syncAllIdes: () => Promise<SyncResult[]>;
  refreshSyncStatus: () => Promise<void>;
}

export const useStore = create<Store>((set, get) => ({
  settings: defaultSettings,
  accounts: [],
  syncStatus: [],
  loading: false,

  init: async () => {
    set({ loading: true });
    try {
      const [info, settings, accounts, proxy] = await Promise.all([
        api.appInfo(),
        api.getSettings(),
        api.listAccounts(),
        api.proxyStatus(),
      ]);
      set({ info, settings, accounts, proxy });
      try {
        set({ syncStatus: await api.ideSyncStatus() });
      } catch {
        /* IDE 自动配置状态拉取失败忽略 */
      }
    } catch (e) {
      console.error("初始化失败:", errText(e));
    } finally {
      set({ loading: false });
    }
  },

  reloadAccounts: async () => {
    try {
      set({ accounts: await api.listAccounts() });
    } catch (e) {
      console.error(errText(e));
    }
  },

  reloadProxy: async () => {
    try {
      set({ proxy: await api.proxyStatus() });
    } catch (e) {
      console.error(errText(e));
    }
  },

  saveSettings: async (s: AppSettings) => {
    await api.saveSettings(s);
    set({ settings: s });
    await get().reloadProxy();
    await get().refreshSyncStatus();
  },

  setThemePref: (t: string) => {
    const s = { ...get().settings, theme: t };
    set({ settings: s });
    void api.saveSettings(s);
  },

  syncAllIdes: async () => {
    const r = await api.syncAllIdes();
    set({ syncStatus: r });
    return r;
  },

  refreshSyncStatus: async () => {
    try {
      set({ syncStatus: await api.ideSyncStatus() });
    } catch {
      /* IDE 状态拉取失败忽略 */
    }
  },
}));
