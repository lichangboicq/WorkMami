import type { MessageInstance } from "antd/es/message/interface";
import type { NotificationInstance } from "antd/es/notification/interface";

// 静态 message/notification 无法消费 ConfigProvider 的动态主题，
// 由 AppBridge 把 App.useApp() 的实例注入此处，业务代码改为引用本模块。
let messageApi: MessageInstance | null = null;
let notificationApi: NotificationInstance | null = null;

export function bindAntdStatic(message: MessageInstance, notification: NotificationInstance) {
  messageApi = message;
  notificationApi = notification;
}

export const staticMessage = new Proxy({} as MessageInstance, {
  get: (_t, prop) => Reflect.get(messageApi as object, prop),
});

export const staticNotification = new Proxy({} as NotificationInstance, {
  get: (_t, prop) => Reflect.get(notificationApi as object, prop),
});
