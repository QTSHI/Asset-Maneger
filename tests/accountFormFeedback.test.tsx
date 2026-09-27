import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountsPage } from "../client/src/pages";
import type { MetaData } from "../client/src/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account edit feedback", () => {
  it("announces a conflict and keeps focus on the submit control while saving", async () => {
    const meta: MetaData = {
      currencies: [{ id: 1, code: "CNY" }],
      assetTypes: [],
      categories: [],
      accounts: [],
      accountTypes: [{ code: "bank", label: "银行账户" }],
    };
    const account = {
      id: 3,
      name: "测试银行 · 储蓄",
      account_type: "bank",
      default_currency_id: 1,
      currency_code: "CNY",
      asset_count: 0,
      market_value_cny: 0,
    };
    const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;
    let resolvePatch!: (value: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v2/meta") return response(meta);
      if (path === "/api/v2/accounts") return response([account]);
      if (path === "/api/v2/assets") return response([]);
      if (path === "/api/v2/accounts/3" && init?.method === "PATCH") return patchResponse;
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AccountsPage privateMode={false} />
      </QueryClientProvider>,
    );

    const platformName = await screen.findByText("测试银行");
    fireEvent.click(platformName.closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "修改 测试银行 · 储蓄" }));

    const dialog = await screen.findByRole("dialog", { name: "编辑家庭账户" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "重复账户" } });
    const submit = within(dialog).getByRole("button", { name: "保存" });
    submit.focus();
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toHaveAttribute("aria-disabled", "true"));
    expect(submit).toHaveFocus();
    fireEvent.click(submit);
    expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url) === "/api/v2/accounts/3" && init?.method === "PATCH",
    )).toHaveLength(1);

    await act(async () => {
      resolvePatch({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: "账户名称已存在" } }),
      } as Response);
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("账户名称已存在");
    expect(submit).toHaveFocus();
  });
});
