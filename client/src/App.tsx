import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  Bell,
  ChevronRight,
  CircleDollarSign,
  Eye,
  EyeOff,
  Gauge,
  Landmark,
  LayoutDashboard,
  Moon,
  MoreHorizontal,
  PiggyBank,
  RefreshCw,
  Settings2,
  Sun,
  WalletCards,
} from "lucide-react";
import { api } from "./api";
import { currentMonth, MonthNavigator, monthLabel } from "./dateControls";
import type { DashboardData } from "./types";

const loadPages = () => import("./pages");
const AccountsPage = lazy(() =>
  loadPages().then(({ AccountsPage }) => ({ default: AccountsPage })),
);
const AssetsPage = lazy(() =>
  loadPages().then(({ AssetsPage }) => ({ default: AssetsPage })),
);
const BudgetPage = lazy(() =>
  loadPages().then(({ BudgetPage }) => ({ default: BudgetPage })),
);
const PlansPage = lazy(() =>
  loadPages().then(({ PlansPage }) => ({ default: PlansPage })),
);
const StatusPage = lazy(() =>
  loadPages().then(({ StatusPage }) => ({ default: StatusPage })),
);
const TransactionsPage = lazy(() =>
  loadPages().then(({ TransactionsPage }) => ({ default: TransactionsPage })),
);

const nav = [
  { label: "总览", mobileLabel: "总览", icon: LayoutDashboard, path: "/" },
  { label: "资产", mobileLabel: "资产", icon: Landmark, path: "/assets" },
  { label: "家庭预算", mobileLabel: "预算", icon: PiggyBank, path: "/budget" },
  {
    label: "收支记录",
    mobileLabel: "收支",
    icon: WalletCards,
    path: "/transactions",
  },
  { label: "计划与提醒", mobileLabel: "计划", icon: Bell, path: "/plans" },
  { label: "账户", mobileLabel: "账户", icon: CircleDollarSign, path: "/accounts" },
  { label: "数据状态", mobileLabel: "状态", icon: Gauge, path: "/status" },
];

function MobileNavigation() {
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const activeMorePage = nav.slice(5).find((item) => item.path === pathname);

  useEffect(() => setMoreOpen(false), [pathname]);
  useEffect(() => {
    if (!moreOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !navRef.current?.contains(event.target)
      ) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [moreOpen]);

  return (
    <nav className="mobile-nav" aria-label="移动端导航" ref={navRef}>
      {nav.slice(0, 5).map((item) => (
        <NavLink
          className={({ isActive }) => (isActive ? "active" : "")}
          end={item.path === "/"}
          to={item.path}
          key={item.label}
        >
          <item.icon size={20} aria-hidden="true" />
          <span>{item.mobileLabel}</span>
        </NavLink>
      ))}
      <button
        ref={moreButtonRef}
        type="button"
        className={`mobile-more-trigger${activeMorePage ? " active" : ""}`}
        aria-controls="mobile-more-panel"
        aria-expanded={moreOpen}
        aria-label={activeMorePage ? `更多页面，当前是${activeMorePage.label}` : "更多页面"}
        onClick={() => setMoreOpen((open) => !open)}
      >
        <MoreHorizontal size={20} aria-hidden="true" />
        <span>更多</span>
      </button>
      <div className="mobile-more-panel" id="mobile-more-panel" hidden={!moreOpen}>
        <span className="mobile-more-title">更多页面</span>
        {nav.slice(5).map((item) => (
          <NavLink
            className={({ isActive }) => (isActive ? "active" : "")}
            to={item.path}
            key={item.label}
            onClick={() => setMoreOpen(false)}
          >
            <item.icon size={19} aria-hidden="true" />
            <span>{item.label}</span>
            <ChevronRight size={17} aria-hidden="true" />
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

function App() {
  const hour = new Date().getHours();
  const greeting = hour < 5 || hour >= 19 ? "晚上好" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : "下午好";
  const [theme, setTheme] = useState(
    () => localStorage.getItem("stone-theme") || "light",
  );
  const [privateMode, setPrivateMode] = useState(
    () => localStorage.getItem("stone-private") === "true",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("stone-theme", theme);
  }, [theme]);
  useEffect(
    () => localStorage.setItem("stone-private", String(privateMode)),
    [privateMode],
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <strong>Stone Wealth</strong>
            <span>家庭财务中心</span>
          </div>
        </div>
        <nav className="side-nav" aria-label="主导航">
          {nav.map((item) => (
            <NavLink
              className={({ isActive }) => (isActive ? "active" : "")}
              end={item.path === "/"}
              to={item.path}
              key={item.label}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-avatar">
            {(window.__USER__?.username || "L").slice(0, 1).toUpperCase()}
          </div>
          <div>
            <strong>{window.__USER__?.username || "本地预览"}</strong>
            <span>家庭成员 · 可编辑</span>
          </div>
          <Settings2 size={17} />
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">家庭财务驾驶舱</span>
            <h1>{greeting}，欢迎回家</h1>
          </div>
          <div className="top-actions">
            <button
              className="icon-button"
              aria-label="隐私模式"
              onClick={() => setPrivateMode(!privateMode)}
            >
              {privateMode ? <EyeOff /> : <Eye />}
            </button>
            <button
              className="icon-button"
              aria-label="切换主题"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon /> : <Sun />}
            </button>
          </div>
        </header>
        <Suspense fallback={<div className="state-card" role="status">正在加载页面…</div>}>
          <Routes>
            <Route path="/" element={<Dashboard privateMode={privateMode} />} />
            <Route
              path="/assets"
              element={<AssetsPage privateMode={privateMode} />}
            />
            <Route
              path="/budget"
              element={<BudgetPage privateMode={privateMode} />}
            />
            <Route
              path="/transactions"
              element={<TransactionsPage privateMode={privateMode} />}
            />
            <Route
              path="/plans"
              element={<PlansPage privateMode={privateMode} />}
            />
            <Route
              path="/accounts"
              element={<AccountsPage privateMode={privateMode} />}
            />
            <Route path="/status" element={<StatusPage />} />
          </Routes>
        </Suspense>
      </main>
      <MobileNavigation />
    </div>
  );
}

function Dashboard({ privateMode }: { privateMode: boolean }) {
  const [month, setMonth] = useState(currentMonth());
  const query = useQuery({
    queryKey: ["dashboard", month],
    queryFn: () => api.get<DashboardData>(`/dashboard?month=${month}&range=3M`),
  });
  const data = query.data;

  const currency = (value: number, compact = false, currencyCode = "CNY") =>
    privateMode
      ? "••••••"
      : new Intl.NumberFormat("zh-CN", {
          style: "currency",
          currency: currencyCode,
          maximumFractionDigits: compact ? 0 : 2,
          notation:
            compact && Math.abs(value) >= 1_000_000 ? "compact" : "standard",
        }).format(value || 0);

  if (query.isLoading) return <DashboardSkeleton />;
  if (query.isError || !data)
    return (
      <div className="state-card">
        <strong>暂时无法加载数据</strong>
        <span>{query.error?.message}</span>
        <button onClick={() => query.refetch()}>重新加载</button>
      </div>
    );

  const classCards = ["cash", "fund", "stock", "alternative"].map(
    (code) =>
      data.allocations.byClass.find((item) => item.code === code) || {
        code,
        label: (
          {
            cash: "现金",
            fund: "基金",
            stock: "股票",
            alternative: "另类资产",
          } as Record<string, string>
        )[code],
        valueCny: 0,
        percent: 0,
        count: 0,
      },
  );
  const unclassified = data.allocations.byClass.find(
    (item) => item.code === "unclassified",
  );
  const plannedExpenseCategories = data.household.budgets.filter(
    (item) => item.kind === "expense" && item.planned > 0,
  );

  return (
    <div className="dashboard-grid">
      <section className="dashboard-period">
        <div>
          <span>家庭财务月份</span>
          <strong>{monthLabel(month)}</strong>
        </div>
        <MonthNavigator month={month} onChange={setMonth} />
      </section>
      <section className="hero-card">
        <div className="hero-head">
          <div>
            <span>家庭总资产</span>
            <strong>{currency(data.totals.marketValueCny)}</strong>
          </div>
          <span className="live-pill">
            <i /> CNY 基准
          </span>
        </div>
        <div className="hero-metrics">
          <div>
            <span>资产项目</span>
            <strong>{data.totals.assetCount}</strong>
          </div>
          <div>
            <span>账户平台</span>
            <strong>{data.totals.accountCount}</strong>
          </div>
          <div>
            <span>待分类资产</span>
            <strong>{currency(unclassified?.valueCny || 0)}</strong>
          </div>
        </div>
      </section>

      <section className="asset-class-grid">
        {classCards.map((item, index) => (
          <article
            className={`class-card ${item.code === "fund" || item.code === "stock" ? "with-profit" : ""}`}
            key={String(item.code)}
          >
            <div className={`class-icon tone-${index}`}>
              <span />
            </div>
            <div>
              <span>{item.label}</span>
              <strong>{currency(item.valueCny, true)}</strong>
              {(item.code === "fund" || item.code === "stock") && (
                <small
                  className={(item.profitCny || 0) >= 0 ? "positive" : "negative"}
                >
                  持有盈亏 {currency(item.profitCny || 0)} · {Number(item.profitPercent || 0).toFixed(1)}%
                </small>
              )}
            </div>
            <small className="class-share">{item.percent.toFixed(1)}%</small>
          </article>
        ))}
      </section>

      <section className="panel allocation-panel">
        <PanelTitle title="资产配置" subtitle="按资产类别" />
        <div className="allocation-content">
          <div className="donut-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data.allocations.byClass.filter((x) => x.valueCny > 0)}
                  dataKey="valueCny"
                  innerRadius={54}
                  outerRadius={76}
                  paddingAngle={3}
                  stroke="none"
                >
                  {data.allocations.byClass.map((entry) => (
                    <Cell
                      key={String(entry.code)}
                      fill={entry.color || "#64748b"}
                    />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => currency(Number(value))} />
              </PieChart>
            </ResponsiveContainer>
            <div>
              <strong>{privateMode ? "••" : "100"}</strong>
              <span>%</span>
            </div>
          </div>
          <div className="allocation-list">
            {data.allocations.byClass.map((item) => (
              <div key={String(item.code)}>
                <i style={{ background: item.color }} />
                <span>{item.label}</span>
                <strong>{item.percent.toFixed(1)}%</strong>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel budget-panel">
        <PanelTitle
          title="家庭预算"
          subtitle={data.household.month.replace("-", " 年 ") + " 月"}
          action={
            <NavLink
              className="text-button"
              to="/budget"
              style={{ textDecoration: "none" }}
            >
              管理预算 <ChevronRight size={15} />
            </NavLink>
          }
        />
        <div className="budget-summary">
          <div>
            <span>已支出</span>
            <strong>{currency(data.household.totals.expense)}</strong>
          </div>
          <div>
            <span>预算剩余</span>
            <strong>{currency(data.household.totals.remainingBudget)}</strong>
          </div>
        </div>
        <div className="budget-progress">
          <i
            style={{
              width: `${Math.min(100, data.household.totals.plannedExpense > 0 ? (data.household.totals.expense / data.household.totals.plannedExpense) * 100 : 0)}%`,
            }}
          />
        </div>
        <div className="budget-categories">
          {plannedExpenseCategories.slice(0, 4).map((item) => (
            <div key={item.id}>
              <i style={{ background: item.color }} />
              <span>{item.categoryName}</span>
              <strong>
                {currency(item.actual, true)} / {currency(item.planned, true)}
              </strong>
            </div>
          ))}
          {!plannedExpenseCategories.length && (
            <div className="empty-inline">
              <PiggyBank size={20} />
              <span>还没有预算，先为这个月做个轻量计划</span>
            </div>
          )}
        </div>
      </section>

      <section className="panel account-panel">
        <PanelTitle title="主要账户" subtitle="按市值排序" />
        <div className="account-list">
          {data.topAccounts.slice(0, 5).map((item, index) => (
            <div key={String(item.code)}>
              <span className="account-rank">{index + 1}</span>
              <div>
                <strong>{item.label}</strong>
                <small>{item.count} 项资产</small>
              </div>
              <span>{currency(item.valueCny, true)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel reminder-panel">
        <PanelTitle
          title="近期大额事项"
          subtitle="未来 30 天"
          action={
            <NavLink
              className="round-button"
              to="/plans"
              aria-label="查看大额事项提醒"
            >
              <Bell size={16} />
            </NavLink>
          }
        />
        <div className="memo-list">
          {data.household.memos.slice(0, 4).map((memo) => (
            <div className={memo.display_status} key={memo.id}>
              <div className="memo-date">
                <strong>{memo.due_date.slice(8)}</strong>
                <span>{memo.due_date.slice(5, 7)}月</span>
              </div>
              <div>
                <strong>{memo.title}</strong>
                <span>
                  {memo.display_status === "overdue"
                    ? "已逾期"
                    : memo.days_until === 0
                      ? "今天"
                      : `${memo.days_until} 天后`}
                </span>
              </div>
              <b>
                {memo.kind === "expense" ? "-" : "+"}
                {currency(memo.expected_amount, true, memo.currency_code)}
              </b>
            </div>
          ))}
          {!data.household.memos.length && (
            <div className="empty-inline">
              <Bell size={20} />
              <span>未来 30 天没有待处理的大额事项</span>
            </div>
          )}
        </div>
      </section>

      <div className="data-note">
        <RefreshCw size={14} />
        <span>
          {data.freshness.staleCount
            ? `${data.freshness.staleCount} 项行情需要更新`
            : "资产数据已同步"}{" "}
          · 更新于{" "}
          {new Date(data.asOf).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
    </div>
  );
}

function PanelTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="panel-title">
      <div>
        <h2>{title}</h2>
        {subtitle && <span>{subtitle}</span>}
      </div>
      {action}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="dashboard-grid skeleton-grid">
      {Array.from({ length: 8 }).map((_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

export default App;
