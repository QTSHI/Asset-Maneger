import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AssetsPage, TransactionsPage } from "../client/src/pages";
import { currentMonth } from "../client/src/dateControls";
import type { MetaData } from "../client/src/types";

const meta: MetaData = {
  currencies: [{ id: 1, code: "CNY" }],
  assetTypes: [],
  categories: [],
  accounts: [],
  accountTypes: [],
};

const response = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ data }),
}) as Response;

const failedResponse = (message: string) => ({
  ok: false,
  status: 503,
  json: async () => ({ error: { message } }),
}) as Response;

function renderPage(page: "assets" | "transactions") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {page === "assets"
          ? <AssetsPage privateMode={false} />
          : <TransactionsPage privateMode={false} />}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("data loading feedback", () => {
  it("keeps an asset read failure distinct from an empty household and recovers on retry", async () => {
    let assetReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === "/api/v2/meta") return response(meta);
      if (String(url) === "/api/v2/assets") {
        assetReads += 1;
        return assetReads === 1 ? failedResponse("资产服务暂时不可用") : response([]);
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }));

    renderPage("assets");

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("资产服务暂时不可用");
    expect(screen.queryByText("还没有资产")).not.toBeInTheDocument();
    expect(screen.queryByText("没有匹配的资产")).not.toBeInTheDocument();
    fireEvent.click(within(error).getByRole("button", { name: "重试读取资产" }));
    expect(await screen.findByText("先添加一个账户")).toBeInTheDocument();
    expect(assetReads).toBe(2);
  });

  it("does not show zero totals or no records when transaction loading fails, then restores the empty state", async () => {
    let transactionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === "/api/v2/meta") return response(meta);
      if (String(url) === `/api/v2/household/transactions?month=${currentMonth()}`) {
        transactionReads += 1;
        return transactionReads === 1 ? failedResponse("收支服务暂时不可用") : response([]);
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }));

    renderPage("transactions");

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("收支服务暂时不可用");
    expect(screen.queryByText("该月收入")).not.toBeInTheDocument();
    expect(screen.queryByText("这个月还没有收支记录")).not.toBeInTheDocument();
    fireEvent.click(within(error).getByRole("button", { name: "重试读取收支记录" }));
    expect(await screen.findByText("这个月还没有收支记录")).toBeInTheDocument();
    expect(screen.getByText("该月收入")).toBeInTheDocument();
    expect(transactionReads).toBe(2);
  });
});
