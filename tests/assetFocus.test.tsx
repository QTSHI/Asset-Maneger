import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AssetsPage } from "../client/src/pages";
import type { ValuedAsset } from "../client/src/types";

const asset: ValuedAsset = {
  id: 7, code: "FUND-7", name: "待核对基金", shares: 100, costPrice: 1,
  currentPrice: 1.2, quoteCode: "000007", quantityStatus: "estimated", valuationMode: "units",
  valuationBasis: "unit_price", currency: "CNY", marketValueCny: 120,
  costValueCny: 100, profitCny: 20, profitPercent: 20, accountId: 3,
  accountName: "测试银行 · 基金", assetTypeId: 1, assetType: "fund", classCode: "fund",
  classLabel: "基金", subtypeCode: "fund", subtypeLabel: "基金",
  quote: { status: "fresh" }, dataQuality: { status: "attention", label: "份额为估算值", issues: ["estimated_quantity"] },
};

function show(id: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => ({
    ok: true, status: 200, json: async () => ({ data: String(url) === "/api/v2/assets" ? [asset]
      : { currencies: [], assetTypes: [], categories: [], accounts: [{ id: 3 }], accountTypes: [] } }),
  } as Response)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/assets?asset=${id}`]}>
    <AssetsPage privateMode={false} />
  </MemoryRouter></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("attention asset navigation", () => {
  it("opens the correct consolidated fund and its holding from a direct asset link", async () => {
    show("7");
    expect(await screen.findByText("已定位资产：待核对基金")).toBeInTheDocument();
    const edit = await screen.findByRole("button", { name: "修改 待核对基金" });
    const row = edit.closest("tr")!;
    expect(row).toHaveClass("focused-asset-row");
    expect(within(row).getByText("份额为估算值")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消定位" }));
    expect(screen.queryByText("已定位资产：待核对基金")).not.toBeInTheDocument();
  });

  it("explains when a linked asset is no longer active", async () => {
    show("999");
    expect(await screen.findByText("该资产已归档或不存在，可查看回收站。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修改 待核对基金" })).not.toBeInTheDocument();
  });
});
