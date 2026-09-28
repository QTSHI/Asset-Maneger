import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDollarSign,
  Edit3,
  Landmark,
  Link2,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
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
  today,
} from "./dateControls";
import type {
  HouseholdTransaction,
  MetaData,
  ValuedAsset,
} from "./types";

const money = (value: number, hidden = false, currencyCode = "CNY") =>
  hidden
    ? "••••••"
    : new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: currencyCode,
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
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstField = dialog?.querySelector<HTMLElement>(
      'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
    );
    (firstField || dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
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
    <button
      className="primary-button"
      aria-disabled={pending}
      type="submit"
      style={pending ? { opacity: 0.55, cursor: "not-allowed", transform: "none" } : undefined}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
    >
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

const isCashBalance = (asset: ValuedAsset) =>
  asset.assetType === "cash";

function cashConfirmation(asset: ValuedAsset) {
  if (asset.externalSource === "trading212") {
    const synced = asset.quote.fetchedAt?.slice(0, 10);
    if (!synced) return { label: "余额尚未同步", stale: true };
    const days = Math.floor((Date.parse(today()) - Date.parse(synced)) / 86_400_000);
    return {
      label: days > 3 ? `上次同步 ${synced} · 建议刷新` : `余额同步于 ${synced}`,
      stale: days > 3,
    };
  }
  const date = asset.cashConfirmedAt?.slice(0, 10);
  if (!date) return { label: "余额尚未确认", stale: true };
  const days = Math.floor((Date.parse(today()) - Date.parse(date)) / 86_400_000);
  return {
    label: days > 30 ? `上次确认 ${date} · 建议复核` : `余额确认于 ${date}`,
    stale: days > 30,
  };
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
  const [editingCash, setEditingCash] = useState<ValuedAsset | null>(null);
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
                      {isCashBalance(asset) && (
                        <small className={cashConfirmation(asset).stale ? "negative" : ""}>
                          {cashConfirmation(asset).label}
                        </small>
                      )}
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
                        {isCashBalance(asset) && asset.externalSource !== "trading212" && (
                          <button onClick={() => setEditingCash(asset)} aria-label={`更新 ${asset.name} 余额`} title="更新现金余额"><WalletCards size={15} /></button>
                        )}
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
      {editingCash && (
        <CashBalanceForm
          asset={editingCash}
          privateMode={privateMode}
          onClose={() => setEditingCash(null)}
          onSaved={() => {
            setEditingCash(null);
            client.invalidateQueries({ queryKey: ["assets"] });
            client.invalidateQueries({ queryKey: ["accounts"] });
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

export function TransactionsPage({ privateMode }: { privateMode: boolean }) {
  const client = useQueryClient();
  const meta = useMeta();
  const [month, setMonth] = useState(currentMonth());
  const [selectedCategory, setSelectedCategory] = useState("");
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
        client.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      setDeleting(null);
    },
  });
  const rows = query.data || [];
  const visibleRows = selectedCategory
    ? rows.filter((row) => String(row.category_id) === selectedCategory)
    : rows;
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
          <span>{selectedCategory ? "筛选记录" : "记录数量"}</span>
          <strong>{visibleRows.length}</strong>
        </div>
      </div>
      <div className="toolbar">
        <MonthNavigator month={month} onChange={setMonth} label="收支月份" />
        <label className="filter-button">
          <ListFilter size={15} aria-hidden="true" />
          <select
            aria-label="筛选分类"
            value={selectedCategory}
            onChange={(event) => setSelectedCategory(event.target.value)}
            style={{ border: 0, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" }}
          >
            <option value="">全部分类</option>
            {(meta.data?.categories || []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.kind === "income" ? "收入" : "支出"} · {category.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="cash-flow-explainer">
        <Link2 size={18} />
        <div>
          <strong>资产联动是什么？</strong>
          <p>
            普通收支只保存在收支记录中；联动后会在所选账户生成同金额的入金或出金记录，用于区分“投资涨跌”和“家庭资金进出”。它不会自动修改持仓数量或行情价格。
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
                <th>账户</th>
                <th>备注</th>
                <th>金额</th>
                <th>资产联动</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
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
                  <td data-label="账户">
                    <strong>{row.account_name || "未关联账户"}</strong>
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
        {!visibleRows.length && (
          <EmptyState
            icon={<WalletCards />}
            title={selectedCategory ? "该分类暂无收支记录" : "这个月还没有收支记录"}
            text={selectedCategory ? "切换分类查看其他记录。" : "从一笔收入或支出开始。"}
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
        <p>删除后，这笔记录会立即从当月收支和总览统计中移除。</p>
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
              <option value="unlink">解除关联，保留原资金流</option>
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

function CashBalanceForm({
  asset,
  privateMode,
  onClose,
  onSaved,
}: {
  asset: ValuedAsset;
  privateMode: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (payload: { balance: number; confirmed_on: string }) =>
      api.patch(`/assets/${asset.id}/cash-balance`, payload),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      balance: Number(form.get("balance")),
      confirmed_on: String(form.get("confirmed_on")),
    });
  };
  return (
    <Modal title={`确认 ${asset.name} 余额`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <p className="field-help span-2">直接更新这项现金资产的余额，不会新增资产或收支记录。</p>
        <label>
          <span>确认后的余额 · {asset.currency}</span>
          <input
            name="balance"
            type="number"
            step="any"
            defaultValue={privateMode ? "" : asset.shares}
            placeholder="输入当前余额"
            required
          />
        </label>
        <label>
          <span>确认日期</span>
          <input name="confirmed_on" type="date" defaultValue={today()} max={today()} required />
        </label>
        {mutation.error && <p className="form-error span-2">{mutation.error.message}</p>}
        <div className="form-actions span-2">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <SubmitButton pending={mutation.isPending}>确认余额</SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

interface AccountRecord {
  id: number;
  name: string;
  account_type: string;
  default_currency_id: number | null;
  currency_code: string | null;
  asset_count: number;
  market_value_cny: number;
  archived_at?: string | null;
}

export function AccountsPage({ privateMode }: { privateMode: boolean }) {
  const client = useQueryClient();
  const meta = useMeta();
  const query = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<AccountRecord[]>("/accounts"),
  });
  const assets = useQuery({
    queryKey: ["assets"],
    queryFn: () => api.get<ValuedAsset[]>("/assets"),
  });
  const [showArchived, setShowArchived] = useState(false);
  const archivedAccounts = useQuery({
    queryKey: ["accounts", "archived"],
    queryFn: () => api.get<AccountRecord[]>("/accounts?archived=1"),
    enabled: showArchived,
  });
  const [editingAccount, setEditingAccount] = useState<AccountRecord | "new" | null>(null);
  const [editingCash, setEditingCash] = useState<ValuedAsset | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const archiveAccount = useMutation({
    mutationFn: (id: number) => api.delete(`/accounts/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["meta"] });
    },
  });
  const restoreAccount = useMutation({
    mutationFn: (id: number) => api.post(`/accounts/${id}/restore`, {}),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["meta"] });
    },
  });
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
      { name: string; accounts: AccountRecord[]; assets: ValuedAsset[]; value: number }
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
          <div className="button-row">
            <button className="secondary-button" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? "隐藏已归档" : "查看已归档"}
            </button>
            <button className="primary-button" onClick={() => setEditingAccount("new")}>
              <Plus size={16} /> 添加账户
            </button>
          </div>
        }
      />
      <div className="account-hierarchy-guide compact" aria-label="账户组织层级">
        <div><b>1</b><span>平台</span><strong>统一汇总入口</strong></div>
        <ChevronRight size={16} />
        <div><b>2</b><span>子账户 / 购买渠道</span><strong>平台内的资金位置</strong></div>
        <ChevronRight size={16} />
        <div><b>3</b><span>持仓</span><strong>具体资产项目</strong></div>
      </div>
      {(query.error || assets.error) && (
        <p className="form-error" role="alert">{(query.error || assets.error)?.message}</p>
      )}
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
          {archiveAccount.error && (
            <p className="form-error" role="alert">{archiveAccount.error.message}</p>
          )}
          <div className="responsive-table">
            <table>
              <thead>
                <tr><th>子账户 / 渠道</th><th>类型</th><th>默认币种</th><th>持仓数</th><th>操作</th></tr>
              </thead>
              <tbody>
                {selected.accounts.map((account) => (
                  <tr key={account.id}>
                    <td data-label="子账户 / 渠道"><strong>{parseAccountHierarchy(account.name).channelName}</strong><small>{account.name}</small></td>
                    <td data-label="类型">{accountLabels[account.account_type] || "其他账户"}</td>
                    <td data-label="默认币种">{account.currency_code || "未设置"}</td>
                    <td data-label="持仓数">{account.asset_count}</td>
                    <td data-label="操作">
                      <div className="row-actions">
                        <button onClick={() => setEditingAccount(account)} aria-label={`修改 ${account.name}`} title="修改账户"><Edit3 size={15} /></button>
                        <button
                          onClick={() => confirm(`归档 ${account.name}？历史记录会保留。`) && archiveAccount.mutate(account.id)}
                          aria-label={`归档 ${account.name}`}
                          title={account.asset_count ? "请先处理该账户中的资产" : "归档账户"}
                          disabled={account.asset_count > 0 || archiveAccount.isPending}
                        ><Trash2 size={15} /></button>
                      </div>
                      {account.asset_count > 0 && <small>先处理持仓后可归档</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.assets
                    .slice()
                    .sort((a, b) => b.marketValueCny - a.marketValueCny)
                    .map((asset) => (
                      <tr key={asset.id}>
                        <td data-label="资产">
                          <strong>{asset.name}</strong><small>{asset.code}</small>
                          {isCashBalance(asset) && (
                            <small className={cashConfirmation(asset).stale ? "negative" : ""}>{cashConfirmation(asset).label}</small>
                          )}
                        </td>
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
                        <td data-label="操作">
                          {isCashBalance(asset) && (
                            asset.externalSource === "trading212"
                              ? <small>由 Trading212 同步</small>
                              : <button className="secondary-button" onClick={() => setEditingCash(asset)}>更新余额</button>
                          )}
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
      {!platformGroups.length && !query.isPending && !assets.isPending && !query.error && !assets.error && (
        <EmptyState
          icon={<CircleDollarSign />}
          title="还没有账户"
          text="添加银行、投资、钱包或现金账户。"
        />
      )}
      {showArchived && (
        <section className="content-panel no-padding">
          <div className="detail-head"><div><span>历史账户</span><h3>已归档账户</h3></div></div>
          {(archivedAccounts.error || restoreAccount.error) && (
            <p className="form-error" role="alert">{(archivedAccounts.error || restoreAccount.error)?.message}</p>
          )}
          {archivedAccounts.data?.length ? (
            <div className="responsive-table">
              <table>
                <thead><tr><th>账户</th><th>类型</th><th>归档时间</th><th>操作</th></tr></thead>
                <tbody>
                  {archivedAccounts.data.map((account) => (
                    <tr key={account.id}>
                      <td data-label="账户"><strong>{account.name}</strong></td>
                      <td data-label="类型">{accountLabels[account.account_type] || "其他账户"}</td>
                      <td data-label="归档时间">{account.archived_at?.slice(0, 10) || "—"}</td>
                      <td data-label="操作"><button className="secondary-button" disabled={restoreAccount.isPending} onClick={() => restoreAccount.mutate(account.id)}>恢复账户</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !archivedAccounts.isPending && !archivedAccounts.error && (
            <EmptyState icon={<WalletCards />} title="没有已归档账户" text="归档的账户会显示在这里。" />
          )}
        </section>
      )}
      {editingAccount && meta.data && (
        <AccountForm
          meta={meta.data}
          account={editingAccount === "new" ? undefined : editingAccount}
          onClose={() => setEditingAccount(null)}
          onSaved={(account) => {
            setEditingAccount(null);
            setSelectedPlatform(platformName(account.name));
            client.invalidateQueries({ queryKey: ["accounts"] });
            client.invalidateQueries({ queryKey: ["meta"] });
            client.invalidateQueries({ queryKey: ["assets"] });
          }}
        />
      )}
      {editingCash && (
        <CashBalanceForm
          asset={editingCash}
          privateMode={privateMode}
          onClose={() => setEditingCash(null)}
          onSaved={() => {
            setEditingCash(null);
            client.invalidateQueries({ queryKey: ["assets"] });
            client.invalidateQueries({ queryKey: ["accounts"] });
            client.invalidateQueries({ queryKey: ["dashboard"] });
          }}
        />
      )}
    </div>
  );
}

function AccountForm({
  account,
  meta,
  onClose,
  onSaved,
}: {
  account?: AccountRecord;
  meta: MetaData;
  onClose: () => void;
  onSaved: (account: AccountRecord) => void;
}) {
  const mutation = useMutation({
    mutationFn: (body: unknown) => account
      ? api.patch<AccountRecord>(`/accounts/${account.id}`, body)
      : api.post<AccountRecord>("/accounts", body),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const f = new FormData(event.currentTarget);
    mutation.mutate({
      name: f.get("name"),
      account_type: f.get("account_type"),
      default_currency_id: f.get("default_currency_id")
        ? Number(f.get("default_currency_id"))
        : null,
      category:
        f.get("account_type") === "investment"
          ? "投资类"
          : f.get("account_type") === "other"
            ? "其他"
            : "现金类",
    });
  };
  return (
    <Modal title={account ? "编辑家庭账户" : "添加家庭账户"} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="span-2">
          <span>平台与子账户 / 渠道名称</span>
          <input
            name="name"
            defaultValue={account?.name}
            required
            placeholder="例如：支付宝 · 基金；独立账户可直接写 Trading212"
          />
          <small className="field-help">推荐格式：平台 · 子账户/购买渠道。没有下级时只填写平台名。</small>
        </label>
        <label>
          <span>账户类型</span>
          <select name="account_type" defaultValue={account?.account_type}>
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
            defaultValue={account
              ? account.default_currency_id ?? ""
              : meta.currencies.find((x) => x.code === "CNY")?.id ?? ""}
          >
            <option value="">未设置</option>
            {meta.currencies.map((x) => (
              <option value={x.id} key={x.id}>
                {x.code}
              </option>
            ))}
          </select>
        </label>
        {mutation.error && (
          <p className="form-error span-2" role="alert">{mutation.error.message}</p>
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
  const database = useQuery({
    queryKey: ["data-health"],
    queryFn: () => api.get("/meta"),
    refetchInterval: 60_000,
  });
  const market = useQuery({
    queryKey: ["market-status"],
    queryFn: () => api.get<any>("/market/status"),
    refetchInterval: 4000,
  });
  const t212 = useQuery({
    queryKey: ["t212-status"],
    queryFn: () => api.get<any>("/integrations/trading212/status"),
    refetchInterval: 4_000,
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
    onSettled: () => {
      client.invalidateQueries({ queryKey: ["t212-status"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      client.invalidateQueries({ queryKey: ["assets"] });
    },
  });
  const t212Auth = t212.data?.authenticationState;
  const marketState = market.data?.state;
  const t212Error = t212Auth === "invalid" || t212.data?.state === "error";
  const t212Title = t212.isError
    ? "状态暂时无法读取"
    : t212.data?.state === "running"
      ? "正在同步"
      : t212Auth === "invalid"
        ? "凭据认证失败"
        : t212Auth === "valid"
          ? "最近同步成功"
          : t212Auth === "not_configured" || !t212.data?.configured
            ? "等待配置"
            : t212.data?.state === "error"
              ? "最近同步失败"
              : "凭据等待验证";
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
      {refresh.isError && <p className="form-error" role="alert">行情刷新失败：{refresh.error.message}</p>}
      <div className="status-grid">
        <article className="status-card">
          <div className={`status-icon ${database.isError ? "warning" : database.isSuccess ? "healthy" : "neutral"}`}>
            <ShieldCheck />
          </div>
          <div>
            <span>Stone Wealth 数据库</span>
            <h3>{database.isError ? "暂时无法读取" : database.isSuccess ? "运行正常" : "正在检查"}</h3>
            <p>{database.isError ? "请检查数据服务后重试。" : "业务数据保存在 SQLite，当前页面已核对数据读取。"}</p>
          </div>
          <b className={`status ${database.isError ? "error" : database.isSuccess ? "fresh" : "missing"}`}>
            {database.isError ? "异常" : database.isSuccess ? "正常" : "检查中"}
          </b>
        </article>
        <article className="status-card">
          <div
            className={`status-icon ${market.isError || marketState === "error" ? "warning" : marketState === "success" ? "healthy" : "neutral"}`}
          >
            <RefreshCw />
          </div>
          <div>
            <span>市场行情与汇率</span>
            <h3>
              {market.isError
                ? "状态暂时无法读取"
                : marketState === "running"
                ? "正在同步"
                : marketState === "error"
                  ? "部分异常"
                  : marketState === "success" ? "最近更新完成" : market.isSuccess ? "等待首次更新" : "正在检查"}
            </h3>
            <p>
              {market.data?.state === "error" && market.data?.message
                ? market.data.message
                : market.data?.finishedAt
                ? `最近完成 ${new Date(market.data.finishedAt).toLocaleString("zh-CN")}`
                : "后台每 30 分钟更新资产价格。"}
            </p>
          </div>
          <b
            className={`status ${market.isError || marketState === "error" ? "error" : marketState === "success" ? "fresh" : "missing"}`}
          >
            {market.isError ? "无法读取" : marketState === "error" ? "需关注" : marketState === "running" ? "更新中" : marketState === "success" ? `${market.data?.updated || 0} 成功 / ${market.data?.failed || 0} 失败` : "待更新"}
          </b>
        </article>
        <article className="status-card">
          <div
            className={`status-icon ${t212Error || t212.isError ? "warning" : t212Auth === "valid" ? "healthy" : "neutral"}`}
          >
            <Landmark />
          </div>
          <div>
            <span>Trading212</span>
            <h3>{t212Title}</h3>
            <p>
              {t212.isError
                ? "请检查本地服务后重试。"
                : t212Auth === "invalid"
                  ? "API 凭据被拒绝，请更新配置后重试；现有资产数据已保留。"
                  : t212.data?.message || (t212.data?.configured ? "可手动发起同步与对账。" : "配置 API 凭据后可同步投资账户。")}
            </p>
            {t212.data?.aggregateFallback && (
              <p>账户汇总备用值仍列为待分类资产，详细同步成功后再归档。</p>
            )}
            {t212.data?.configured && (
              <button
                className="secondary-button compact-button"
                disabled={syncT212.isPending || t212.data?.state === "running"}
                onClick={() => syncT212.mutate()}
              >
                {syncT212.isPending || t212.data?.state === "running" ? "正在对账" : "重新同步并对账"}
              </button>
            )}
            {syncT212.isError && <p className="form-error" role="alert">{syncT212.error.message}</p>}
          </div>
          <b
            className={`status ${t212Error || t212.isError ? "error" : t212Auth === "valid" ? "fresh" : "missing"}`}
          >
            {t212.isError ? "无法读取" : t212Auth === "valid" ? "已验证" : t212Auth === "invalid" ? "认证失败" : "待验证"}
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
