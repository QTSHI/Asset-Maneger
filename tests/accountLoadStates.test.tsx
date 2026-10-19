import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AccountsPage } from "../client/src/pages";
import { api } from "../client/src/api";
import type { MetaData, ValuedAsset } from "../client/src/types";

const account = {
  id: 3,
  name: "测试银行 · 储蓄",
  account_type: "bank",
  default_currency_id: 1,
  currency_code: "CNY",
  asset_count: 0,
  market_value_cny: 0,
};
const meta: MetaData = {
  currencies: [{ id: 1, code: "CNY" }],
  assetTypes: [],
  categories: [],
  accounts: [account],
  accountTypes: [{ code: "bank", label: "银行账户" }],
};
const asset: ValuedAsset = {
  id: 7, code: "CASH-001", name: "储蓄现金", shares: 123, costPrice: 1,
  currentPrice: 1, quantityStatus: "verified", valuationMode: "units",
  valuationBasis: "unit_price", currency: "CNY", marketValueCny: 123,
  costValueCny: 123, profitCny: 0, profitPercent: 0, accountId: 3,
  accountName: account.name, assetTypeId: 1, assetType: "cash", classCode: "cash",
  classLabel: "现金", subtypeCode: "cash", subtypeLabel: "现金",
  quote: { status: "fresh" }, dataQuality: { status: "ready", label: "已确认", issues: [] },
};
const response = (data: unknown) => ({
  ok: true, status: 200, json: async () => ({ data }),
}) as Response;
const failure = (message: string) => ({
  ok: false, status: 503, json: async () => ({ error: { message } }),
}) as Response;

function DashboardCount() {
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<{ accountCount: number }>("/dashboard"),
  });
  return <output aria-label="总览账户数">{dashboard.data?.accountCount}</output>;
}

function renderAccounts(withDashboard = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AccountsPage privateMode={false} />
        {withDashboard && <DashboardCount />}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account data reliability", () => {
  it("keeps loading and failed holdings distinct from zero, then shows recovered valuations", async () => {
    let resolveAssets!: (value: Response) => void;
    const pendingAssets = new Promise<Response>((resolve) => { resolveAssets = resolve; });
    let assetReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/api/v2/meta") return response(meta);
      if (path === "/api/v2/accounts") return response([account]);
      if (path === "/api/v2/assets") return ++assetReads === 1 ? pendingAssets : response([asset]);
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderAccounts();

    const platform = (await screen.findByText("测试银行")).closest("button")!;
    expect(platform).toHaveTextContent("持仓加载中");
    expect(platform).toHaveTextContent("市值加载中");
    expect(platform).not.toHaveTextContent("0 项持仓");
    expect(platform).not.toHaveTextContent("¥0.00");
    fireEvent.click(platform);
    expect(screen.queryByText("这个平台暂无资产持仓")).not.toBeInTheDocument();

    await act(async () => { resolveAssets(failure("持仓服务暂时不可用")); });
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("持仓服务暂时不可用");
    expect(platform).toHaveTextContent("持仓暂不可用");
    expect(platform).toHaveTextContent("市值暂不可用");
    expect(screen.queryByText("这个平台暂无资产持仓")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("下一步：录入资产")).not.toBeInTheDocument();

    fireEvent.click(within(error).getByRole("button", { name: "重试读取账户持仓" }));
    expect(await screen.findByText("储蓄现金")).toBeInTheDocument();
    expect(platform).toHaveTextContent("1 项持仓");
    expect(platform).toHaveTextContent("¥123.00");
    expect(assetReads).toBe(2);
  });

  it("offers account retry without presenting a failed account list as empty", async () => {
    let accountReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/api/v2/meta") return response(meta);
      if (path === "/api/v2/assets") return response([]);
      if (path === "/api/v2/accounts") return ++accountReads === 1 ? failure("账户服务暂时不可用") : response([account]);
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderAccounts();

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("账户服务暂时不可用");
    expect(screen.queryByText("还没有账户")).not.toBeInTheDocument();
    fireEvent.click(within(error).getByRole("button", { name: "重试读取账户" }));
    const platform = (await screen.findByText("测试银行")).closest("button")!;
    expect(platform).toHaveTextContent("0 项持仓");
    expect(platform).toHaveTextContent("¥0.00");
    expect(accountReads).toBe(2);
  });

  it("explains unavailable form settings and enables add and edit after retry", async () => {
    let metaReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/api/v2/meta") return ++metaReads === 1 ? failure("币种设置读取失败") : response(meta);
      if (path === "/api/v2/accounts") return response([account]);
      if (path === "/api/v2/assets") return response([]);
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderAccounts();

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("币种设置读取失败");
    const add = screen.getByRole("button", { name: "添加账户" });
    expect(add).toBeDisabled();
    fireEvent.click((await screen.findByText("测试银行")).closest("button")!);
    const edit = screen.getByRole("button", { name: `修改 ${account.name}` });
    expect(edit).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(within(error).getByRole("button", { name: "重试读取账户设置" }));
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    expect(await screen.findByRole("dialog", { name: "编辑家庭账户" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(add);
    expect(await screen.findByRole("dialog", { name: "添加家庭账户" })).toBeInTheDocument();
    expect(metaReads).toBe(2);
  });

  it("offers archived-account retry instead of displaying an empty archive on failure", async () => {
    let archivedReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/api/v2/meta") return response(meta);
      if (path === "/api/v2/accounts" || path === "/api/v2/assets") return response([]);
      if (path === "/api/v2/accounts?archived=1") {
        return ++archivedReads === 1 ? failure("归档服务暂时不可用") : response([{ ...account, archived_at: "2026-10-19" }]);
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    renderAccounts();

    fireEvent.click(screen.getByRole("button", { name: "查看已归档" }));
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("归档服务暂时不可用");
    expect(screen.queryByText("没有已归档账户")).not.toBeInTheDocument();
    fireEvent.click(within(error).getByRole("button", { name: "重试读取已归档账户" }));
    expect(await screen.findByRole("button", { name: "恢复账户" })).toBeInTheDocument();
    expect(archivedReads).toBe(2);
  });

  it("refreshes the observed dashboard, account lists, settings and assets after archive and restore", async () => {
    let archived = false;
    vi.stubGlobal("confirm", vi.fn(() => true));
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v2/accounts/3" && init?.method === "DELETE") {
        archived = true;
        return response({});
      }
      if (path === "/api/v2/accounts/3/restore" && init?.method === "POST") {
        archived = false;
        return response(account);
      }
      if (path === "/api/v2/accounts") return response(archived ? [] : [account]);
      if (path === "/api/v2/accounts?archived=1") return response(archived ? [{ ...account, archived_at: "2026-10-19" }] : []);
      if (path === "/api/v2/meta") return response({ ...meta, accounts: archived ? [] : [account] });
      if (path === "/api/v2/assets") return response([]);
      if (path === "/api/v2/dashboard") return response({ accountCount: archived ? 0 : 1 });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = renderAccounts(true);

    await waitFor(() => expect(screen.getByLabelText("总览账户数")).toHaveTextContent("1"));
    fireEvent.click(screen.getByRole("button", { name: "查看已归档" }));
    expect(await screen.findByText("没有已归档账户")).toBeInTheDocument();
    fireEvent.click((await screen.findByText("测试银行")).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: `归档 ${account.name}` }));
    await waitFor(() => expect(screen.getByLabelText("总览账户数")).toHaveTextContent("0"));
    expect(await screen.findByRole("button", { name: "恢复账户" })).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData<MetaData>(["meta"])?.accounts).toEqual([]));

    fireEvent.click(screen.getByRole("button", { name: "恢复账户" }));
    await waitFor(() => expect(screen.getByLabelText("总览账户数")).toHaveTextContent("1"));
    expect(await screen.findByText("没有已归档账户")).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData<MetaData>(["meta"])?.accounts).toEqual([account]));
    for (const path of ["/api/v2/accounts", "/api/v2/accounts?archived=1", "/api/v2/meta", "/api/v2/assets", "/api/v2/dashboard"]) {
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === path)).toHaveLength(3);
    }
  });
});
