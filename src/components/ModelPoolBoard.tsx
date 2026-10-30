// 模型池看板：池卡片横向排序（dnd-kit）+ 池内模型行纵向排序（自上而下 = 调度优先级）。
// 池名铅笔行内更名；悬停垃圾桶删除（Modal 二次确认 + 可撤销）；池级思考档位三选一（fast/medium/deep）。
// 所有变更通过 onChange(next) 上抛，由 Proxy.tsx 落盘（既有 save_settings 自动持久化 + 重启代理 + 同步）。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Input, Modal, Select, Tooltip, notification } from "antd";
import { DeleteOutlined, HolderOutlined, PlusOutlined } from "@ant-design/icons";
import type { ModelInfo, ModelPool, PoolMember } from "../types";

// —— 思考档位（三选一，value 直接与后端默认池契约一致）——
const THINKING_OPTIONS = [
  { value: "快闪", label: "快闪" },
  { value: "斟酌", label: "斟酌" },
  { value: "精算", label: "精算" },
];

// —— 池级忙闲筛选：五星评分式交互（与后端 /v2/chat/busy 的 busy_level 枚举对齐）——
// 「不可用」不对用户开放：后端查到明确不可用即硬性避开

// 官方「极度拥堵」图标（三个小人，暗红），取自官方模型选择器 cr-model-selector
function CongestedIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#B42C3F"
        transform="matrix(1 0 0 1 2.5 0.372669)"
        d="M2.4385 12.3505C2.2516 12.3467 2.0647 12.3505 1.8721 12.3505C1.8627 12.2939 1.8532 12.258 1.8532 12.2221C1.8532 10.7175 1.8513 9.2129 1.8551 7.7083C1.8551 7.6516 1.874 7.578 1.9136 7.5402C2.1704 7.2873 2.244 6.972 2.244 6.6265C2.2421 5.9091 2.2459 5.1917 2.2421 4.4743C2.2402 4.1779 2.2516 3.8815 2.2214 3.5889C2.1572 2.9754 1.6682 2.6148 0.9829 2.6544C0.4336 2.6865 0.005 3.1358 0.0031 3.706C-0.0025 4.733 0.0012 5.7581 0.0012 6.7851C0.0012 7.0399 0.0749 7.2759 0.2523 7.459C0.3562 7.5667 0.3826 7.6743 0.3807 7.8121C0.3769 9.481 0.3788 11.1479 0.3788 12.8168C0.3788 13.0622 0.4562 13.1661 0.6714 13.1699C1.2699 13.1774 1.8683 13.1774 2.4649 13.1661C2.7217 13.1604 2.8916 12.9716 2.884 12.7489C2.8746 12.5148 2.6952 12.3543 2.4385 12.3505ZM9.3594 12.3505C9.1725 12.3467 8.9856 12.3505 8.7911 12.3505C8.7855 12.2939 8.7779 12.2561 8.7779 12.2202C8.7779 10.7156 8.776 9.211 8.7817 7.7064C8.7817 7.6346 8.8251 7.5516 8.8742 7.4968C9.0441 7.3061 9.1517 7.0834 9.1536 6.8323C9.1612 5.7751 9.1649 4.716 9.1536 3.6588C9.148 3.1056 8.6817 2.6639 8.1285 2.6525C7.447 2.6374 6.9467 3.0131 6.9354 3.6135C6.9127 4.6896 6.9278 5.7656 6.9278 6.8417C6.9278 7.0928 7.043 7.2967 7.1902 7.493C7.2525 7.5742 7.2997 7.6894 7.2997 7.7894C7.3073 9.4696 7.3035 11.1517 7.3054 12.8319C7.3054 13.066 7.3771 13.1623 7.5905 13.1661C8.1889 13.1736 8.7874 13.1736 9.3839 13.1623C9.6388 13.1566 9.8087 12.9697 9.8011 12.7451C9.7955 12.5167 9.6161 12.3543 9.3594 12.3505ZM5.897 12.3505C5.7101 12.3467 5.5214 12.3505 5.3194 12.3505C5.3137 12.2977 5.3099 12.2731 5.3099 12.2486C5.3099 10.7383 5.308 9.228 5.3137 7.7177C5.3137 7.6516 5.3496 7.5723 5.3949 7.5233C5.578 7.3175 5.6932 7.0853 5.6931 6.8096C5.695 5.7656 5.695 4.7198 5.6931 3.6758C5.6932 3.1604 5.2457 2.6204 4.5302 2.6507C3.9318 2.6752 3.4636 3.1037 3.4598 3.6946C3.4541 4.7273 3.456 5.76 3.4598 6.7907C3.4598 7.0588 3.5636 7.2873 3.7336 7.4968C3.794 7.5704 3.8336 7.6818 3.8336 7.7762C3.8393 9.4696 3.8355 11.163 3.8374 12.8565C3.8374 13.0641 3.928 13.1661 4.1338 13.168C4.7322 13.1736 5.3288 13.1755 5.9272 13.1642C6.1934 13.1585 6.3426 12.9886 6.3369 12.7451C6.3294 12.5053 6.1613 12.3543 5.897 12.3505ZM4.568 2.19C5.1702 2.1957 5.6611 1.7105 5.6686 1.1045C5.6762 0.5023 5.1891 0.0057 4.5869 0.0001C3.9846 -0.0056 3.4919 0.4815 3.4881 1.0856C3.4862 1.6954 3.9639 2.1843 4.568 2.19ZM8.0341 2.19C8.6307 2.1938 9.1272 1.7029 9.131 1.1045C9.1366 0.5041 8.6514 0.0076 8.053 0.0001C7.4508 -0.0075 6.941 0.4947 6.941 1.0951C6.941 1.6897 7.4375 2.1862 8.0341 2.19ZM1.1038 2.19C1.7003 2.1976 2.2044 1.7029 2.2101 1.1064C2.2138 0.5041 1.7267 0.0076 1.1264 0.0001C0.5298 -0.0075 0.0277 0.4853 0.0201 1.0856C0.0126 1.6803 0.5034 2.1825 1.1038 2.19Z"
      />
    </svg>
  );
}

// 档位圆点图标（指定颜色）
function BusyDot({ color }: { color: string }) {
  return <span className="wm-busy-dot" style={{ background: color }} />;
}

const BUSY_LEVELS: { value: string; label: string; icon: ReactNode }[] = [
  { value: "idle", label: "空闲", icon: <BusyDot color="#16C162" /> },
  { value: "normal", label: "正常", icon: <BusyDot color="#2F9BFF" /> },
  { value: "busy", label: "轻微拥堵", icon: <BusyDot color="#FFD21E" /> },
  { value: "congested", label: "极度拥堵", icon: <CongestedIcon /> },
];

// —— 池上下文窗口（只读标签）：孰低原则 ——
// 与后端 pool_context_window 同规则：各成员 contextWindow 的最小值；
// 任一成员未知/窗口 ≤ 0（含缓存未就绪、池内无成员）→ 回落 131072（128K）。
const CTX_FALLBACK_TOKENS = 131072;

function poolContextTokens(pool: ModelPool, models: ModelInfo[]): { tokens: number; fallback: boolean } {
  const byId = new Map(models.map((m) => [m.id, m.contextWindow]));
  let min = 0;
  for (const m of pool.models) {
    const id = m.id.trim();
    if (!id) continue;
    const w = byId.get(id);
    if (!w || w <= 0) return { tokens: CTX_FALLBACK_TOKENS, fallback: true };
    min = min === 0 ? w : Math.min(min, w);
  }
  if (min === 0) return { tokens: CTX_FALLBACK_TOKENS, fallback: true };
  return { tokens: min, fallback: false };
}

// tokens → K 单位（1024 进制，与业界惯例一致）：131072 → "128K"；非整 K 保留一位小数
function fmtCtxK(tokens: number): string {
  const k = tokens / 1024;
  return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
}

// 计划 §6.1 固定 tooltip 文案（深色浮层）
const THINKING_TIP = (
  <div className="wm-thinking-tip">
    <div>快闪：少想，快点干</div>
    <div>斟酌：要想，但别浪费积分</div>
    <div>精算：多想，慢工出细活</div>
  </div>
);

// 同一真实模型可进多个池，行 id 需带池前缀保证全局唯一
const rowKey = (poolId: string, modelId: string) => `${poolId}::${modelId}`;
const formatRate = (rate: number) => `x${rate.toFixed(2)}`;

// —— 动态组合倍率：账号池全限流降级链概率模型 ——
// pSigma = 单账号一次请求对某模型触发 429 的概率（WorkBuddy 限流强度基线）
const P_SIGMA = 0.25;

/// 解析 credits 字符串（"x0.69 credits" / "x0.00" 等），无匹配返回 null
function parseCredits(s: string): number | null {
  const m = s.match(/x([\d.]+)/i);
  return m ? Number(m[1]) : null;
}

/// 给定池内 N 个成员的 credits 数组 + 账号数 K，返回被选中概率 [P₀, P₁, ..., P_{N-1}]
/// 物理含义：越靠后的模型，只有当前面所有模型在 K 个账号上全部 429 时才会被用到
function selectionProbs(n: number, accountCount: number): number[] {
  if (n <= 0) return [];
  const k = Math.max(1, accountCount);
  const q = Math.pow(P_SIGMA, k); // 某个模型在 K 账号上全限流的概率
  const out: number[] = new Array(n);
  for (let i = 0; i < n - 1; i++) out[i] = Math.pow(q, i) * (1 - q);
  out[n - 1] = Math.pow(q, n - 1); // 最后一个兜底
  return out;
}

interface WeightedMember {
  id: string;
  name: string;
  rate: number;        // 解析后的 credits 倍率
  p: number;           // 被选中概率
}

/// 计算池的动态组合倍率 + 每个成员的加权明细
/// members 为池内成员（已过滤掉 credits 缺失的），缺的位置概率重新归一化
function computeCompositeRate(
  pool: ModelPool,
  memberName: (m: PoolMember) => string,
  modelCredits: (id: string) => string,
  accountCount: number,
): { rate: number; details: WeightedMember[] } {
  // 1. 解析每个成员的 credits，缺失则跳过
  const parsed: Array<{ m: PoolMember; rate: number }> = [];
  for (const m of pool.models) {
    const rate = parseCredits(modelCredits(m.id));
    if (rate != null) parsed.push({ m, rate });
  }
  if (parsed.length === 0) {
    return { rate: 0, details: [] };
  }
  // 2. 降级链概率
  const probs = selectionProbs(parsed.length, accountCount);
  // 3. 组合倍率 + 明细
  let total = 0;
  const details: WeightedMember[] = [];
  parsed.forEach(({ m, rate }, i) => {
    const p = probs[i];
    total += p * rate;
    details.push({ id: m.id, name: memberName(m), rate, p });
  });
  return { rate: total, details };
}

interface BoardProps {
  pools: ModelPool[];
  models: ModelInfo[]; // 本机真实模型（「+ 添加模型」选择器数据源）
  accountCount: number; // 有效账号数，决定降级链概率 q(K)
  onChange: (next: ModelPool[]) => void;
}

export default function ModelPoolBoard({ pools, models, accountCount, onChange }: BoardProps) {
  const [modal, modalContextHolder] = Modal.useModal();
  const [addPoolId, setAddPoolId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const nameMap = useMemo(() => {
    const map = new Map<string, ModelInfo>();
    for (const m of models) map.set(m.id, m);
    return map;
  }, [models]);

  const memberName = useCallback(
    (m: PoolMember) => m.name || nameMap.get(m.id)?.name || m.id,
    [nameMap],
  );
  const memberCredits = useCallback(
    (id: string) => (nameMap.get(id)?.credits || "").match(/x[\d.]+/)?.[0] || "",
    [nameMap],
  );

  // 按拖拽类型过滤 droppable：池拖拽只命中池卡片，行拖拽只命中模型行
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const type = args.active.data.current?.type;
      const allowed =
        type === "pool"
          ? pools.map((p) => p.id)
          : pools.flatMap((p) => p.models.map((m) => rowKey(p.id, m.id)));
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) =>
          allowed.includes(String(c.id)),
        ),
      });
    },
    [pools],
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    if (active.data.current?.type === "pool") {
      const from = pools.findIndex((p) => p.id === active.id);
      const to = pools.findIndex((p) => p.id === over.id);
      if (from < 0 || to < 0) return;
      onChange(arrayMove(pools, from, to));
      return;
    }
    // 池内模型行排序（不支持跨池拖拽成员）
    const poolId = String(active.data.current?.poolId ?? "");
    if (poolId !== String(over.data.current?.poolId ?? "")) return;
    const pool = pools.find((p) => p.id === poolId);
    if (!pool) return;
    const from = pool.models.findIndex((m) => rowKey(poolId, m.id) === active.id);
    const to = pool.models.findIndex((m) => rowKey(poolId, m.id) === over.id);
    if (from < 0 || to < 0) return;
    onChange(
      pools.map((p) => (p.id === poolId ? { ...p, models: arrayMove(pool.models, from, to) } : p)),
    );
  };

  // —— 删除（二次确认 + 可撤销：恢复删除前的 pools 快照）——
  const notifyUndo = (snapshot: ModelPool[], content: string) => {
    const key = `wm-pool-undo-${Date.now()}`;
    notification.open({
      message: "已删除",
      description: content,
      key,
      placement: "bottomRight",
      duration: 6,
      btn: (
        <Button
          size="small"
          onClick={() => {
            onChange(snapshot);
            notification.destroy(key);
          }}
        >
          撤销
        </Button>
      ),
    });
  };

  const confirmDeletePool = (pool: ModelPool) => {
    modal.confirm({
      title: "删除模型池",
      content: `确定删除「${pool.name}」？删除后将实时同步到 WorkBuddy。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => {
        notifyUndo(pools, `已删除模型池「${pool.name}」`);
        onChange(pools.filter((p) => p.id !== pool.id));
      },
    });
  };

  const confirmDeleteModel = (pool: ModelPool, member: PoolMember) => {
    modal.confirm({
      title: "移除模型",
      content: `确定从「${pool.name}」移除「${memberName(member)}」？`,
      okText: "移除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => {
        notifyUndo(pools, `已从「${pool.name}」移除「${memberName(member)}」`);
        onChange(
          pools.map((p) =>
            p.id === pool.id ? { ...p, models: p.models.filter((m) => m.id !== member.id) } : p,
          ),
        );
      },
    });
  };

  // —— 池级操作 ——
  const renamePool = (poolId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return; // 空名不落盘，保留原名
    // id 跟随 name 同步更新，保证 WorkBuddy 侧展示与调用都使用中文池名
    const idCollision = pools.some((p) => p.id !== poolId && p.name === trimmed);
    const newId = idCollision ? `${trimmed}-${Date.now().toString(36).slice(-4)}` : trimmed;
    onChange(pools.map((p) => (p.id === poolId ? { ...p, name: trimmed, id: newId } : p)));
  };

  const setThinking = (poolId: string, tier: string) => {
    onChange(pools.map((p) => (p.id === poolId ? { ...p, thinking: tier } : p)));
  };

  const setBusyFilter = (poolId: string, levels: string[]) => {
    onChange(pools.map((p) => (p.id === poolId ? { ...p, busyFilter: levels } : p)));
  };

  const setSchedule = (poolId: string, modelId: string, schedule: string) => {
    onChange(
      pools.map((p) =>
        p.id === poolId
          ? {
              ...p,
              models: p.models.map((m) => (m.id === modelId ? { ...m, schedule } : m)),
            }
          : p,
      ),
    );
  };

  const createPool = () => {
    const ids = new Set(pools.map((p) => p.id));
    let id = "";
    do {
      id = `wm-pool-${Math.random().toString(36).slice(2, 8)}`;
    } while (ids.has(id));
    onChange([...pools, { id, name: "新模型池", rate: 0, thinking: "快闪", models: [] }]);
  };

  // —— 添加模型（只列本机真实模型且未在本池者）——
  const addPool = pools.find((p) => p.id === addPoolId) || null;
  const candidates = useMemo(() => {
    if (!addPool) return [];
    const inPool = new Set(addPool.models.map((m) => m.id));
    return models.filter((m) => !inPool.has(m.id));
  }, [addPool, models]);

  // —— 动态组合倍率预计算（每个池各算一份，依赖 pools/models/accountCount）——
  const compositeMap = useMemo(() => {
    const map = new Map<string, { rate: number; details: WeightedMember[] }>();
    for (const pool of pools) {
      map.set(pool.id, computeCompositeRate(pool, memberName, memberCredits, accountCount));
    }
    return map;
  }, [pools, memberName, memberCredits, accountCount]);

  // 关联菜单式添加：点击模型 chip 立即入池（可连续点击添加多个）
  const addModelToPool = (poolId: string, m: ModelInfo) => {
    onChange(
      pools.map((p) =>
        p.id === poolId ? { ...p, models: [...p.models, { id: m.id, name: m.name }] } : p,
      ),
    );
  };

  return (
    <>
      {modalContextHolder}
      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={onDragEnd}>
        <SortableContext items={pools.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
          <div className="wm-pool-board">
            {pools.map((pool) => (
              <PoolCard
                key={pool.id}
                pool={pool}
                models={models}
                memberName={memberName}
                memberCredits={memberCredits}
                composite={compositeMap.get(pool.id) || { rate: 0, details: [] }}
                accountCount={accountCount}
                onRename={renamePool}
                onThinking={setThinking}
                onBusy={setBusyFilter}
                onSchedule={setSchedule}
                onDeletePool={confirmDeletePool}
                onDeleteModel={confirmDeleteModel}
                onAdd={(p) => {
                  setAddPoolId(p.id);
                }}
              />
            ))}
            <div className="wm-pool-new-col">
              <Button
                type="text"
                icon={<PlusOutlined />}
                className="wm-pool-new-btn"
                onClick={createPool}
              >
                新建模型池
              </Button>
            </div>
          </div>
        </SortableContext>
      </DndContext>
      <Modal
        title={addPool ? `添加模型到「${addPool.name}」` : "添加模型"}
        open={addPool != null}
        onCancel={() => setAddPoolId(null)}
        width={720}
        footer={
          <Button key="done" type="primary" onClick={() => setAddPoolId(null)}>
            完成
          </Button>
        }
      >
        <div className="wm-add-hint">点击模型立即加入，可连续点击添加多个</div>
        {candidates.length === 0 ? (
          <div className="wm-add-grid__empty">本机模型已全部在池内</div>
        ) : (
          <div className="wm-add-grid">
            {candidates.map((m) => {
              const badges = (m.tags || [])
                .filter((t) => t.startsWith("badge:"))
                .map((t) => {
                  const mm = t.match(/^badge:([^:#]+)(?::(#[0-9a-fA-F]{3,8}))?$/);
                  return mm
                    ? { name: mm[1], color: mm[2] || "#8a8f98" }
                    : { name: t.slice(6), color: "#8a8f98" };
                });
              const credits = (m.credits || "").match(/x[\d.]+/)?.[0] || "";
              return (
                <button
                  key={m.id}
                  type="button"
                  className="wm-add-chip"
                  title={`${m.name}${credits ? ` · ${credits}` : ""}`}
                  onClick={() => addModelToPool(addPool!.id, m)}
                >
                  <span className="wm-add-chip__name">{m.name}</span>
                  <span className="wm-add-chip__meta">
                    {badges.map((b) => (
                      <span
                        key={b.name}
                        className="wm-add-chip__badge"
                        style={{ color: b.color, borderColor: b.color }}
                      >
                        {b.name}
                      </span>
                    ))}
                    {credits && <span className="wm-add-chip__credits">{credits}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Modal>
    </>
  );
}

interface PoolCardProps {
  pool: ModelPool;
  models: ModelInfo[];
  memberName: (m: PoolMember) => string;
  memberCredits: (id: string) => string;
  composite: { rate: number; details: WeightedMember[] };
  accountCount: number;
  onRename: (poolId: string, name: string) => void;
  onThinking: (poolId: string, tier: string) => void;
  onBusy: (poolId: string, levels: string[]) => void;
  onSchedule: (poolId: string, modelId: string, schedule: string) => void;
  onDeletePool: (pool: ModelPool) => void;
  onDeleteModel: (pool: ModelPool, m: PoolMember) => void;
  onAdd: (pool: ModelPool) => void;
}

// 小数 → 短百分比：0.99902 → "99.9%"；0.000095 → "0.01%"；≈ 0 → "<0.01%"
function fmtPct(p: number): string {
  if (p < 0.0001) return "<0.01%";
  return `${(p * 100).toFixed(p >= 0.1 ? 1 : 2)}%`;
}

function PoolCard({
  pool,
  models,
  memberName,
  memberCredits,
  composite,
  accountCount,
  onRename,
  onThinking,
  onBusy,
  onSchedule,
  onDeletePool,
  onDeleteModel,
  onAdd,
}: PoolCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: pool.id,
    data: { type: "pool" },
  });

  // —— 上下文窗口标签（只读）：孰低原则，与后端 pool_context_window 同规则 ——
  const ctx = useMemo(() => poolContextTokens(pool, models), [pool, models]);
  const ctxTip = useMemo(() => {
    const winById = new Map(models.map((m) => [m.id, m.contextWindow]));
    const members = pool.models
      .filter((m) => m.id.trim())
      .map((m) => {
        const w = winById.get(m.id);
        return [memberName(m), w && w > 0 ? fmtCtxK(w) : "未知"] as const;
      });
    return (
      <div className="wm-thinking-tip">
        <div>上下文窗口（孰低原则）</div>
        {members.length > 0 ? (
          members.map(([name, w]) => (
            <div key={name} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span>· {name}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.75 }}>{w}</span>
            </div>
          ))
        ) : (
          <div>· 池内暂无成员</div>
        )}
        {ctx.fallback && <div>有成员窗口未知 → 回落 {fmtCtxK(CTX_FALLBACK_TOKENS)}</div>}
      </div>
    );
  }, [pool, models, ctx, memberName]);

  // 动态组合倍率 Tooltip：模型名（左） · 倍率（紧跟模型名后） — 概率（右）
  const rateTip = (
    <>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        首选模型若被限流，启用备选的概率
      </div>
      <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 1 }}>
        {composite.details.map((d, i) => (
          <div
            key={d.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              fontSize: 13,
            }}
          >
            <span style={{ whiteSpace: "nowrap" }}>
              <b style={{ opacity: 0.7 }}>{i + 1}.</b> {d.name}{" "}
              <span style={{ fontSize: 12, opacity: 0.65 }}>· {formatRate(d.rate)}</span>
            </span>
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                fontWeight: 600,
                marginLeft: 16,
                opacity: d.p < 0.01 ? 0.55 : 1,
              }}
            >
              {fmtPct(d.p)}
            </span>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      className={`wm-pool-card${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {/* 头部第一行：拖拽手柄 | 删除（永远首行，悬停显现）| 池名 | 倍率 | 上下文 */}
      <div className="wm-pool-card__head">
        <span
          className="wm-pool-drag-handle"
          title="拖拽排序模型池"
          {...listeners}
        >
          <HolderOutlined />
        </span>
        <Tooltip title="删除整个模型池">
          <span
            className="wm-pool-icon-btn"
            onClick={() => onDeletePool(pool)}
          >
            <DeleteOutlined />
          </span>
        </Tooltip>
        <Input
          size="small"
          defaultValue={pool.name}
          maxLength={20}
          className="wm-pool-name-input"
          onPressEnter={(e) => e.currentTarget.blur()}
          onBlur={(e) => onRename(pool.id, e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
        <Tooltip title={rateTip} placement="top">
          <span className="wm-pool-rate">{formatRate(composite.rate)}</span>
        </Tooltip>
        <Tooltip title={ctxTip} placement="top">
          <span className="wm-pool-ctx">{fmtCtxK(ctx.tokens)}</span>
        </Tooltip>
      </div>

      {/* 头部第二行：思考档位 | 忙闲评分（价格/上下文已上移进标题栏） */}
      <div className="wm-pool-card__meta">
        <Tooltip title={THINKING_TIP} placement="top">
          <Select
            className="wm-thinking-select"
            variant="borderless"
            size="small"
            value={pool.thinking}
            options={THINKING_OPTIONS}
            onChange={(v) => onThinking(pool.id, v)}
            popupMatchSelectWidth={false}
          />
        </Tooltip>
        <BusyRating value={pool.busyFilter ?? []} onChange={(v) => onBusy(pool.id, v)} />
      </div>

      {/* 主体：模型纵向全宽行，自上而下 = 调度优先级（ModelRow 各自 sortable） */}
      <div className="wm-pool-rows">
        <SortableContext
          items={pool.models.map((m) => rowKey(pool.id, m.id))}
          strategy={verticalListSortingStrategy}
        >
          {pool.models.map((m) => (
            <ModelRow
              key={m.id}
              poolId={pool.id}
              member={m}
              name={memberName(m)}
              credits={memberCredits(m.id)}
              onSchedule={(schedule) => onSchedule(pool.id, m.id, schedule)}
              onDelete={() => onDeleteModel(pool, m)}
            />
          ))}
        </SortableContext>
      </div>

      {/* 池末：添加模型 */}
      <button
        type="button"
        className="wm-pool-add-row"
        onClick={() => onAdd(pool)}
      >
        <PlusOutlined />
        <span>添加模型</span>
      </button>
    </div>
  );
}

interface ModelRowProps {
  poolId: string;
  member: PoolMember;
  name: string;
  credits: string;
  onSchedule: (schedule: string) => void;
  onDelete: () => void;
}

function ModelRow({ poolId, member, name, credits, onSchedule, onDelete }: ModelRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rowKey(poolId, member.id),
    data: { type: "model", poolId },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      className={`wm-pool-row${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span
        className="wm-pool-drag-handle"
        title="拖拽排序"
        {...listeners}
      >
        <HolderOutlined />
      </span>
      <span className="wm-pool-row__gap wm-pool-row__gap--fixed" aria-hidden="true" />
      <span className="wm-pool-row__name" title={name}>
        {name}
      </span>
      <span className="wm-pool-row__gap" aria-hidden="true" />
      {credits && <span className="wm-pool-row__credits">{credits}</span>}
      <span className="wm-pool-row__gap wm-pool-row__gap--fixed" aria-hidden="true" />
      <ScheduleSelect schedule={member.schedule ?? ""} modelName={name} onChange={onSchedule} />
      <span className="wm-pool-row__gap wm-pool-row__gap--fixed" aria-hidden="true" />
      <Tooltip title="移除">
        <span
          className="wm-pool-icon-btn"
          onClick={onDelete}
        >
          <DeleteOutlined />
        </span>
      </Tooltip>
    </div>
  );
}

// —— 成员级启用时段（三选一，一次点击）——
// 下拉显示短名，解释语放各选项 tooltip；value 沿用旧值，兼容既有数据
const SCHEDULE_OPTIONS = [
  { value: "全天", label: "全天", tip: "任何时间都启用" },
  { value: "夜间", label: "夜间", tip: "仅 23:00–08:00 启用" },
  { value: "避开高峰", label: "闲时", tip: "避开高峰：周一至五 9–12、14–18 属高峰" },
];

// 旧版 "HH:mm-HH:mm" 自定义窗口仍兼容评估，下拉里原样显示；选任意预设即覆盖
function scheduleLabel(s: string | undefined): string {
  const v = (s ?? "").trim();
  if (!v) return "全天";
  return v;
}

function ScheduleSelect({
  schedule,
  modelName,
  onChange,
}: {
  schedule: string;
  modelName: string;
  onChange: (schedule: string) => void;
}) {
  const value = scheduleLabel(schedule);
  // 选项 tooltip 受控实现：悬停选项 400ms 后打开锚在该选项上的 Tooltip，离开/关下拉即关闭
  const [tipLabel, setTipLabel] = useState<string | null>(null);
  const tipTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);
  const clearTipTimer = () => {
    window.clearTimeout(tipTimer.current);
    tipTimer.current = undefined;
  };
  return (
    <Tooltip title={`选择${modelName}的生效时间`}>
      <Select
        size="small"
        variant="borderless"
        value={value}
        options={SCHEDULE_OPTIONS}
        onDropdownVisibleChange={(open) => {
          if (!open) {
            clearTipTimer();
            setTipLabel(null);
          }
        }}
        optionRender={(o) => {
          const tip = (o as unknown as { tip?: string }).tip;
          return (
            <Tooltip title={tip} open={tipLabel === o.label} placement="right">
              <span
                style={{ display: "block" }}
                onMouseEnter={() => {
                  clearTipTimer();
                  tipTimer.current = window.setTimeout(() => setTipLabel(String(o.label)), 400);
                }}
                onMouseLeave={() => {
                  clearTipTimer();
                  setTipLabel(null);
                }}
              >
                {o.label}
              </span>
            </Tooltip>
          );
        }}
        onChange={(v) => onChange(v === "全天" ? "" : v)}
        popupMatchSelectWidth={false}
        className={`wm-pool-row__schedule-select${value === "全天" ? "" : " is-active"}`}
        onClick={(e) => e.stopPropagation()}
      />
    </Tooltip>
  );
}

// —— 池级忙闲筛选：五星评分式交互 ——
// 点第 N 档 → 左侧 1..N 档全亮（接受到该档为止），右侧档位不接受；重复点击结果不变。
// 兼容旧多选数据：阈值取白名单中出现的最高档位，点击后才规整为前缀集合。
function BusyRating({
  value,
  onChange,
}: {
  value: string[];
  onChange: (levels: string[]) => void;
}) {
  // hover 预览：悬停第 N 档时 1..N 档先半亮，点击才落定（星级评分惯例）
  const [hoverIdx, setHoverIdx] = useState(-1);
  let threshold = -1;
  BUSY_LEVELS.forEach((l, i) => {
    if (value.includes(l.value)) threshold = Math.max(threshold, i);
  });
  const click = (i: number) => {
    onChange(BUSY_LEVELS.slice(0, i + 1).map((l) => l.value));
  };
  return (
    <span
      className="wm-busy-rating"
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={() => setHoverIdx(-1)}
    >
      {BUSY_LEVELS.map((l, i) => {
        const lit = i <= threshold;
        const preview = !lit && hoverIdx >= 0 && i <= hoverIdx;
        return (
          <Tooltip key={l.value} title={`愿接受[${l.label}]`} placement="top">
            <span
              className={[
                "wm-busy-rating__seg",
                lit ? "is-lit" : "",
                preview ? "is-preview" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => click(i)}
              onMouseEnter={() => setHoverIdx(i)}
            >
              {l.icon}
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}
