import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportButton } from "../client/src/exportButton";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  delete window.__USER__;
});

describe("CSV download action", () => {
  it("requires deliberate confirmation in privacy mode and sends no request when cancelled", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportButton kind="assets" privateMode />);
    fireEvent.click(screen.getByRole("button", { name: "导出持仓 CSV" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("真实财务数据"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/原币字段及缓存行情，缺失值留空/)).toBeInTheDocument();
  });

  it("authenticates the month-filtered download, prevents duplicates and releases its blob URL", async () => {
    window.__USER__ = { username: "test", is_admin: false, token: "window-token" };
    vi.stubGlobal("confirm", vi.fn(() => true));
    let resolveResponse!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:download");
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ExportButton kind="transactions" month="2033-03" privateMode />);
    fireEvent.click(screen.getByRole("button", { name: "导出本月收支 CSV" }));
    expect(screen.getByRole("button", { name: "正在导出…" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/exports/transactions.csv?month=2033-03", expect.objectContaining({
      cache: "no-store", credentials: "same-origin", headers: { Accept: "text/csv", "X-Auth-Token": "window-token" },
    }));
    await act(async () => {
      resolveResponse({ ok: true, headers: new Headers({ "Content-Type": "text/csv; charset=utf-8" }), blob: async () => new Blob(["csv"]) } as Response);
    });
    expect(await screen.findByRole("status")).toHaveTextContent("下载已准备好");
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download]')).toBeNull();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:download"), { timeout: 1500 });
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("uses the compatible legacy token and displays a retryable server error", async () => {
    localStorage.setItem("sso_token", "stored-token");
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "导出服务暂不可用" } }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportButton kind="accounts" />);
    fireEvent.click(screen.getByRole("button", { name: "导出账户 CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("导出服务暂不可用");
    expect(screen.getByRole("button", { name: "导出账户 CSV" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/exports/accounts.csv", expect.objectContaining({
      headers: { Accept: "text/csv", "X-Auth-Token": "stored-token" },
    }));
  });

  it("rejects an expired-login HTML response instead of saving it as financial CSV", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers({ "Content-Type": "text/html" }) })));
    render(<ExportButton kind="assets" />);
    fireEvent.click(screen.getByRole("button", { name: "导出持仓 CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请确认登录状态后重试");
  });
});
