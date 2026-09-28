import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AgentPage from "../client/src/agentPage";

const meta = { currencies: [], assetTypes: [], categories: [], accounts: [], accountTypes: [] };
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;

function renderPage(privateMode = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><AgentPage privateMode={privateMode} /></QueryClientProvider>), client };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Agent authorization page", () => {
  it("shows field differences and requires an explicit second approval action", async () => {
    const proposal = {
      id: 7,
      assetId: 42,
      status: "pending",
      asset: { id: 42, code: "CASH-CNY", name: "现金" },
      agentKeyId: 3,
      agentLabel: "个人 Agent",
      changes: [{ field: "shares", before: 100, after: 120 }],
      createdAt: "2026-09-28 10:00:00",
      reviewedAt: null,
      reviewerUsername: null,
    };
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v2/agent/proposals?status=pending&pageSize=100") return response([proposal]);
      if (path === "/api/v2/agent/proposals?pageSize=25") return response([]);
      if (path === "/api/v2/agent/keys") return response([]);
      if (path === "/api/v2/meta") return response(meta);
      if (path === "/api/v2/agent/proposals/7/approve" && init?.method === "POST") return response({ ...proposal, status: "approved" });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderPage();
    expect(await screen.findByText("现金")).toBeInTheDocument();
    expect(screen.getByText("来自：个人 Agent")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "批准修改" }));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/approve"))).toHaveLength(0);
    view.rerender(<QueryClientProvider client={view.client}><AgentPage privateMode /></QueryClientProvider>);
    expect(screen.queryByText("100")).not.toBeInTheDocument();
    expect(screen.queryByText("120")).not.toBeInTheDocument();
    expect(screen.getAllByText("••••••")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "确认批准" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/approve"))).toHaveLength(1));
  });

  it("reveals a new key only in the current page session", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v2/agent/proposals?status=pending&pageSize=100" || path === "/api/v2/agent/proposals?pageSize=25") return response([]);
      if (path === "/api/v2/agent/keys" && !init?.method) return response([]);
      if (path === "/api/v2/meta") return response(meta);
      if (path === "/api/v2/agent/keys" && init?.method === "POST") {
        return response({ id: 3, label: "个人 Agent", tokenPrefix: "swag_abcd", token: "swag_only_once", createdAt: "2026-09-28T10:00:00Z", expiresAt: "2026-12-27T10:00:00Z", revokedAt: null, lastUsedAt: null });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderPage();
    fireEvent.change(await screen.findByRole("textbox", { name: "密钥名称" }), { target: { value: "个人 Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "创建密钥" }));
    const token = await screen.findByLabelText("新建密钥") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.value).toBe("swag_only_once");
    expect(JSON.stringify(localStorage)).not.toContain("swag_only_once");
    expect(view.client.getMutationCache().getAll().some((mutation) => String(JSON.stringify(mutation.state.data)).includes("swag_only_once"))).toBe(false);
    view.unmount();
    renderPage();
    expect(screen.queryByLabelText("新建密钥")).not.toBeInTheDocument();
  });
});
