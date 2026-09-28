import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import App from "../client/src/App";
import type { DashboardData, MetaData } from "../client/src/types";

const emptyDashboard: DashboardData = {
  asOf: "2026-09-28T10:00:00.000Z",
  baseCurrency: "CNY",
  totals: {
    marketValueCny: 0,
    costValueCny: 0,
    profitCny: 0,
    profitPercent: 0,
    assetCount: 0,
    accountCount: 0,
  },
  allocations: { byClass: [], byAccount: [] },
  trend: [],
  topAccounts: [],
  recentAssets: [],
  freshness: { staleCount: 0, totalCount: 0, market: { state: "idle" } },
};

const meta: MetaData = {
  currencies: [{ id: 1, code: "CNY" }],
  assetTypes: [{ id: 2, name: "现金", asset_class_code: "cash", asset_subtype_code: "cash" }],
  categories: [],
  accounts: [],
  accountTypes: [{ code: "bank", label: "银行账户" }],
};

const response = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ data }),
}) as Response;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("first household use", () => {
  it("guides a new household from account creation to the existing asset form", async () => {
    let accounts: Array<{ id: number; name: string; account_type: string; default_currency_id: number; currency_code: string; asset_count: number; market_value_cny: number }> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v2/dashboard") return response(emptyDashboard);
      if (path === "/api/v2/accounts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const account = { id: 1, name: body.name, account_type: body.account_type, default_currency_id: 1, currency_code: "CNY", asset_count: 0, market_value_cny: 0 };
        accounts = [account];
        return response(account);
      }
      if (path === "/api/v2/accounts") return response(accounts);
      if (path === "/api/v2/assets") return response([]);
      if (path === "/api/v2/meta") return response({ ...meta, accounts });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "先添加一个账户，再录入资产" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "去添加账户" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加第一个账户" }));
    const accountDialog = await screen.findByRole("dialog", { name: "添加家庭账户" });
    fireEvent.change(within(accountDialog).getByRole("textbox"), { target: { value: "测试银行 · 储蓄" } });
    fireEvent.click(within(accountDialog).getByRole("button", { name: "保存" }));

    expect(await screen.findByText("账户已建好，下一步录入第一项资产")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "去添加资产" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加第一项资产" }));
    const assetDialog = await screen.findByRole("dialog", { name: "添加资产" });
    expect(within(assetDialog).getByRole("combobox", { name: "子账户 / 购买渠道" })).toHaveValue("1");
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === "/api/v2/accounts" && init?.method === "POST")).toHaveLength(1);
  });

  it("uses the real account list when dashboard has no holdings", async () => {
    const account = { id: 3, name: "银行", account_type: "bank", default_currency_id: 1, currency_code: "CNY", asset_count: 0, market_value_cny: 0 };
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === "/api/v2/dashboard") return response(emptyDashboard);
      if (String(url) === "/api/v2/accounts") return response([account]);
      throw new Error(`Unexpected request: ${String(url)}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "账户已准备好，录入第一项资产" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去添加资产" })).toHaveAttribute("href", "/assets");
    await waitFor(() => expect(screen.queryByText("先添加一个账户，再录入资产")).not.toBeInTheDocument());
  });

  it("shows data time and attention count beside the main total", async () => {
    const dashboard: DashboardData = {
      ...emptyDashboard,
      totals: { ...emptyDashboard.totals, assetCount: 1, accountCount: 1, marketValueCny: 100 },
      freshness: { ...emptyDashboard.freshness, staleCount: 2, totalCount: 1 },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === "/api/v2/dashboard") return response(dashboard);
      throw new Error(`Unexpected request: ${String(url)}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/页面生成于 .* · 2 项行情待关注/)).toBeInTheDocument();
    expect(screen.getByText("家庭总资产")).toBeInTheDocument();
  });
});
