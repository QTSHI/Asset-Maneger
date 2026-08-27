import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Edit3,
  FolderKanban,
  Landmark,
  Link2,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  WalletCards,
  X,
} from "lucide-react";
import { api } from "./api";
import type {
  DashboardData,
  FinancialMemo,
  HouseholdProject,
  HouseholdSummary,
  HouseholdTransaction,
  MetaData,
  ValuedAsset,
} from "./types";

const money = (value: number, hidden = false) =>
  hidden
    ? "••••••"
    : new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "CNY",
        maximumFractionDigits: 2,
      }).format(value || 0);
const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().toISOString().slice(0, 7);

function PageHead({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <span>Stone Wealth</span>
            <h3>{title}</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function SubmitButton({
  pending,
  children = "保存",
}: {
  pending?: boolean;
  children?: ReactNode;
}) {
  return (
    <button className="primary-button" disabled={pending} type="submit">
      {pending ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}{" "}
      {pending ? "正在保存" : children}
    </button>
  );
}

function EmptyState({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state-page">
      {icon}
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function useMeta() {
  return useQuery({
    queryKey: ["meta"],
    queryFn: () => api.get<MetaData>("/meta"),
    staleTime: 300_000,
  });
}

export function AssetsPage({ privateMode }: { privateMode: boolean }) {
  const client = useQueryClient();
  const assets = useQuery({
    queryKey: ["assets"],
    queryFn: () => api.get<ValuedAsset[]>("/assets"),
  });
  const meta = useMeta();
  const [view, setView] = useState<"class" | "account">("class");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ValuedAsset | "new" | null>(null);
  const [expanded, setExpanded] = useState<string[]>([
    "cash",
    "fund",
    "stock",
    "alternative",
    "unclassified",
  ]);

  const filtered = (assets.data || []).filter((asset) =>
    `${asset.name} ${asset.code} ${asset.accountName}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; label: string; assets: ValuedAsset[]; value: number }
    >();
    for (const asset of filtered) {
      const key = String(view === "class" ? asset.classCode : asset.accountId);
      const label = view === "class" ? asset.classLabel : asset.accountName;
      const item = map.get(key) || { key, label, assets: [], value: 0 };
      item.assets.push(asset);
      item.value += asset.marketValueCny;
      map.set(key, item);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [filtered, view]);

  const archive = useMutation({
    mutationFn: (id: number) => api.delete(`/assets/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["assets"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const total = filtered.reduce((sum, asset) => sum + asset.marketValueCny, 0);

  return (
    <div className="page-stack">
      <PageHead
        eyebrow="Asset intelligence"
        title="家庭资产"
        description="先看资产是什么，再看它分布在哪些账户。"
        action={
          <button className="primary-button" onClick={() => setEditing("new")}>
            <Plus size={16} /> 添加资产
          </button>
        }
      />
      <div className="summary-strip">
        <div>
          <span>当前资产</span>
          <strong>{money(total, privateMode)}</strong>
        </div>
        <div>
          <span>持仓数量</span>
          <strong>{filtered.length}</strong>
        </div>
        <div>
          <span>待分类</span>
          <strong>
            {filtered.filter((x) => x.classCode === "unclassified").length}
          </strong>
        </div>
        <div>
          <span>行情需关注</span>
          <strong>
            {filtered.filter((x) => x.quote.status !== "fresh").length}
          </strong>
        </div>
      </div>
      <div className="toolbar">
        <div className="segmented">
          <button
            className={view === "class" ? "active" : ""}
            onClick={() => setView("class")}
          >
            按资产类别
          </button>
          <button
            className={view === "account" ? "active" : ""}
            onClick={() => setView("account")}
          >
            按账户平台
          </button>
        </div>
        <label className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称、代码或账户"
          />
        </label>
      </div>
      <div className="group-list">
        {groups.map((group) => {
          const open = expanded.includes(group.key);
          return (
            <section className="asset-group" key={group.key}>
              <button
                className="group-head"
                onClick={() =>
                  setExpanded(
                    open
                      ? expanded.filter((x) => x !== group.key)
                      : [...expanded, group.key],
                  )
                }
              >
                <div>
                  <span className={`asset-dot asset-${group.key}`} />
                  <div>
                    <strong>{group.label}</strong>
                    <small>{group.assets.length} 项资产</small>
                  </div>
                </div>
                <div>
                  <strong>{money(group.value, privateMode)}</strong>
                  <small>
                    {total ? ((group.value / total) * 100).toFixed(1) : 0}%
                  </small>
                  <ChevronDown className={open ? "rotated" : ""} size={17} />
                </div>
              </button>
              {open && (
                <div className="responsive-table">
                  <table>
                    <thead>
                      <tr>
                        <th>资产</th>
                        <th>账户</th>
                        <th>类型</th>
                        <th>现价</th>
                        <th>市值</th>
                        <th>盈亏</th>
                        <th>行情</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {group.assets.map((asset) => (
                        <tr key={asset.id}>
                          <td data-label="资产">
                            <strong>{asset.name}</strong>
                            <small>
                              {asset.code} · {asset.currency}
                            </small>
                          </td>
                          <td data-label="账户">{asset.accountName}</td>
                          <td data-label="类型">
                            <span className="tag">{asset.subtypeLabel}</span>
                          </td>
                          <td data-label="现价">
                            {asset.currentPrice.toLocaleString()}
                          </td>
                          <td data-label="市值">
                            <strong>
                              {money(asset.marketValueCny, privateMode)}
                            </strong>
                          </td>
                          <td data-label="盈亏">
                            <span
                              className={
                                asset.profitCny >= 0 ? "positive" : "negative"
                              }
                            >
                              {money(asset.profitCny, privateMode)}
                              <small>{asset.profitPercent.toFixed(1)}%</small>
                            </span>
                          </td>
                          <td data-label="行情">
                            <span className={`status ${asset.quote.status}`}>
                              {asset.quote.status === "fresh"
                                ? "已更新"
                                : asset.quote.status === "missing"
                                  ? "待更新"
                                  : "已过期"}
                            </span>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                onClick={() => setEditing(asset)}
                                aria-label="编辑"
                              >
                                <Edit3 size={15} />
                              </button>
                              <button
                                onClick={() =>
                                  confirm(`归档 ${asset.name}？`) &&
                                  archive.mutate(asset.id)
                                }
                                aria-label="归档"
                              >
                                <Archive size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
        {!groups.length && (
          <EmptyState
            icon={<Landmark />}
            title="没有匹配的资产"
            text="调整搜索条件，或添加第一项资产。"
          />
        )}
      </div>
      {editing && meta.data && (
        <AssetForm
          asset={editing === "new" ? undefined : editing}
          meta={meta.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            client.invalidateQueries({ queryKey: ["assets"] });
            client.invalidateQueries({ queryKey: ["dashboard"] });
          }}
        />
      )}
    </div>
  );
}

function AssetForm({
  asset,
  meta,
  onClose,
  onSaved,
}: {
  asset?: ValuedAsset;
  meta: MetaData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (payload: unknown) =>
      asset
        ? api.patch(`/assets/${asset.id}`, payload)
        : api.post("/assets", payload),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      platform_id: Number(form.get("platform_id")),
      asset_type_id: Number(form.get("asset_type_id")),
      currency_id: Number(form.get("currency_id")),
      code: form.get("code"),
      name: form.get("name"),
      shares: Number(form.get("shares")),
      cost_price: Number(form.get("cost_price")),
    });
  };
  return (
    <Modal title={asset ? "编辑资产" : "添加资产"} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label>
          <span>资产代码</span>
          <input name="code" defaultValue={asset?.code} required />
        </label>
        <label>
          <span>名称</span>
          <input name="name" defaultValue={asset?.name} />
        </label>
        <label>
          <span>账户</span>
          <select name="platform_id" defaultValue={asset?.accountId} required>
            {meta.accounts.map((x) => (
              <option value={x.id} key={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>资产类型</span>
          <select
            name="asset_type_id"
            defaultValue={asset?.assetTypeId}
            required
          >
            {meta.assetTypes.map((x) => (
              <option value={x.id} key={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>份额 / 数量</span>
          <input
            name="shares"
            type="number"
            step="any"
            defaultValue={asset?.shares}
            required
          />
        </label>
        <label>
          <span>成本价</span>
          <input
            name="cost_price"
            type="number"
            min="0"
            step="any"
            defaultValue={asset?.costPrice}
            required
          />
        </label>
        <label className="span-2">
          <span>币种</span>
          <select
            name="currency_id"
            defaultValue={
              meta.currencies.find((x) => x.code === asset?.currency)?.id
            }
            required
          >
            {meta.currencies.map((x) => (
              <option value={x.id} key={x.id}>
                {x.code}
              </option>
            ))}
          </select>
        </label>
        {mutation.error && (
          <p className="form-error span-2">{mutation.error.message}</p>
        )}
        <div className="form-actions span-2">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <SubmitButton pending={mutation.isPending} />
        </div>
      </form>
    </Modal>
  );
}

export function BudgetPage({ privateMode }: { privateMode: boolean }) {
  const client = useQueryClient();
  const meta = useMeta();
  const [month, setMonth] = useState(currentMonth());
  const query = useQuery({
    queryKey: ["budget", month],
    queryFn: () =>
      api.get<HouseholdSummary>(`/household/budgets?month=${month}`),
  });
  const [amounts, setAmounts] = useState<Record<number, number>>({});
  useEffect(() => {
    if (query.data)
      setAmounts(
        Object.fromEntries(
          query.data.budgets.map((x) => [x.categoryId, x.planned]),
        ),
      );
  }, [query.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put("/household/budgets", {
        month,
        items: (meta.data?.categories || []).map((x) => ({
          category_id: x.id,
          planned_amount_cny: amounts[x.id] || 0,
        })),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["budget", month] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const previous = new Date(`${month}-01T00:00:00`);
  previous.setMonth(previous.getMonth() - 1);
  const previousMonth = previous.toISOString().slice(0, 7);
  const copy = useMutation({
    mutationFn: () =>
      api.post("/household/budgets/copy", {
        fromMonth: previousMonth,
        toMonth: month,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["budget", month] }),
  });
  const data = query.data;
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="Household budget"
        title="家庭预算"
        description="按月安排家庭开支，实际收支独立记录，不自动影响资产。"
        action={
          <div className="month-control">
            <CalendarDays size={16} />
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </div>
        }
      />
      {data && (
        <div className="summary-strip budget-strip">
          <div>
            <span>月度预算</span>
            <strong>{money(data.totals.plannedExpense, privateMode)}</strong>
          </div>
          <div>
            <span>实际支出</span>
            <strong>{money(data.totals.expense, privateMode)}</strong>
          </div>
          <div>
            <span>预算剩余</span>
            <strong
              className={
                data.totals.remainingBudget >= 0 ? "positive" : "negative"
              }
            >
              {money(data.totals.remainingBudget, privateMode)}
            </strong>
          </div>
          <div>
            <span>家庭净结余</span>
            <strong>{money(data.totals.net, privateMode)}</strong>
          </div>
        </div>
      )}
      <section className="content-panel">
        <div className="content-panel-head">
          <div>
            <h3>分类预算</h3>
            <p>每个月独立设置，也可以复制上月预算。</p>
          </div>
          <button
            className="secondary-button"
            disabled={copy.isPending}
            onClick={() => copy.mutate()}
          >
            <RefreshCw size={15} /> 复制 {previousMonth}
          </button>
        </div>
        <div className="budget-editor">
          {meta.data?.categories
            .filter((x) => x.kind === "expense")
            .map((category) => {
              const actual =
                data?.budgets.find((x) => x.categoryId === category.id)
                  ?.actual || 0;
              const planned = amounts[category.id] || 0;
              const pct =
                planned > 0 ? Math.min(100, (actual / planned) * 100) : 0;
              return (
                <div className="budget-edit-row" key={category.id}>
                  <i style={{ background: category.color }} />
                  <div>
                    <strong>{category.name}</strong>
                    <span>已用 {money(actual, privateMode)}</span>
                    <div className="mini-progress">
                      <i
                        style={{ width: `${pct}%`, background: category.color }}
                      />
                    </div>
                  </div>
                  <label>
                    <span>预算</span>
                    <input
                      type="number"
                      min="0"
                      value={planned}
                      onChange={(e) =>
                        setAmounts({
                          ...amounts,
                          [category.id]: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              );
            })}
        </div>
        <div className="content-actions">
          <SubmitButton pending={save.isPending} children="保存本月预算" />
        </div>
      </section>
    </div>
  );
}

export function TransactionsPage({ privateMode }: { privateMode: boolean }) {
  const client = useQueryClient();
  const meta = useMeta();
  const [month, setMonth] = useState(currentMonth());
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["transactions", month],
    queryFn: () =>
      api.get<HouseholdTransaction[]>(`/household/transactions?month=${month}`),
  });
  const link = useMutation({
    mutationFn: (id: number) =>
      api.post(`/household/transactions/${id}/link-cash-flow`, {}),
    onSuccess: () => client.invalidateQueries({ queryKey: ["transactions"] }),
  });
  const archive = useMutation({
    mutationFn: (row: HouseholdTransaction) =>
      api.delete(
        `/household/transactions/${row.id}`,
        row.linked_cash_flow_id
          ? {
              linked_action: confirm(
                "这笔收支已关联资产资金流。确定：同步归档资金流；取消：解除关联后归档。",
              )
                ? "sync"
                : "unlink",
            }
          : undefined,
      ),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["transactions"] });
      client.invalidateQueries({ queryKey: ["budget"] });
    },
  });
  const rows = query.data || [];
  const income = rows
    .filter((x) => x.kind === "income")
    .reduce((s, x) => s + x.amount_cny, 0);
  const expense = rows
    .filter((x) => x.kind === "expense")
    .reduce((s, x) => s + x.amount_cny, 0);
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="Household ledger"
        title="实际收支"
        description="轻量记录家庭实际收入和支出，需要时再关联资产资金流。"
        action={
          <button className="primary-button" onClick={() => setOpen(true)}>
            <Plus size={16} /> 记一笔
          </button>
        }
      />
      <div className="summary-strip">
        <div>
          <span>本月收入</span>
          <strong className="positive">{money(income, privateMode)}</strong>
        </div>
        <div>
          <span>本月支出</span>
          <strong className="negative">{money(expense, privateMode)}</strong>
        </div>
        <div>
          <span>净结余</span>
          <strong>{money(income - expense, privateMode)}</strong>
        </div>
        <div>
          <span>记录数量</span>
          <strong>{rows.length}</strong>
        </div>
      </div>
      <div className="toolbar">
        <div className="month-control">
          <CalendarDays size={16} />
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <button className="filter-button">
          <ListFilter size={15} /> 全部分类
        </button>
      </div>
      <section className="content-panel no-padding">
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>类型</th>
                <th>分类</th>
                <th>账户 / 计划</th>
                <th>备注</th>
                <th>金额</th>
                <th>资产联动</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="日期">{row.occurred_on}</td>
                  <td data-label="类型">
                    <span className={`kind-badge ${row.kind}`}>
                      {row.kind === "income" ? (
                        <ArrowDownLeft size={13} />
                      ) : (
                        <ArrowUpRight size={13} />
                      )}{" "}
                      {row.kind === "income" ? "收入" : "支出"}
                    </span>
                  </td>
                  <td data-label="分类">
                    <span className="category-name">
                      <i style={{ background: row.category_color }} />
                      {row.category_name}
                    </span>
                  </td>
                  <td data-label="账户 / 计划">
                    <strong>{row.account_name || "未关联账户"}</strong>
                    <small>{row.project_name || ""}</small>
                  </td>
                  <td data-label="备注">{row.note || "—"}</td>
                  <td data-label="金额">
                    <strong
                      className={
                        row.kind === "income" ? "positive" : "negative"
                      }
                    >
                      {row.kind === "income" ? "+" : "-"}
                      {money(row.amount_cny, privateMode)}
                    </strong>
                  </td>
                  <td data-label="资产联动">
                    {row.linked_cash_flow_id ? (
                      <span className="status fresh">
                        <Link2 size={12} /> 已关联
                      </span>
                    ) : (
                      <button
                        className="link-button"
                        onClick={() => link.mutate(row.id)}
                      >
                        关联资金流
                      </button>
                    )}
                  </td>
                  <td>
                    <button
                      className="icon-text-button"
                      aria-label="归档收支记录"
                      onClick={() =>
                        confirm("归档这条收支记录？") && archive.mutate(row)
                      }
                    >
                      <Archive size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <EmptyState
            icon={<WalletCards />}
            title="这个月还没有收支记录"
            text="从一笔收入或支出开始。"
          />
        )}
      </section>
      {open && meta.data && (
        <TransactionForm
          meta={meta.data}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            client.invalidateQueries({ queryKey: ["transactions"] });
            client.invalidateQueries({ queryKey: ["budget"] });
            client.invalidateQueries({ queryKey: ["dashboard"] });
          }}
        />
      )}
    </div>
  );
}

function TransactionForm({
  meta,
  onClose,
  onSaved,
}: {
  meta: MetaData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<"income" | "expense">("expense");
  const mutation = useMutation({
    mutationFn: (body: unknown) => api.post("/household/transactions", body),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    mutation.mutate({
      kind,
      amount: Number(f.get("amount")),
      currency_id: Number(f.get("currency_id")),
      category_id: Number(f.get("category_id")),
      account_id: f.get("account_id") ? Number(f.get("account_id")) : null,
      occurred_on: f.get("occurred_on"),
      note: f.get("note"),
    });
  };
  return (
    <Modal title="记录家庭收支" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="kind-switch span-2">
          <button
            type="button"
            className={kind === "expense" ? "active expense" : ""}
            onClick={() => setKind("expense")}
          >
            <ArrowUpRight /> 支出
          </button>
          <button
            type="button"
            className={kind === "income" ? "active income" : ""}
            onClick={() => setKind("income")}
          >
            <ArrowDownLeft /> 收入
          </button>
        </div>
        <label>
          <span>金额</span>
          <input
            name="amount"
            type="number"
            min="0.01"
            step="any"
            required
            autoFocus
          />
        </label>
        <label>
          <span>币种</span>
          <select
            name="currency_id"
            defaultValue={meta.currencies.find((x) => x.code === "CNY")?.id}
          >
            {meta.currencies.map((x) => (
              <option value={x.id} key={x.id}>
                {x.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>分类</span>
          <select name="category_id" required>
            {meta.categories
              .filter((x) => x.kind === kind)
              .map((x) => (
                <option value={x.id} key={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>账户（可选）</span>
          <select name="account_id">
            <option value="">暂不关联</option>
            {meta.accounts.map((x) => (
              <option value={x.id} key={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>日期</span>
          <input
            name="occurred_on"
            type="date"
            defaultValue={today()}
            required
          />
        </label>
        <label>
          <span>备注</span>
          <input name="note" placeholder="例如：家庭采购" />
        </label>
        {mutation.error && (
          <p className="form-error span-2">{mutation.error.message}</p>
        )}
        <div className="form-actions span-2">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <SubmitButton pending={mutation.isPending} />
        </div>
      </form>
    </Modal>
  );
}

export function PlansPage({ privateMode }: { privateMode: boolean }) {
  const client = useQueryClient();
  const meta = useMeta();
  const [modal, setModal] = useState<"project" | "memo" | null>(null);
  const dashboard = useQuery({
    queryKey: ["dashboard-plans"],
    queryFn: () =>
      api.get<DashboardData>(`/dashboard?month=${currentMonth()}&range=1M`),
  });
  const projects = dashboard.data?.household.projects || [];
  const memos = dashboard.data?.household.memos || [];
  const calendarDays = Array.from({ length: 30 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index);
    const key = date.toISOString().slice(0, 10);
    return {
      key,
      day: date.getDate(),
      weekday: "日一二三四五六"[date.getDay()],
      memos: memos.filter((memo) => memo.due_date === key),
    };
  });
  const refreshPlans = () => {
    client.invalidateQueries({ queryKey: ["dashboard-plans"] });
    client.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const completeProject = useMutation({
    mutationFn: (id: number) =>
      api.patch(`/household/projects/${id}`, { status: "completed" }),
    onSuccess: refreshPlans,
  });
  const archiveProject = useMutation({
    mutationFn: (id: number) => api.delete(`/household/projects/${id}`),
    onSuccess: refreshPlans,
  });
  const completeMemo = useMutation({
    mutationFn: ({ memo, create }: { memo: FinancialMemo; create: boolean }) =>
      api.post(`/household/memos/${memo.id}/complete`, {
        create_transaction: create,
        category_id: memo.category_id || null,
        account_id: memo.account_id || null,
      }),
    onSuccess: refreshPlans,
  });
  const archiveMemo = useMutation({
    mutationFn: (id: number) => api.delete(`/household/memos/${id}`),
    onSuccess: refreshPlans,
  });
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="Family planning"
        title="计划与提醒"
        description="把跨月目标和未来大额事项放在同一处，临近与逾期一眼可见。"
        action={
          <div className="button-row">
            <button
              className="secondary-button"
              onClick={() => setModal("memo")}
            >
              <Bell size={15} /> 新建备忘
            </button>
            <button
              className="primary-button"
              onClick={() => setModal("project")}
            >
              <Plus size={16} /> 新建专项
            </button>
          </div>
        }
      />
      <section className="content-panel reminder-calendar">
        <div className="content-panel-head">
          <div>
            <h3>未来 30 天日历</h3>
            <p>按预计日期查看大额收入与支出。</p>
          </div>
          <CalendarDays size={20} />
        </div>
        <div className="calendar-strip">
          {calendarDays.map((day) => (
            <div className={day.memos.length ? "has-event" : ""} key={day.key}>
              <span>周{day.weekday}</span>
              <strong>{day.day}</strong>
              {day.memos.slice(0, 2).map((memo) => (
                <i className={memo.kind} title={memo.title} key={memo.id} />
              ))}
            </div>
          ))}
        </div>
      </section>
      <div className="plans-layout">
        <section className="content-panel">
          <div className="content-panel-head">
            <div>
              <h3>家庭专项计划</h3>
              <p>旅行、装修、教育等跨月目标</p>
            </div>
            <Target size={20} />
          </div>
          <div className="project-grid">
            {projects.map((project) => (
              <article className="project-card" key={project.id}>
                <div>
                  <span className={`project-status ${project.status}`}>
                    {
                      (
                        {
                          planned: "计划中",
                          active: "进行中",
                          completed: "已完成",
                          cancelled: "已取消",
                        } as Record<string, string>
                      )[project.status]
                    }
                  </span>
                  <FolderKanban size={18} />
                </div>
                <h4>{project.name}</h4>
                <p>{project.note || "共同为这个目标做好准备。"}</p>
                <div className="project-money">
                  <strong>{money(project.spent_cny, privateMode)}</strong>
                  <span>/ {money(project.target_amount_cny, privateMode)}</span>
                </div>
                <div className="mini-progress large">
                  <i style={{ width: `${Math.min(100, project.progress)}%` }} />
                </div>
                <footer>
                  <span>{project.progress.toFixed(0)}% 完成</span>
                  <span>{project.end_date || "未设截止日"}</span>
                </footer>
                <div className="card-actions">
                  {project.status !== "completed" && (
                    <button onClick={() => completeProject.mutate(project.id)}>
                      标记完成
                    </button>
                  )}
                  <button
                    onClick={() =>
                      confirm("归档这个专项计划？") &&
                      archiveProject.mutate(project.id)
                    }
                  >
                    归档
                  </button>
                </div>
              </article>
            ))}
            {!projects.length && (
              <EmptyState
                icon={<Target />}
                title="还没有专项计划"
                text="为旅行、装修或教育建立一个跨月目标。"
              />
            )}
          </div>
        </section>
        <section className="content-panel">
          <div className="content-panel-head">
            <div>
              <h3>大额收支备忘</h3>
              <p>未来 30 天站内提醒</p>
            </div>
            <Bell size={20} />
          </div>
          <div className="large-memo-list">
            {memos.map((memo) => (
              <article className={memo.display_status} key={memo.id}>
                <div className="timeline-marker">
                  <i />
                </div>
                <div>
                  <span>
                    {memo.due_date} ·{" "}
                    {memo.display_status === "overdue"
                      ? "已逾期"
                      : memo.days_until === 0
                        ? "今天"
                        : `${memo.days_until} 天后`}
                  </span>
                  <strong>{memo.title}</strong>
                  <p>{memo.note || "到期前会在总览中提醒。"}</p>
                  <div className="card-actions">
                    <button
                      onClick={() =>
                        completeMemo.mutate({
                          memo,
                          create:
                            Boolean(memo.category_id) &&
                            confirm("是否同时生成一条实际家庭收支？"),
                        })
                      }
                    >
                      完成
                    </button>
                    <button
                      onClick={() =>
                        confirm("取消并归档这个备忘？") &&
                        archiveMemo.mutate(memo.id)
                      }
                    >
                      归档
                    </button>
                  </div>
                </div>
                <b className={memo.kind === "income" ? "positive" : "negative"}>
                  {memo.kind === "income" ? "+" : "-"}
                  {money(memo.expected_amount, privateMode)}
                </b>
              </article>
            ))}
            {!memos.length && (
              <EmptyState
                icon={<Clock3 />}
                title="近期没有大额事项"
                text="新建备忘后会在到期前提醒。"
              />
            )}
          </div>
        </section>
      </div>
      {modal && meta.data && (
        <PlanForm
          kind={modal}
          meta={meta.data}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            client.invalidateQueries({ queryKey: ["dashboard-plans"] });
            client.invalidateQueries({ queryKey: ["dashboard"] });
          }}
        />
      )}
    </div>
  );
}

function PlanForm({
  kind,
  meta,
  onClose,
  onSaved,
}: {
  kind: "project" | "memo";
  meta: MetaData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [memoKind, setMemoKind] = useState<"income" | "expense">("expense");
  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      api.post(
        kind === "project" ? "/household/projects" : "/household/memos",
        body,
      ),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    mutation.mutate(
      kind === "project"
        ? {
            name: f.get("name"),
            target_amount_cny: Number(f.get("amount")),
            start_date: f.get("start_date") || null,
            end_date: f.get("end_date") || null,
            status: "active",
            note: f.get("note"),
          }
        : {
            kind: memoKind,
            title: f.get("name"),
            expected_amount: Number(f.get("amount")),
            currency_id: Number(f.get("currency_id")),
            due_date: f.get("due_date"),
            reminder_days: Number(f.get("reminder_days")),
            account_id: f.get("account_id")
              ? Number(f.get("account_id"))
              : null,
            category_id: f.get("category_id")
              ? Number(f.get("category_id"))
              : null,
            status: "pending",
            note: f.get("note"),
          },
    );
  };
  return (
    <Modal
      title={kind === "project" ? "新建专项计划" : "新建大额备忘"}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={submit}>
        {kind === "memo" && (
          <label className="span-2">
            <span>类型</span>
            <select
              name="memo_kind"
              value={memoKind}
              onChange={(event) =>
                setMemoKind(event.target.value as "income" | "expense")
              }
            >
              <option value="expense">预计支出</option>
              <option value="income">预计收入</option>
            </select>
          </label>
        )}
        <label>
          <span>{kind === "project" ? "计划名称" : "事项标题"}</span>
          <input name="name" required autoFocus />
        </label>
        <label>
          <span>{kind === "project" ? "目标金额" : "预计金额"}</span>
          <input name="amount" type="number" min="0" step="any" required />
        </label>
        {kind === "project" ? (
          <>
            <label>
              <span>开始日期</span>
              <input name="start_date" type="date" defaultValue={today()} />
            </label>
            <label>
              <span>结束日期</span>
              <input name="end_date" type="date" />
            </label>
          </>
        ) : (
          <>
            <label>
              <span>币种</span>
              <select
                name="currency_id"
                defaultValue={meta.currencies.find((x) => x.code === "CNY")?.id}
              >
                {meta.currencies.map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>预计日期</span>
              <input name="due_date" type="date" required />
            </label>
            <label>
              <span>分类</span>
              <select name="category_id">
                <option value="">暂不设置</option>
                {meta.categories
                  .filter((item) => item.kind === memoKind)
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>提前提醒</span>
              <select name="reminder_days" defaultValue="7">
                <option value="1">1 天</option>
                <option value="3">3 天</option>
                <option value="7">7 天</option>
                <option value="14">14 天</option>
                <option value="30">30 天</option>
              </select>
            </label>
            <label>
              <span>关联账户</span>
              <select name="account_id">
                <option value="">暂不关联</option>
                {meta.accounts.map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="span-2">
          <span>备注</span>
          <textarea name="note" rows={3} />
        </label>
        {mutation.error && (
          <p className="form-error span-2">{mutation.error.message}</p>
        )}
        <div className="form-actions span-2">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <SubmitButton pending={mutation.isPending} />
        </div>
      </form>
    </Modal>
  );
}

export function AccountsPage({ privateMode }: { privateMode: boolean }) {
  const client = useQueryClient();
  const meta = useMeta();
  const query = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<any[]>("/accounts"),
  });
  const [open, setOpen] = useState(false);
  const accountLabels: Record<string, string> = {
    investment: "投资账户",
    bank: "银行账户",
    e_wallet: "电子钱包",
    cash: "现金账户",
    credit: "信用账户",
    other: "其他账户",
  };
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="Unified accounts"
        title="家庭账户"
        description="资产平台和家庭收支账户使用同一套账户体系。"
        action={
          <button className="primary-button" onClick={() => setOpen(true)}>
            <Plus size={16} /> 添加账户
          </button>
        }
      />
      <div className="account-card-grid">
        {query.data?.map((account) => (
          <article className="account-card" key={account.id}>
            <div className={`account-card-icon type-${account.account_type}`}>
              <Landmark />
            </div>
            <div>
              <span>{accountLabels[account.account_type] || "其他账户"}</span>
              <h3>{account.name}</h3>
              <p>
                {account.currency_code || "未设默认币种"} ·{" "}
                {account.asset_count} 项资产
              </p>
            </div>
            <strong>{money(account.market_value_cny, privateMode)}</strong>
          </article>
        ))}
      </div>
      {!query.data?.length && (
        <EmptyState
          icon={<CircleDollarSign />}
          title="还没有账户"
          text="添加银行、投资、钱包或现金账户。"
        />
      )}
      {open && meta.data && (
        <AccountForm
          meta={meta.data}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            client.invalidateQueries({ queryKey: ["accounts"] });
            client.invalidateQueries({ queryKey: ["meta"] });
          }}
        />
      )}
    </div>
  );
}

function AccountForm({
  meta,
  onClose,
  onSaved,
}: {
  meta: MetaData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (body: unknown) => api.post("/accounts", body),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    mutation.mutate({
      name: f.get("name"),
      account_type: f.get("account_type"),
      default_currency_id: Number(f.get("default_currency_id")),
      category:
        f.get("account_type") === "investment"
          ? "投资类"
          : f.get("account_type") === "other"
            ? "其他"
            : "现金类",
    });
  };
  return (
    <Modal title="添加家庭账户" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="span-2">
          <span>账户名称</span>
          <input
            name="name"
            required
            autoFocus
            placeholder="例如：家庭日常银行卡"
          />
        </label>
        <label>
          <span>账户类型</span>
          <select name="account_type">
            {meta.accountTypes.map((x) => (
              <option value={x.code} key={x.code}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>默认币种</span>
          <select
            name="default_currency_id"
            defaultValue={meta.currencies.find((x) => x.code === "CNY")?.id}
          >
            {meta.currencies.map((x) => (
              <option value={x.id} key={x.id}>
                {x.code}
              </option>
            ))}
          </select>
        </label>
        {mutation.error && (
          <p className="form-error span-2">{mutation.error.message}</p>
        )}
        <div className="form-actions span-2">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <SubmitButton pending={mutation.isPending} />
        </div>
      </form>
    </Modal>
  );
}

export function StatusPage() {
  const client = useQueryClient();
  const market = useQuery({
    queryKey: ["market-status"],
    queryFn: () => api.get<any>("/market/status"),
    refetchInterval: 4000,
  });
  const t212 = useQuery({
    queryKey: ["t212-status"],
    queryFn: () => api.get<any>("/integrations/trading212/status"),
  });
  const refresh = useMutation({
    mutationFn: () => api.post("/market/refresh"),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["market-status"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const syncT212 = useMutation({
    mutationFn: () => api.post("/integrations/trading212/sync"),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["t212-status"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      client.invalidateQueries({ queryKey: ["assets"] });
    },
  });
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="Data operations"
        title="数据状态"
        description="行情、汇率与外部账户同步的健康状态。"
        action={
          <button
            className="primary-button"
            disabled={market.data?.state === "running"}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw
              className={market.data?.state === "running" ? "spin" : ""}
              size={16}
            />{" "}
            {market.data?.state === "running" ? "正在更新" : "刷新行情"}
          </button>
        }
      />
      <div className="status-grid">
        <article className="status-card">
          <div className="status-icon healthy">
            <ShieldCheck />
          </div>
          <div>
            <span>Stone Wealth 数据库</span>
            <h3>运行正常</h3>
            <p>迁移已应用，业务数据保存在本地 SQLite。</p>
          </div>
          <b className="status fresh">正常</b>
        </article>
        <article className="status-card">
          <div
            className={`status-icon ${market.data?.state === "error" ? "warning" : "healthy"}`}
          >
            <RefreshCw />
          </div>
          <div>
            <span>市场行情与汇率</span>
            <h3>
              {market.data?.state === "running"
                ? "正在同步"
                : market.data?.state === "error"
                  ? "部分异常"
                  : "缓存可用"}
            </h3>
            <p>
              {market.data?.finishedAt
                ? `最近完成 ${new Date(market.data.finishedAt).toLocaleString("zh-CN")}`
                : "后台每 30 分钟更新资产价格。"}
            </p>
          </div>
          <b
            className={`status ${market.data?.state === "error" ? "error" : "fresh"}`}
          >
            {market.data?.updated || 0} 成功 / {market.data?.failed || 0} 失败
          </b>
        </article>
        <article className="status-card">
          <div
            className={`status-icon ${t212.data?.configured ? "healthy" : "neutral"}`}
          >
            <Landmark />
          </div>
          <div>
            <span>Trading212</span>
            <h3>{t212.data?.configured ? "凭据已配置" : "等待配置"}</h3>
            <p>
              {t212.data?.aggregateFallback
                ? "当前保留账户总值作为待分类资产，详细同步成功后再归档。"
                : "未检测到账户汇总记录。"}
            </p>
            {t212.data?.configured && (
              <button
                className="secondary-button compact-button"
                disabled={syncT212.isPending}
                onClick={() => syncT212.mutate()}
              >
                {syncT212.isPending ? "正在对账" : "同步并对账"}
              </button>
            )}
          </div>
          <b
            className={`status ${t212.data?.configured ? "fresh" : "missing"}`}
          >
            {t212.data?.detailedSyncAvailable ? "可同步" : "未连接"}
          </b>
        </article>
      </div>
      <section className="content-panel">
        <div className="content-panel-head">
          <div>
            <h3>分类与对账规则</h3>
            <p>外部数据无法确认时，不会被错误计入现金。</p>
          </div>
          <Sparkles size={20} />
        </div>
        <div className="rule-list">
          <div>
            <Check />
            现金余额进入“现金与现金等价物”
          </div>
          <div>
            <Check />
            ETF 进入“基金”，股票按市场进入“股票”
          </div>
          <div>
            <AlertCircle />
            无法识别的项目进入“待分类”，仍计入总资产
          </div>
          <div>
            <AlertCircle />
            账户总值仅用于对账，不作为持仓重复计入
          </div>
        </div>
      </section>
    </div>
  );
}
