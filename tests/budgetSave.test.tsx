import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BudgetPage } from "../client/src/pages";
import { currentMonth, shiftMonth } from "../client/src/dateControls";
import type { HouseholdSummary, MetaData } from "../client/src/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("budget saving", () => {
  it("submits the edited amount and refreshes forecasts after saving or copying", async () => {
    const month = currentMonth();
    const meta: MetaData = {
      currencies: [{ id: 1, code: "CNY" }],
      assetTypes: [],
      categories: [{ id: 7, name: "家庭生活费", kind: "expense", color: "#123456", icon: "circle" }],
      accounts: [],
      accountTypes: [],
    };
    const summary: HouseholdSummary = {
      month,
      totals: { income: 0, expense: 0, net: 0, plannedExpense: 100, remainingBudget: 100 },
      navigation: { previousPlannedMonth: null, nextPlannedMonth: null },
      budgets: [{
        id: 1, categoryId: 7, categoryName: "家庭生活费", kind: "expense",
        color: "#123456", planned: 100, actual: 0, remaining: 100, percent: 0,
      }],
      recentTransactions: [],
      projects: [],
      memos: [],
    };
    const response = (data: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ data }),
    }) as Response;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v2/meta") return response(meta);
      if (path === `/api/v2/household/budgets?month=${month}`) return response(summary);
      if (path === "/api/v2/household/plan") return response(null);
      if (path === "/api/v2/household/budgets" && init?.method === "PUT") return response(summary);
      if (path === "/api/v2/household/budgets/copy" && init?.method === "POST") return response(summary);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["dashboard", month], { cached: true });
    queryClient.setQueryData(["dashboard-plans", month], { cached: true });
    render(
      <QueryClientProvider client={queryClient}>
        <BudgetPage privateMode={false} />
      </QueryClientProvider>,
    );

    const input = await screen.findByRole("spinbutton", { name: "预算" });
    expect(input).toHaveValue(100);
    fireEvent.change(input, { target: { value: "2800" } });
    fireEvent.click(screen.getByRole("button", { name: "保存该月预算" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        String(url) === "/api/v2/household/budgets" && init?.method === "PUT",
      )).toBe(true);
    });
    const request = fetchMock.mock.calls.find(([url, init]) =>
      String(url) === "/api/v2/household/budgets" && init?.method === "PUT",
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      month,
      items: [{ category_id: 7, planned_amount_cny: 2800 }],
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(["dashboard", month])?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(["dashboard-plans", month])?.isInvalidated).toBe(true);
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/v2/household/plan")).toHaveLength(2);
    });

    queryClient.setQueryData(["dashboard", month], { cached: true });
    queryClient.setQueryData(["dashboard-plans", month], { cached: true });
    fireEvent.click(screen.getByRole("button", { name: /复制/ }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        String(url) === "/api/v2/household/budgets/copy" && init?.method === "POST",
      )).toBe(true);
      expect(queryClient.getQueryState(["dashboard", month])?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(["dashboard-plans", month])?.isInvalidated).toBe(true);
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/v2/household/plan")).toHaveLength(3);
    });
  });

  it("hides the previous month's editable amounts while the next month loads", async () => {
    const month = currentMonth();
    const nextMonth = shiftMonth(month, 1);
    const meta: MetaData = {
      currencies: [{ id: 1, code: "CNY" }], assetTypes: [], accounts: [], accountTypes: [],
      categories: [{ id: 7, name: "家庭生活费", kind: "expense", color: "#123456", icon: "circle" }],
    };
    const summary = (selectedMonth: string, planned: number): HouseholdSummary => ({
      month: selectedMonth,
      totals: { income: 0, expense: 0, net: 0, plannedExpense: planned, remainingBudget: planned },
      navigation: { previousPlannedMonth: null, nextPlannedMonth: null },
      budgets: [{
        id: 1, categoryId: 7, categoryName: "家庭生活费", kind: "expense",
        color: "#123456", planned, actual: 0, remaining: planned, percent: 0,
      }],
      recentTransactions: [], projects: [], memos: [],
    });
    const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;
    let resolveNext!: (value: Response) => void;
    const nextResponse = new Promise<Response>((resolve) => { resolveNext = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/api/v2/meta") return response(meta);
      if (path === `/api/v2/household/budgets?month=${month}`) return response(summary(month, 100));
      if (path === `/api/v2/household/budgets?month=${nextMonth}`) return nextResponse;
      if (path === "/api/v2/household/plan") return response(null);
      throw new Error(`Unexpected request: ${path}`);
    }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BudgetPage privateMode={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("spinbutton", { name: "预算" })).toHaveValue(100);

    fireEvent.click(screen.getByRole("button", { name: "下一个月" }));
    expect(screen.queryByRole("spinbutton", { name: "预算" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存该月预算" })).toBeDisabled();

    await act(async () => { resolveNext(response(summary(nextMonth, 250))); });
    expect(await screen.findByRole("spinbutton", { name: "预算" })).toHaveValue(250);
  });

  it("keeps an unsaved amount visible when optional categories are collapsed", async () => {
    const month = currentMonth();
    const meta: MetaData = {
      currencies: [{ id: 1, code: "CNY" }], assetTypes: [], accounts: [], accountTypes: [],
      categories: [
        { id: 7, name: "家庭生活费", kind: "expense", color: "#123456", icon: "circle" },
        { id: 9, name: "娱乐", kind: "expense", color: "#654321", icon: "circle" },
      ],
    };
    const summary: HouseholdSummary = {
      month,
      totals: { income: 0, expense: 0, net: 0, plannedExpense: 0, remainingBudget: 0 },
      navigation: { previousPlannedMonth: null, nextPlannedMonth: null },
      budgets: meta.categories.map((category) => ({
        id: category.id, categoryId: category.id, categoryName: category.name,
        kind: "expense", color: category.color, planned: 0, actual: 0,
        remaining: 0, percent: 0,
      })),
      recentTransactions: [], projects: [], memos: [],
    };
    const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v2/meta") return response(meta);
      if (path === `/api/v2/household/budgets?month=${month}`) return response(summary);
      if (path === "/api/v2/household/plan") return response(null);
      if (path === "/api/v2/household/budgets" && init?.method === "PUT") return response(summary);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BudgetPage privateMode={false} />
      </QueryClientProvider>,
    );

    await screen.findByRole("spinbutton", { name: "预算" });
    expect(screen.queryByText("娱乐")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /显示全部分类/ }));
    const optionalRow = screen.getByText("娱乐").closest(".budget-edit-row") as HTMLElement;
    fireEvent.change(within(optionalRow).getByRole("spinbutton", { name: "预算" }), { target: { value: "345" } });
    fireEvent.click(screen.getByRole("button", { name: "收起可选分类" }));

    const preservedRow = screen.getByText("娱乐").closest(".budget-edit-row") as HTMLElement;
    expect(within(preservedRow).getByRole("spinbutton", { name: "预算" })).toHaveValue(345);
    fireEvent.click(screen.getByRole("button", { name: "保存该月预算" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === "/api/v2/household/budgets" && init?.method === "PUT",
    )).toBe(true));
    const saved = fetchMock.mock.calls.find(([url, init]) =>
      String(url) === "/api/v2/household/budgets" && init?.method === "PUT",
    );
    expect(JSON.parse(String(saved?.[1]?.body)).items).toContainEqual({ category_id: 9, planned_amount_cny: 345 });
  });
});
