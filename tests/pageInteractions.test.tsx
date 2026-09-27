import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransactionsPage } from "../client/src/pages";
import { currentMonth } from "../client/src/dateControls";
import type { HouseholdTransaction, MetaData } from "../client/src/types";

const meta: MetaData = {
  currencies: [{ id: 1, code: "CNY" }],
  assetTypes: [],
  categories: [
    { id: 7, name: "餐饮", kind: "expense", color: "#123456", icon: "circle" },
    { id: 8, name: "工资", kind: "income", color: "#654321", icon: "circle" },
    { id: 9, name: "交通", kind: "expense", color: "#abcdef", icon: "circle" },
  ],
  accounts: [],
  accountTypes: [],
};

const transactions: HouseholdTransaction[] = [
  {
    id: 1, kind: "expense", amount: 35, amount_cny: 35, currency_id: 1,
    fx_rate_to_cny: 1, currency_code: "CNY", category_id: 7,
    category_name: "餐饮", category_color: "#123456",
    occurred_on: `${currentMonth()}-05`, note: "午餐",
  },
  {
    id: 2, kind: "income", amount: 5000, amount_cny: 5000, currency_id: 1,
    fx_rate_to_cny: 1, currency_code: "CNY", category_id: 8,
    category_name: "工资", category_color: "#654321",
    occurred_on: `${currentMonth()}-06`, note: "工资到账",
  },
];

function renderTransactions() {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    const data = path === "/api/v2/meta"
      ? meta
      : path === `/api/v2/household/transactions?month=${currentMonth()}`
        ? transactions
        : undefined;
    if (data === undefined) throw new Error(`Unexpected request: ${path}`);
    return { ok: true, status: 200, json: async () => ({ data }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransactionsPage privateMode={false} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("page interactions", () => {
  it("filters the transaction table by category", async () => {
    renderTransactions();
    expect(await screen.findByText("午餐")).toBeInTheDocument();
    expect(screen.getByText("工资到账")).toBeInTheDocument();

    const filter = screen.getByRole("combobox", { name: "筛选分类" });
    fireEvent.change(filter, { target: { value: "7" } });
    expect(screen.getByText("午餐")).toBeInTheDocument();
    expect(screen.queryByText("工资到账")).not.toBeInTheDocument();
    expect(screen.getByText("筛选记录").nextElementSibling).toHaveTextContent("1");

    fireEvent.change(filter, { target: { value: "9" } });
    expect(screen.getByText("该分类暂无收支记录")).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: "" } });
    expect(screen.getByText("工资到账")).toBeInTheDocument();
  });

  it("keeps keyboard focus in a dialog and restores it when closed", async () => {
    renderTransactions();
    const trigger = await screen.findByRole("button", { name: "记一笔" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "记录家庭收支" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("spinbutton", { name: "金额" })).toHaveFocus();

    dialog.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "保存" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
