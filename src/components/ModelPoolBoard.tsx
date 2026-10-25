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
import { DeleteOutlined, EditOutlined, HolderOutlined, PlusOutlined } from "@ant-design/icons";
import type { ModelInfo, ModelPool, PoolMember } from "../types";

// —— 思考档位（三选一，key 与后端 §4.1 契约一致）——
const THINKING_OPTIONS = [
  { value: "fast", label: "快闪" },
  { value: "medium", label: "斟酌" },
  { value: "deep", label: "精算" },
];

// 计划 §6.1 固定 tooltip 文案（深色浮层）
const THINKING_TIP = (
  <div className="wm-thinking-tip">
    <div className="wm-thinking-tip__title">思考档位 · 三选一</div>
    <div>快闪（文员本意）：少想，快点干</div>
    <div>斟酌（程序员本意）：想，但别浪费时间和积分</div>
    <div>精算（架构师本意）：多想，别出错</div>
  </div>
);

// 同一真实模型可进多个池，行 id 需带池前缀保证全局唯一
const rowKey = (poolId: string, modelId: string) => `${poolId}::${modelId}`;
const formatRate = (rate: number) => `x${rate.toFixed(2)}`;

interface BoardProps {
  pools: ModelPool[];
  models: ModelInfo[]; // 本机真实模型（「+ 添加模型」选择器数据源）
  onChange: (next: ModelPool[]) => void;
}

export default function ModelPoolBoard({ pools, models, onChange }: BoardProps) {
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
    onChange(pools.map((p) => (p.id === poolId ? { ...p, name: trimmed } : p)));
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
    onChange([...pools, { id, name: "新模型池", rate: 0, thinking: "fast", models: [] }]);
  };

  // —— 添加模型（只列本机真实模型且未在本池者）——
  const addPool = pools.find((p) => p.id === addPoolId) || null;
  const candidates = useMemo(() => {
    if (!addPool) return [];
    const inPool = new Set(addPool.models.map((m) => m.id));
    return models.filter((m) => !inPool.has(m.id));
  }, [addPool, models]);

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
  onRename: (poolId: string, name: string) => void;
  onThinking: (poolId: string, tier: string) => void;
  onDeletePool: (pool: ModelPool) => void;
  onDeleteModel: (pool: ModelPool, m: PoolMember) => void;
  onAdd: (pool: ModelPool) => void;
}

function PoolCard({
  pool,
  memberName,
  memberCredits,
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

  return (
    <div
      ref={setNodeRef}
      className={`wm-pool-card${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {/* 头部：拖拽柄 | 池名/铅笔更名 | 倍率 | 思考档位 | 悬停删池 */}
      <div className="wm-pool-card__head">
        <span className="wm-pool-drag-handle" title="拖动调整池顺序" {...attributes} {...listeners}>
          <HolderOutlined />
        </span>
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
          <>
            <span className="wm-pool-card__name" title={pool.name}>
              {pool.name}
            </span>
            <Tooltip title="重命名">
              <span
                className="wm-pool-icon-btn wm-pool-icon-btn--edit"
                onClick={() => setEditing(true)}
              >
                <EditOutlined />
              </span>
            </Tooltip>
          </>
        )}
        <span className="wm-pool-rate">{formatRate(pool.rate)}</span>
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
          <span className="wm-pool-icon-btn" onClick={() => onDeletePool(pool)}>
            <DeleteOutlined />
          </span>
        </Tooltip>
      </div>

      {/* 主体：模型纵向全宽行，自上而下 = 调度优先级 */}
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
              onDelete={() => onDeleteModel(pool, m)}
            />
          ))}
        </SortableContext>
      </div>

      {/* 池末：添加模型 */}
      <button type="button" className="wm-pool-add-row" onClick={() => onAdd(pool)}>
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
      className={`wm-pool-row${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="wm-pool-drag-handle" title="拖动调整优先级" {...attributes} {...listeners}>
        <HolderOutlined />
      </span>
      <span className="wm-pool-row__name" title={name}>
        {name}
      </span>
      {credits && <span className="wm-pool-row__credits">{credits}</span>}
      <Tooltip title="移除">
        <span className="wm-pool-icon-btn" onClick={onDelete}>
          <DeleteOutlined />
        </span>
      </Tooltip>
    </div>
  );
}
