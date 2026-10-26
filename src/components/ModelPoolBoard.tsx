// 模型池看板：池卡片横向排序（dnd-kit）+ 池内模型行纵向排序（自上而下 = 调度优先级）。
// 池名铅笔行内更名；悬停垃圾桶删除（Modal 二次确认 + 可撤销）；池级思考档位三选一（fast/medium/deep）。
// 所有变更通过 onChange(next) 上抛，由 Proxy.tsx 落盘（既有 save_settings 自动持久化 + 重启代理 + 同步）。
import { useCallback, useMemo, useState } from "react";
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
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import type { ModelInfo, ModelPool, PoolMember } from "../types";

// —— 思考档位（三选一，value 直接与后端默认池契约一致）——
const THINKING_OPTIONS = [
  { value: "快闪", label: "快闪" },
  { value: "斟酌", label: "斟酌" },
  { value: "精算", label: "精算" },
];

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
  const [addSelection, setAddSelection] = useState<string[]>([]);

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

  const commitAdd = () => {
    if (!addPool) return;
    const inPool = new Set(addPool.models.map((m) => m.id));
    const additions = addSelection
      .filter((id) => !inPool.has(id))
      .map((id) => ({ id, name: nameMap.get(id)?.name || id }));
    if (additions.length > 0) {
      onChange(
        pools.map((p) => (p.id === addPool.id ? { ...p, models: [...p.models, ...additions] } : p)),
      );
    }
    setAddPoolId(null);
    setAddSelection([]);
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
                memberName={memberName}
                memberCredits={memberCredits}
                composite={compositeMap.get(pool.id) || { rate: 0, details: [] }}
                accountCount={accountCount}
                onRename={renamePool}
                onThinking={setThinking}
                onDeletePool={confirmDeletePool}
                onDeleteModel={confirmDeleteModel}
                onAdd={(p) => {
                  setAddPoolId(p.id);
                  setAddSelection([]);
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
        onOk={commitAdd}
        onCancel={() => setAddPoolId(null)}
        okText="添加"
        cancelText="取消"
        okButtonProps={{ disabled: addSelection.length === 0 }}
        width={440}
      >
        <Select
          mode="multiple"
          style={{ width: "100%", marginTop: 8 }}
          placeholder="搜索并选择本机模型"
          value={addSelection}
          onChange={setAddSelection}
          options={candidates.map((m) => ({ value: m.id, label: m.name }))}
          optionFilterProp="label"
          notFoundContent="暂无可添加的模型"
        />
      </Modal>
    </>
  );
}

interface PoolCardProps {
  pool: ModelPool;
  memberName: (m: PoolMember) => string;
  memberCredits: (id: string) => string;
  composite: { rate: number; details: WeightedMember[] };
  accountCount: number;
  onRename: (poolId: string, name: string) => void;
  onThinking: (poolId: string, tier: string) => void;
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
  memberName,
  memberCredits,
  composite,
  accountCount,
  onRename,
  onThinking,
  onDeletePool,
  onDeleteModel,
  onAdd,
}: PoolCardProps) {
  const [editing, setEditing] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: pool.id,
    data: { type: "pool" },
  });

  // 动态组合倍率 Tooltip：模型名（左） · 倍率（紧跟模型名后） — 概率（右）
  const rateTip = (
    <>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        首选模型若被限流，将启用次选模型
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
      {/* drag-zone 包住整张卡的内容，listeners 挂在此层；
          只有 head / wm-pool-rows / wm-pool-add-row 三者未覆盖的空白（gap、padding）
          才是卡级拖拽激活区——三者自身都 stopPropagation，不冒泡到 drag-zone */}
      <div className="wm-pool-card__drag-zone" {...listeners}>
        {/* 头部：池名 | 倍率 | 思考档位 | 删除（整体不参与卡级拖拽） */}
        <div
          className="wm-pool-card__head"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {editing ? (
            <Input
              size="small"
              autoFocus
              defaultValue={pool.name}
              maxLength={20}
              className="wm-pool-name-input"
              onPressEnter={(e) => e.currentTarget.blur()}
              onBlur={(e) => {
                onRename(pool.id, e.target.value);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
              }}
            />
          ) : (
            <span
              className="wm-pool-card__name"
              title="点击重命名"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              {pool.name}
            </span>
          )}
          <Tooltip title={rateTip} placement="top">
            <span className="wm-pool-rate">{formatRate(composite.rate)}</span>
          </Tooltip>
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
          <Tooltip title="删除整个模型池">
            <span
              className="wm-pool-icon-btn"
              onClick={() => onDeletePool(pool)}
            >
              <DeleteOutlined />
            </span>
          </Tooltip>
        </div>

        {/* 主体：模型纵向全宽行，自上而下 = 调度优先级（ModelRow 各自 sortable） */}
        <div
          className="wm-pool-rows"
          onPointerDown={(e) => e.stopPropagation()}
        >
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
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PlusOutlined />
          <span>添加模型</span>
        </button>
      </div>
    </div>
  );
}

interface ModelRowProps {
  poolId: string;
  member: PoolMember;
  name: string;
  credits: string;
  onDelete: () => void;
}

function ModelRow({ poolId, member, name, credits, onDelete }: ModelRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rowKey(poolId, member.id),
    data: { type: "model", poolId },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`wm-pool-row${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="wm-pool-row__name" title={name}>
        {name}
      </span>
      {credits && <span className="wm-pool-row__credits">{credits}</span>}
      <Tooltip title="移除">
        <span
          className="wm-pool-icon-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDelete}
        >
          <DeleteOutlined />
        </span>
      </Tooltip>
    </div>
  );
}
