import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecycleBin } from "../client/src/recycleBin";

const response = (data: unknown, status = 200) => ({
  ok: status < 400, status,
  json: async () => status < 400 ? { data } : { error: { message: data } },
}) as Response;

function show(kind: "assets" | "transactions", privateMode = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RecycleBin kind={kind} privateMode={privateMode} /></QueryClientProvider>);
  return client;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("recycle bin recovery", () => {
  it("retries a failed read and restores an asset without re-entering its values", async () => {
    let reads = 0;
    let restored = false;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { restored = true; return response({ id: 12 }); }
      reads += 1;
      if (reads === 1) return response("暂时无法读取", 503);
      return response(restored ? [] : [{
        id: 12, code: "CASH-12", name: "误删的现金", shares: 150, asset_type_name: "cash",
        account_name: "家庭银行", currency_code: "CNY", archived_at: "2026-10-18 10:00:00",
        can_restore: true, restore_blocked_reason: null,
      }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    show("assets");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "资产回收站" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
    expect(screen.queryByText("回收站为空")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试读取回收站" }));
    expect(await screen.findByText("误删的现金")).toBeInTheDocument();
    expect(screen.getByText(/150\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复资产" }));
    expect(await screen.findByText("回收站为空")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已恢复资产");
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/assets/12/restore", expect.objectContaining({ method: "POST", body: "{}" }));
  });

  it("explains blocked assets and hides financial details in privacy mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{
      id: 13, code: "TEST", name: "同步资产", shares: 9876,
      account_name: "同步账户", currency_code: "GBP", archived_at: "2026-10-18 10:00:00",
      can_restore: false, restore_blocked_reason: "该资产由同步管理，请重新同步",
    }])));
    show("assets", true);
    fireEvent.click(screen.getByRole("button", { name: "资产回收站" }));
    expect(await screen.findByText("该资产由同步管理，请重新同步")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复资产" })).toBeDisabled();
    expect(screen.getByText("••••••")).toBeInTheDocument();
    expect(screen.queryByText(/9,876/)).not.toBeInTheDocument();
  });

  it("lets a user restore a linked transaction alone when joint flow recovery is unsafe", async () => {
    let restored = false;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { restored = true; return response({ id: 7 }); }
      return response(restored ? [] : [{
        id: 7, kind: "expense", note: "生活支出", category_name: "日用", amount: 45,
        account_name: "家庭银行", currency_code: "CNY", occurred_on: "2026-10-17",
        archived_at: "2026-10-18 10:00:00", linked_cash_flow_id: 8,
        can_restore: true, restore_blocked_reason: null,
        flow_restore_blocked_reason: "关联资金流已发生变化，请仅恢复收支",
      }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    show("transactions");
    fireEvent.click(screen.getByRole("button", { name: "收支回收站" }));
    const row = (await screen.findByText("生活支出")).closest("tr")!;
    expect(within(row).getByRole("button", { name: "恢复收支及资金流" })).toBeDisabled();
    fireEvent.click(within(row).getByRole("button", { name: "仅恢复收支" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v2/household/transactions/7/restore",
      expect.objectContaining({ method: "POST", body: '{"linked_action":"unlink"}' }),
    ));
    expect(await screen.findByText("回收站为空")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("原资金流保持原状且已解除关联");
  });

  it("keeps damaged historical records visible with a blocked reason instead of crashing on a missing currency", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{
      id: 8, kind: "expense", note: "历史记录", category_name: "日用", amount: 45,
      account_name: null, currency_code: null, occurred_on: "2026-10-17",
      archived_at: "2026-10-18 10:00:00", can_restore: false,
      restore_blocked_reason: "该记录的币种已不存在，请先核对基础数据",
    }])));
    show("transactions");
    fireEvent.click(screen.getByRole("button", { name: "收支回收站" }));
    expect(await screen.findByText("45（币种待核对）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复收支", exact: true })).toBeDisabled();
  });
});
