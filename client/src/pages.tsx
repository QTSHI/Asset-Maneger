import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
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
  Trash2,
  WalletCards,
  X,
} from "lucide-react";
import { api } from "./api";
import { parseAccountHierarchy, platformName } from "./accountHierarchy";
import { consolidateInstruments } from "./instrumentConsolidation";
import {
  currentMonth,
  MonthNavigator,
  monthLabel,
  shiftMonth,
  today,
} from "./dateControls";
import type {
  DashboardData,
  FinancialMemo,
  HouseholdPlan,
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
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedInstrument, setSelectedInstrument] = useState<string | null>(null);

  const filtered = (assets.data || []).filter((asset) =>
    `${asset.name} ${asset.code} ${asset.accountName}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        assets: ValuedAsset[];
        value: number;
        cost: number;
        profit: number;
      }
    >();
    for (const asset of filtered) {
      const key = view === "class" ? asset.classCode : platformName(asset.accountName);
      const label = view === "class" ? asset.classLabel : platformName(asset.accountName);
      const item = map.get(key) || {
        key,
        label,
        assets: [],
        value: 0,
        cost: 0,
        profit: 0,
      };
      item.assets.push(asset);
      item.value += asset.marketValueCny;
      item.cost += asset.costValueCny;
      item.profit += asset.profitCny;
      map.set(key, item);
    }
    const classOrder = ["cash", "fund", "stock", "alternative", "unclassified"];
    if (view === "class" && !query) {
      const labels: Record<string, string> = {
        cash: "现金与现金等价物",
        fund: "基金",
        stock: "股票",
        alternative: "另类资产",
      };
      for (const key of classOrder.slice(0, 4)) {
        if (!map.has(key)) {
          map.set(key, { key, label: labels[key], assets: [], value: 0, cost: 0, profit: 0 });
        }
      }
    }
    return [...map.values()].sort((a, b) =>
      view === "class"
        ? classOrder.indexOf(a.key) - classOrder.indexOf(b.key)
        : b.value - a.value,
    );
  }, [filtered, view, query]);
  const selected = groups.find((group) => group.key === selectedGroup);
  const consolidatedFunds = useMemo(
    () => consolidateInstruments(selected?.key === "fund" ? selected.assets : []),
    [selected],
  );
  const selectedFund = consolidatedFunds.find(
    (instrument) => instrument.key === selectedInstrument,
  );

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
        description="先看资产类别，再按平台、子账户或购买渠道进入具体持仓。"
        action={
          <button className="primary-button" onClick={() => setEditing("new")}>
            <Plus size={16} /> 添加资产
          </button>
        }
      />
      <div className="account-hierarchy-guide" aria-label="资产账户层级">
        <div><b>1</b><span>平台</span><strong>支付宝、Trading212</strong></div>
        <ChevronRight size={16} />
        <div><b>2</b><span>子账户 / 购买渠道</span><strong>基金、余额宝、主账户</strong></div>
        <ChevronRight size={16} />
        <div><b>3</b><span>持仓</span><strong>具体基金、股票或现金</strong></div>
      </div>
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
          <span>数据需关注</span>
          <strong>
            {filtered.filter((x) => x.dataQuality.status !== "ready").length}
          </strong>
        </div>
      </div>
      <div className="toolbar">
        <div className="segmented">
          <button
            className={view === "class" ? "active" : ""}
            onClick={() => {
              setView("class");
              setSelectedGroup(null);
            }}
          >
            按资产类别
          </button>
          <button
            className={view === "account" ? "active" : ""}
            onClick={() => {
              setView("account");
              setSelectedGroup(null);
            }}
          >
            按平台
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
      <div className={`overview-card-grid ${view === "class" ? "four-columns" : ""}`}>
        {groups.filter((group) => view !== "class" || group.key !== "unclassified").map((group) => {
          const showProfit = view === "class" && ["fund", "stock"].includes(group.key);
          const profitPercent = group.cost ? (group.profit / group.cost) * 100 : 0;
          return (
            <button
              className={`overview-card ${selectedGroup === group.key ? "selected" : ""}`}
              key={group.key}
              onClick={() => {
                setSelectedGroup(group.key);
                setSelectedInstrument(null);
              }}
            >
              <span className={`asset-dot asset-${group.key}`} />
              <span>{group.label}</span>
              <strong>{money(group.value, privateMode)}</strong>
              <small>
                {group.assets.length} 项 · {total ? ((group.value / total) * 100).toFixed(1) : 0}%
              </small>
              {showProfit && (
                <em className={group.profit >= 0 ? "positive" : "negative"}>
                  持有盈亏 {money(group.profit, privateMode)} · {profitPercent.toFixed(1)}%
                </em>
              )}
              <ChevronRight size={17} />
            </button>
          );
        })}
      </div>
      {view === "class" && groups.some((group) => group.key === "unclassified") && (() => {
        const group = groups.find((item) => item.key === "unclassified")!;
        return (
          <button
            className={`unclassified-overview ${selectedGroup === group.key ? "selected" : ""}`}
            onClick={() => {
              setSelectedGroup(group.key);
              setSelectedInstrument(null);
            }}
          >
            <AlertCircle size={18} />
            <div>
              <strong>待分类资产</strong>
              <span>{group.assets.length} 项资产，需要进一步确认类别</span>
            </div>
            <b>{money(group.value, privateMode)}</b>
            <ChevronRight size={17} />
          </button>
        );
      })()}
      {selected && (
        <section className="asset-group selected-detail">
          <div className="detail-head">
            <div>
              <span>{view === "class" ? "资产类别" : "平台"}</span>
              <h3>{selected.label}</h3>
              <p>{selected.assets.length} 项资产 · {money(selected.value, privateMode)}</p>
            </div>
            <button className="secondary-button" onClick={() => {
              setSelectedGroup(null);
              setSelectedInstrument(null);
            }}>
              收起明细
            </button>
          </div>
          {selected.key === "fund" && (
            <div className="fund-consolidated-section">
              <div className="subsection-head">
                <div>
                  <strong>同一基金合并总览</strong>
                  <span>{consolidatedFunds.length} 只基金 · 点击后查看各平台持仓</span>
                </div>
              </div>
              <div className="responsive-table fund-consolidated-table">
                <table>
                  <thead>
                    <tr><th>基金</th><th>平台</th><th>合并市值</th><th>合并盈亏</th><th /></tr>
                  </thead>
                  <tbody>
                    {consolidatedFunds.map((instrument) => (
                      <tr className={selectedInstrument === instrument.key ? "selected-row" : ""} key={instrument.key}>
                        <td data-label="基金"><strong>{instrument.name}</strong><small>{instrument.code}</small></td>
                        <td data-label="平台">{instrument.platformNames.join("、")}<small>{instrument.assets.length} 笔持仓</small></td>
                        <td data-label="合并市值"><strong>{money(instrument.marketValueCny, privateMode)}</strong></td>
                        <td data-label="合并盈亏">
                          <span className={instrument.profitCny >= 0 ? "positive" : "negative"}>
                            {money(instrument.profitCny, privateMode)}<small>{instrument.profitPercent.toFixed(1)}%</small>
                          </span>
                        </td>
                        <td data-label="操作">
                          <button
                            className="instrument-detail-button"
                            onClick={() => setSelectedInstrument(
                              selectedInstrument === instrument.key ? null : instrument.key,
                            )}
                          >
                            {selectedInstrument === instrument.key ? "收起" : "查看持仓"}<ChevronRight size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {(selected.key !== "fund" || selectedFund) && (
          <div className="responsive-table position-detail-table">
            <table>
              <thead>
                <tr>
                  <th>资产</th>
                  <th>子账户 / 渠道</th>
                  <th>类型</th>
                  <th>单位现价</th>
                  <th>市值</th>
                  <th>盈亏</th>
                  <th>行情</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(selected.key === "fund" ? selectedFund?.assets || [] : selected.assets).map((asset) => (
                  <tr key={asset.id}>
                    <td data-label="资产">
                      <strong>{asset.name}</strong>
                      <small>{asset.code} · {asset.currency}</small>
                      {asset.dataQuality.status !== "ready" && (
                        <span className={`quality-tag ${asset.dataQuality.status}`}>
                          {asset.dataQuality.label}
                        </span>
                      )}
                    </td>
                    <td data-label="子账户 / 渠道">
                      {parseAccountHierarchy(asset.accountName).channelName}
                      <small>{parseAccountHierarchy(asset.accountName).platformName}</small>
                    </td>
                    <td data-label="类型"><span className="tag">{asset.subtypeLabel}</span></td>
                    <td data-label="单位现价">
                      {asset.currentPrice == null ? (
                        <span className="muted-value">—</span>
                      ) : (
                        asset.currentPrice.toLocaleString("zh-CN", { maximumFractionDigits: 6 })
                      )}
                      {asset.valuationBasis === "imported_position" && (
                        <small>Trading212 API 汇总备用值</small>
                      )}
                    </td>
                    <td data-label="市值">
                      {asset.valuationBasis === "reference_only" ? (
                        <>
                          <strong className="muted-value">不计入实时总额</strong>
                          <small>
                            {asset.importedMarketValue == null
                              ? "等待补充代码、数量或行情"
                              : `历史参考 ${asset.currency} ${asset.importedMarketValue.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${asset.valuationAsOf ? ` · ${asset.valuationAsOf}` : ""}`}
                          </small>
                        </>
                      ) : (
                        <strong>{money(asset.marketValueCny, privateMode)}</strong>
                      )}
                    </td>
                    <td data-label="盈亏">
                      <span className={asset.profitCny >= 0 ? "positive" : "negative"}>
                        {money(asset.profitCny, privateMode)}
                        <small>{asset.profitPercent.toFixed(1)}%</small>
                      </span>
                    </td>
                    <td data-label="行情">
                      <span className={`status ${asset.quote.status}`}>
                        {{
                          fresh: "已更新",
                          static: "静态导入",
                          missing: "待更新",
                          stale: "已过期",
                          error: "更新失败",
                        }[asset.quote.status] || "待确认"}
                      </span>
                    </td>
                    <td data-label="操作">
                      <div className="row-actions">
                        <button onClick={() => setEditing(asset)} aria-label={`修改 ${asset.name}`}><Edit3 size={15} /></button>
                        <button
                          onClick={() => confirm(`删除 ${asset.name}？删除后将从当前统计中移除。`) && archive.mutate(asset.id)}
                          aria-label={`删除 ${asset.name}`}
                        ><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </section>
      )}
      <div className="group-list">
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
      quote_code: form.get("quote_code") || null,
      name: form.get("name"),
      shares: Number(form.get("shares")),
      cost_price: Number(form.get("cost_price")),
      quantity_status: form.get("quantity_status"),
      valuation_mode: form.get("valuation_mode"),
      imported_market_value: form.get("imported_market_value")
        ? Number(form.get("imported_market_value"))
        : null,
      imported_cost_value: form.get("imported_cost_value")
        ? Number(form.get("imported_cost_value"))
        : null,
      valuation_as_of: form.get("valuation_as_of") || null,
    });
  };
  return (
    <Modal title={asset ? "编辑资产" : "添加资产"} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label>
          <span>内部资产编号</span>
          <input name="code" defaultValue={asset?.code} required />
        </label>
        <label>
          <span>行情代码</span>
          <input
            name="quote_code"
            defaultValue={asset?.quoteCode || ""}
            placeholder="例如 000218 或 000029"
          />
        </label>
        <label>
          <span>名称</span>
          <input name="name" defaultValue={asset?.name} />
        </label>
        <label>
          <span>子账户 / 购买渠道</span>
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
          <span>份额可信度</span>
          <select name="quantity_status" defaultValue={asset?.quantityStatus || "verified"}>
            <option value="verified">已确认</option>
            <option value="estimated">根据历史估值推算</option>
            <option value="missing">尚未提供</option>
          </select>
        </label>
        <label>
          <span>当前估值规则</span>
          <div className="form-readonly-value">API 最新价格 × 份额 / 数量</div>
          <input type="hidden" name="valuation_mode" value="units" />
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
        <label>
          <span>导入时市值（历史参考）</span>
          <input
            name="imported_market_value"
            type="number"
            min="0"
            step="any"
            defaultValue={asset?.importedMarketValue ?? ""}
          />
        </label>
        <label>
          <span>导入时成本（历史参考）</span>
          <input
            name="imported_cost_value"
            type="number"
            min="0"
            step="any"
            defaultValue={asset?.importedCostValue ?? ""}
          />
        </label>
        <label>
          <span>历史参考日期</span>
          <input name="valuation_as_of" type="date" defaultValue={asset?.valuationAsOf || ""} />
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
  const [showAllCategories, setShowAllCategories] = useState(false);
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
  const previousMonth = shiftMonth(month, -1);
  const copy = useMutation({
    mutationFn: () =>
      api.post("/household/budgets/copy", {
        fromMonth: previousMonth,
        toMonth: month,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["budget", month] }),
  });
  const data = query.data;
  const expenseCategories = (meta.data?.categories || []).filter(
    (category) => category.kind === "expense",
  );
  const commonCategoryNames = new Set([
    "家庭生活费",
    "旅行",
    "人情往来",
    "其他支出",
  ]);
  const visibleExpenseCategories = showAllCategories
    ? expenseCategories
    : expenseCategories.filter((category) => {
        const budget = data?.budgets.find(
          (item) => item.categoryId === category.id,
        );
        return (
          commonCategoryNames.has(category.name) ||
          Number(budget?.planned || 0) > 0 ||
          Number(budget?.actual || 0) > 0
        );
      });
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="Household budget"
        title="家庭预算"
        description="按月安排家庭开支，实际收支独立记录，不自动影响资产。"
        action={
          <MonthNavigator month={month} onChange={setMonth} label="预算月份" />
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
      {data && data.totals.plannedExpense === 0 && data.navigation.nextPlannedMonth && (
        <div className="next-plan-notice">
          <div>
            <CalendarDays size={18} />
            <span>
              {monthLabel(month)}没有设置预算，最近的计划从
              <strong>{monthLabel(data.navigation.nextPlannedMonth)}</strong>开始。
            </span>
          </div>
          <button
            className="secondary-button"
            onClick={() => setMonth(data.navigation.nextPlannedMonth!)}
          >
            查看下一计划月 <ChevronRight size={15} />
          </button>
        </div>
      )}
      {meta.data && <HouseholdPlanSection meta={meta.data} privateMode={privateMode} />}
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
        <div className="budget-category-mode">
          <span>
            默认显示家庭常用分类；已有预算或实际支出的分类会自动保留。
          </span>
          <button
            className="text-button"
            onClick={() => setShowAllCategories((value) => !value)}
          >
            {showAllCategories
              ? "收起可选分类"
              : `显示全部分类（${expenseCategories.length}）`}
          </button>
        </div>
        <div className="budget-editor">
          {visibleExpenseCategories.map((category) => {
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
          <SubmitButton pending={save.isPending} children="保存该月预算" />
        </div>
      </section>
    </div>
  );
}

function HouseholdPlanSection({
  meta,
  privateMode,
}: {
  meta: MetaData;
  privateMode: boolean;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["household-plan"],
    queryFn: () => api.get<HouseholdPlan>("/household/plan"),
  });
  const [settings, setSettings] = useState<HouseholdPlan["settings"] | null>(null);
  useEffect(() => {
    if (query.data) setSettings(query.data.settings);
  }, [query.data]);
  const save = useMutation({
    mutationFn: () => api.put("/household/plan/settings", {
      opening_amount: settings?.openingAmount || 0,
      opening_currency_id: settings?.openingCurrencyId,
      planning_rate_to_cny: settings?.planningRateToCny || 1,
      start_month: settings?.startMonth,
      end_month: settings?.endMonth,
    }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["household-plan"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const plan = query.data;
  if (!plan || !settings) return null;
  return (
    <section className="content-panel household-plan-panel">
      <div className="content-panel-head">
        <div>
          <h3>跨月家庭资金规划</h3>
          <p>把起始家庭资金、月度预算和待处理大额事项放在同一条时间线上。</p>
        </div>
        <CalendarDays size={20} />
      </div>
      <div className="plan-settings-grid">
        <label>
          <span>起始资金</span>
          <input
            type="number"
            min="0"
            step="any"
            value={settings.openingAmount}
            onChange={(event) => setSettings({ ...settings, openingAmount: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>资金币种</span>
          <select
            value={settings.openingCurrencyId}
            onChange={(event) => setSettings({ ...settings, openingCurrencyId: Number(event.target.value) })}
          >
            {meta.currencies.map((currency) => <option key={currency.id} value={currency.id}>{currency.code}</option>)}
          </select>
        </label>
        <label>
          <span>规划汇率（兑 CNY）</span>
          <input
            type="number"
            min="0.000001"
            step="any"
            value={settings.planningRateToCny}
            onChange={(event) => setSettings({ ...settings, planningRateToCny: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>开始月份</span>
          <input type="month" value={settings.startMonth} onChange={(event) => setSettings({ ...settings, startMonth: event.target.value })} />
        </label>
        <label>
          <span>结束月份</span>
          <input type="month" value={settings.endMonth} onChange={(event) => setSettings({ ...settings, endMonth: event.target.value })} />
        </label>
        <button className="secondary-button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "保存中" : "更新规划"}
        </button>
      </div>
      <div className="plan-summary-grid">
        <div><span>起始家庭资金</span><strong>{money(plan.totals.openingBalanceCny, privateMode)}</strong></div>
        <div><span>月度预算合计</span><strong>{money(plan.totals.plannedExpenseCny, privateMode)}</strong></div>
        <div><span>待处理大额支出</span><strong>{money(plan.totals.memoExpenseCny, privateMode)}</strong></div>
        <div className={plan.totals.projectedClosingBalanceCny < 0 ? "negative" : "positive"}>
          <span>计划结束预计剩余</span><strong>{money(plan.totals.projectedClosingBalanceCny, privateMode)}</strong>
        </div>
      </div>
      {plan.livingExpenseBasis && (
        <div className="living-expense-basis">
          <div>
            <span>生活费正式口径</span>
            <strong>{money(plan.livingExpenseBasis.monthlyAmountCny, privateMode)} / 月</strong>
          </div>
          <p>
            以人民币预算为准；按当前规划汇率 {plan.settings.planningRateToCny} 折算，约为{" "}
            {plan.livingExpenseBasis.openingCurrencyCode}{" "}
            {privateMode ? "••••" : plan.livingExpenseBasis.monthlyAmountInOpeningCurrency.toFixed(2)} / 月。
            规划期内共 {plan.livingExpenseBasis.plannedMonths} 个月，金额来自“
            {plan.livingExpenseBasis.categoryName}”月度预算。
          </p>
        </div>
      )}
      {plan.totals.firstNegativeMonth && (
        <div className="plan-warning"><AlertCircle size={16} />预计在 {monthLabel(plan.totals.firstNegativeMonth)} 出现资金缺口</div>
      )}
      <div className="responsive-table plan-table">
        <table>
          <thead><tr><th>月份</th><th>月度预算</th><th>大额事项</th><th>预计净变化</th><th>预计月末余额</th></tr></thead>
          <tbody>
            {plan.months.map((row) => (
              <tr key={row.month}>
                <td data-label="月份"><strong>{monthLabel(row.month)}</strong><small>{row.status === "actual" ? "实际" : row.status === "current" ? "本月" : "计划"}</small></td>
                <td data-label="月度预算">{money(row.plannedExpenseCny, privateMode)}</td>
                <td data-label="大额事项">{money(row.memoExpenseCny, privateMode)}</td>
                <td data-label="预计净变化"><span className={row.projectedNetCny >= 0 ? "positive" : "negative"}>{money(row.projectedNetCny, privateMode)}</span></td>
                <td data-label="预计月末余额"><strong>{money(row.closingBalanceCny, privateMode)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function TransactionsPage({ privateMode }: { privateMode: boolean }) {
  const client = useQueryClient();
  const meta = useMeta();
  const [month, setMonth] = useState(currentMonth());
  const [editing, setEditing] = useState<HouseholdTransaction | "new" | null>(null);
  const [deleting, setDeleting] = useState<HouseholdTransaction | null>(null);
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
    mutationFn: ({
      row,
      linkedAction,
    }: {
      row: HouseholdTransaction;
      linkedAction?: "sync" | "unlink";
    }) =>
      api.delete(
        `/household/transactions/${row.id}`,
        row.linked_cash_flow_id ? { linked_action: linkedAction } : undefined,
      ),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["transactions"] }),
        client.invalidateQueries({ queryKey: ["budget"] }),
        client.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      setDeleting(null);
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
          <button className="primary-button" onClick={() => setEditing("new")}>
            <Plus size={16} /> 记一笔
          </button>
        }
      />
      <div className="summary-strip">
        <div>
          <span>该月收入</span>
          <strong className="positive">{money(income, privateMode)}</strong>
        </div>
        <div>
          <span>该月支出</span>
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
        <MonthNavigator month={month} onChange={setMonth} label="收支月份" />
        <button className="filter-button">
          <ListFilter size={15} /> 全部分类
        </button>
      </div>
      <div className="cash-flow-explainer">
        <Link2 size={18} />
        <div>
          <strong>资产联动是什么？</strong>
          <p>
            普通收支只进入家庭预算；联动后会在所选账户生成同金额的入金或出金记录，用于区分“投资涨跌”和“家庭资金进出”。它不会自动修改持仓数量或行情价格。
          </p>
        </div>
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
                        disabled={!row.account_id}
                        title={row.account_id ? "在该账户生成对应的入金或出金记录" : "请先修改这笔记录并选择账户"}
                        onClick={() => link.mutate(row.id)}
                      >
                        {row.account_id ? "同步到账户资金流" : "先选择账户"}
                      </button>
                    )}
                  </td>
                  <td data-label="操作">
                    <div className="record-actions">
                      <button onClick={() => setEditing(row)}>
                        <Edit3 size={13} /> 修改
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setDeleting(row)}
                      >
                        <Trash2 size={13} /> 删除
                      </button>
                    </div>
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
      {editing && meta.data && (
        <TransactionForm
          meta={meta.data}
          initialMonth={month}
          transaction={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            client.invalidateQueries({ queryKey: ["transactions"] });
            client.invalidateQueries({ queryKey: ["budget"] });
            client.invalidateQueries({ queryKey: ["dashboard"] });
          }}
        />
      )}
      {deleting && (
        <DeleteTransactionDialog
          transaction={deleting}
          pending={archive.isPending}
          error={archive.error?.message}
          onClose={() => {
            if (!archive.isPending) setDeleting(null);
          }}
          onConfirm={(linkedAction) =>
            archive.mutate({ row: deleting, linkedAction })
          }
        />
      )}
    </div>
  );
}

function DeleteTransactionDialog({
  transaction,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  transaction: HouseholdTransaction;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: (linkedAction?: "sync" | "unlink") => void;
}) {
  const [linkedAction, setLinkedAction] = useState<"sync" | "unlink">("sync");
  return (
    <Modal title="确认删除收支记录" onClose={onClose}>
      <div className="delete-dialog">
        <div className="delete-summary">
          <Trash2 size={20} />
          <div>
            <strong>{transaction.occurred_on} · {transaction.note || transaction.category_name}</strong>
            <span>
              {transaction.kind === "income" ? "收入" : "支出"} · {money(transaction.amount_cny)}
            </span>
          </div>
        </div>
        <p>删除后，这笔记录会立即从当月收支、预算实际值和总览统计中移除。</p>
        {transaction.linked_cash_flow_id && (
          <label className="delete-link-choice">
            <span>这笔记录已关联资产资金流</span>
            <select
              value={linkedAction}
              onChange={(event) => setLinkedAction(event.target.value as "sync" | "unlink")}
            >
              <option value="sync">同时归档关联的资金流</option>
              <option value="unlink">只删除收支，保留原资金流</option>
            </select>
          </label>
        )}
        {error && <p className="form-error">删除失败：{error}</p>}
        <div className="form-actions">
          <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={pending}
            onClick={() => onConfirm(transaction.linked_cash_flow_id ? linkedAction : undefined)}
          >
            <Trash2 size={14} /> {pending ? "正在删除…" : "确认删除"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TransactionForm({
  meta,
  initialMonth,
  transaction,
  onClose,
  onSaved,
}: {
  meta: MetaData;
  initialMonth: string;
  transaction?: HouseholdTransaction;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<"income" | "expense">(
    transaction?.kind || "expense",
  );
  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      transaction
        ? api.patch(`/household/transactions/${transaction.id}`, body)
        : api.post("/household/transactions", body),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    mutation.mutate({
      kind,
      amount: Number(f.get("amount")),
      currency_id: Number(f.get("currency_id")),
      ...(f.get("fx_rate_to_cny")
        ? { fx_rate_to_cny: Number(f.get("fx_rate_to_cny")) }
        : {}),
      category_id: Number(f.get("category_id")),
      account_id: f.get("account_id") ? Number(f.get("account_id")) : null,
      occurred_on: f.get("occurred_on"),
      note: f.get("note"),
      ...(transaction?.linked_cash_flow_id
        ? { linked_action: f.get("linked_action") }
        : {}),
    });
  };
  return (
    <Modal title={transaction ? "修改收支记录" : "记录家庭收支"} onClose={onClose}>
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
            defaultValue={transaction?.amount}
            required
            autoFocus
          />
        </label>
        <label>
          <span>币种</span>
          <select
            name="currency_id"
            defaultValue={transaction?.currency_id || meta.currencies.find((x) => x.code === "CNY")?.id}
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
          <select name="category_id" defaultValue={transaction?.category_id} required>
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
          <span>记账汇率（兑 CNY）</span>
          <input
            name="fx_rate_to_cny"
            type="number"
            min="0.000001"
            step="any"
            defaultValue={transaction?.fx_rate_to_cny}
            placeholder="留空则使用当前汇率"
          />
        </label>
        <label>
          <span>账户（可选）</span>
          <select name="account_id" defaultValue={transaction?.account_id || ""}>
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
            defaultValue={
              transaction?.occurred_on ||
              (initialMonth === currentMonth() ? today() : `${initialMonth}-01`)
            }
            required
          />
        </label>
        <label>
          <span>备注</span>
          <input name="note" defaultValue={transaction?.note} placeholder="例如：家庭采购" />
        </label>
        {transaction?.linked_cash_flow_id && (
          <label className="span-2">
            <span>已关联的资产资金流</span>
            <select name="linked_action" defaultValue="sync">
              <option value="sync">同步更新资金流</option>
              <option value="unlink">解除关联，原资金流归档</option>
            </select>
          </label>
        )}
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
  const [calendarMonth, setCalendarMonth] = useState(currentMonth());
  const dashboard = useQuery({
    queryKey: ["dashboard-plans", calendarMonth],
    queryFn: () =>
      api.get<DashboardData>(`/dashboard?month=${calendarMonth}&range=1M`),
  });
  const memoQuery = useQuery({
    queryKey: ["memos"],
    queryFn: () => api.get<FinancialMemo[]>("/household/memos"),
  });
  const projects = dashboard.data?.household.projects || [];
  const memos = useMemo(() => {
    const todayAtNoon = new Date(`${today()}T12:00:00`).getTime();
    return (memoQuery.data || [])
      .filter((memo) => memo.status === "pending")
      .map((memo) => {
        const daysUntil = Math.round(
          (new Date(`${memo.due_date}T12:00:00`).getTime() - todayAtNoon) /
            86_400_000,
        );
        return {
          ...memo,
          days_until: daysUntil,
          display_status:
            daysUntil < 0
              ? "overdue"
              : daysUntil <= memo.reminder_days
                ? "upcoming"
                : "pending",
        } as FinancialMemo;
      })
      .sort((a, b) => a.due_date.localeCompare(b.due_date));
  }, [memoQuery.data]);
  const [calendarYear, calendarMonthNumber] = calendarMonth
    .split("-")
    .map(Number);
  const calendarDays = Array.from(
    { length: new Date(calendarYear, calendarMonthNumber, 0).getDate() },
    (_, index) => {
      const day = index + 1;
      const key = `${calendarMonth}-${String(day).padStart(2, "0")}`;
      const date = new Date(calendarYear, calendarMonthNumber - 1, day, 12);
      return {
        key,
        day,
        weekday: "日一二三四五六"[date.getDay()],
        memos: memos.filter((memo) => memo.due_date === key),
      };
    },
  );
  const refreshPlans = () => {
    client.invalidateQueries({ queryKey: ["dashboard-plans"] });
    client.invalidateQueries({ queryKey: ["memos"] });
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
            <h3>{monthLabel(calendarMonth)}大额事项日历</h3>
            <p>可切换到任意月份，提前安排大额收入与支出。</p>
          </div>
          <MonthNavigator
            month={calendarMonth}
            onChange={setCalendarMonth}
            label="计划日历月份"
          />
        </div>
        <div className="calendar-strip">
          {calendarDays.map((day) => (
            <div
              className={day.memos.length ? "has-event" : ""}
              style={day.day === 1 ? { gridColumnStart: new Date(calendarYear, calendarMonthNumber - 1, 1, 12).getDay() + 1 } : undefined}
              key={day.key}
            >
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
              <p>显示全部待处理事项，不再限制未来 30 天。</p>
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
                title="没有待处理的大额事项"
                text="可先切换计划月份，再新建未来备忘。"
              />
            )}
          </div>
        </section>
      </div>
      {modal && meta.data && (
        <PlanForm
          kind={modal}
          meta={meta.data}
          initialMonth={calendarMonth}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            client.invalidateQueries({ queryKey: ["dashboard-plans"] });
            client.invalidateQueries({ queryKey: ["memos"] });
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
  initialMonth,
  onClose,
  onSaved,
}: {
  kind: "project" | "memo";
  meta: MetaData;
  initialMonth: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialDate =
    initialMonth === currentMonth() ? today() : `${initialMonth}-01`;
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
              <input name="start_date" type="date" defaultValue={initialDate} />
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
              <input name="due_date" type="date" defaultValue={initialDate} required />
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
  const assets = useQuery({
    queryKey: ["assets"],
    queryFn: () => api.get<ValuedAsset[]>("/assets"),
  });
  const [open, setOpen] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const accountLabels: Record<string, string> = {
    investment: "投资账户",
    bank: "银行账户",
    e_wallet: "电子钱包",
    cash: "现金账户",
    credit: "信用账户",
    other: "其他账户",
  };
  const platformGroups = useMemo(() => {
    const map = new Map<
      string,
      { name: string; accounts: any[]; assets: ValuedAsset[]; value: number }
    >();
    for (const account of query.data || []) {
      const name = platformName(account.name);
      const group = map.get(name) || { name, accounts: [], assets: [], value: 0 };
      group.accounts.push(account);
      map.set(name, group);
    }
    for (const asset of assets.data || []) {
      const name = platformName(asset.accountName);
      const group = map.get(name) || { name, accounts: [], assets: [], value: 0 };
      group.assets.push(asset);
      group.value += asset.marketValueCny;
      map.set(name, group);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [query.data, assets.data]);
  const selected = platformGroups.find((group) => group.name === selectedPlatform);
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="Unified accounts"
        title="家庭账户"
        description="先按平台汇总，再进入子账户或购买渠道查看具体持仓。"
        action={
          <button className="primary-button" onClick={() => setOpen(true)}>
            <Plus size={16} /> 添加账户
          </button>
        }
      />
      <div className="account-hierarchy-guide compact" aria-label="账户组织层级">
        <div><b>1</b><span>平台</span><strong>统一汇总入口</strong></div>
        <ChevronRight size={16} />
        <div><b>2</b><span>子账户 / 购买渠道</span><strong>平台内的资金位置</strong></div>
        <ChevronRight size={16} />
        <div><b>3</b><span>持仓</span><strong>具体资产项目</strong></div>
      </div>
      <div className="account-card-grid">
        {platformGroups.map((platform) => (
          <button
            className={`account-card account-overview-card ${selectedPlatform === platform.name ? "selected" : ""}`}
            key={platform.name}
            onClick={() => setSelectedPlatform(platform.name)}
          >
            <div className={`account-card-icon type-${platform.accounts[0]?.account_type || "other"}`}>
              <Landmark />
            </div>
            <div>
              <span>
                {[...new Set(platform.accounts.map((account) => accountLabels[account.account_type] || "其他账户"))].join(" / ")}
              </span>
              <h3>{platform.name}</h3>
              <p>
                {platform.accounts.length} 个子账户 / 渠道 · {platform.assets.length} 项持仓
              </p>
            </div>
            <strong>{money(platform.value, privateMode)}</strong>
            <ChevronRight size={17} />
          </button>
        ))}
      </div>
      {selected && (
        <section className="content-panel no-padding selected-detail">
          <div className="detail-head">
            <div>
              <span>平台</span>
              <h3>{selected.name}</h3>
              <p>
                子账户 / 渠道：{selected.accounts.map((account) => parseAccountHierarchy(account.name).channelName).join("、")} · {money(selected.value, privateMode)}
              </p>
            </div>
            <button className="secondary-button" onClick={() => setSelectedPlatform(null)}>收起明细</button>
          </div>
          {selected.assets.length ? (
            <div className="responsive-table">
              <table>
                <thead>
                  <tr>
                    <th>资产</th>
                    <th>子账户 / 渠道</th>
                    <th>类别</th>
                    <th>市值</th>
                    <th>盈亏</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.assets
                    .slice()
                    .sort((a, b) => b.marketValueCny - a.marketValueCny)
                    .map((asset) => (
                      <tr key={asset.id}>
                        <td data-label="资产"><strong>{asset.name}</strong><small>{asset.code}</small></td>
                        <td data-label="子账户 / 渠道">
                          <strong>{parseAccountHierarchy(asset.accountName).channelName}</strong>
                          <small>{selected.name} 平台</small>
                        </td>
                        <td data-label="类别"><span className="tag">{asset.classLabel}</span></td>
                        <td data-label="市值"><strong>{money(asset.marketValueCny, privateMode)}</strong></td>
                        <td data-label="盈亏">
                          <span className={asset.profitCny >= 0 ? "positive" : "negative"}>
                            {money(asset.profitCny, privateMode)}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<WalletCards />}
              title="这个平台暂无资产持仓"
              text="它仍可作为家庭收支账户使用。"
            />
          )}
        </section>
      )}
      {!platformGroups.length && (
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
          <span>平台与子账户 / 渠道名称</span>
          <input
            name="name"
            required
            autoFocus
            placeholder="例如：支付宝 · 基金；独立账户可直接写 Trading212"
          />
          <small className="field-help">推荐格式：平台 · 子账户/购买渠道。没有下级时只填写平台名。</small>
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
