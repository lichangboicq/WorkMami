// 账号池入口：Proxy 标题行「账号池 N/M」按钮 + Popover 逐账号开关。
// 开关复用 Account.enabled（在池 = 参与积分支出），成功后刷新 accounts 与 proxy 状态。
import { useState } from "react";
import { Popover, Switch, Tooltip } from "antd";
import { TeamOutlined } from "@ant-design/icons";
import { api, errText } from "../api";
import { useStore } from "../store";
import { staticMessage as message } from "../antdStatic";

export default function AccountPoolControl() {
  const accounts = useStore((s) => s.accounts);
  const reloadAccounts = useStore((s) => s.reloadAccounts);
  const reloadProxy = useStore((s) => s.reloadProxy);
  const [open, setOpen] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const enabledCount = accounts.filter((a) => a.enabled).length;
  const poolEmpty = enabledCount === 0;

  const onToggle = async (uid: string, next: boolean) => {
    setToggling((prev) => new Set(prev).add(uid));
    try {
      await api.setAccountEnabled(uid, next);
      await Promise.all([reloadAccounts(), reloadProxy()]);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setToggling((prev) => {
        const s = new Set(prev);
        s.delete(uid);
        return s;
      });
    }
  };

  const content = (
    <div className="wm-pool-pop">
      {accounts.length === 0 ? (
        <div className="wm-pool-pop__empty">暂无账号，请先在「账号管理」页添加</div>
      ) : (
        <>
          {accounts.map((a) => (
            <div key={a.uid} className="wm-pool-pop__row">
              <Tooltip title={a.uid}>
                <span className="wm-pool-pop__name">{a.nickname || a.uid}</span>
              </Tooltip>
              <span className="wm-pool-pop__quota">
                {a.quota ? `${Math.round(a.quota.remaining).toLocaleString()} 积分` : "--"}
              </span>
              <Switch
                size="small"
                checked={a.enabled}
                loading={toggling.has(a.uid)}
                disabled={toggling.has(a.uid)}
                onChange={(v) => onToggle(a.uid, v)}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
    >
      <Tooltip title="账号池：在池中的账号参与积分支出">
        <button type="button" className={`wm-pool-btn${poolEmpty ? " is-empty" : ""}`}>
          <TeamOutlined />
          <span>账号池 {enabledCount}/{accounts.length}</span>
        </button>
      </Tooltip>
    </Popover>
  );
}
