import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCopy, KeyRound, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { api } from "./api";
import type { MetaData } from "./types";

type ProposalStatus = "pending" | "approved" | "rejected" | "conflicted";
type ReviewAction = "approve" | "reject";
type FieldValue = string | number | null;

interface AgentProposal {
  id: number;
  assetId: number;
  status: ProposalStatus;
  asset: { id: number; code: string; name: string };
  agentKeyId: number | null;
  agentLabel: string | null;
  changes: Array<{ field: string; before: FieldValue; after: FieldValue }>;
  createdAt: string;
  reviewedAt: string | null;
  reviewerUsername: string | null;
}

interface AgentKey {
  id: number;
  label: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

const fieldLabels: Record<string, string> = {
  platform_id: "所属账户",
  asset_type_id: "资产类型",
  code: "资产代码",
  name: "资产名称",
  shares: "数量 / 余额",
  cost_price: "成本单价",
  currency_id: "币种",
  quote_code: "行情代码",
  quantity_status: "数量状态",
  valuation_mode: "估值方式",
  imported_market_value: "录入市值",
  imported_cost_value: "录入成本",
  valuation_as_of: "估值日期",
};

const valueLabels: Record<string, Record<string, string>> = {
  quantity_status: { missing: "待确认", estimated: "估算", verified: "已确认" },
  valuation_mode: { units: "按数量和单价", position_value: "按持仓金额" },
};

const sensitiveFields = new Set([
  "shares",
  "cost_price",
  "imported_market_value",
  "imported_cost_value",
]);

function displayDate(value: string | null) {
  if (!value) return "尚无记录";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function displayFieldValue(field: string, value: FieldValue, meta: MetaData | undefined, privateMode: boolean) {
  if (value === null || value === "") return "未设置";
  if (privateMode && sensitiveFields.has(field)) return "••••••";
  if (field === "platform_id") return meta?.accounts.find((item) => item.id === Number(value))?.name || `账户 #${value}`;
  if (field === "asset_type_id") return meta?.assetTypes.find((item) => item.id === Number(value))?.name || `类型 #${value}`;
  if (field === "currency_id") return meta?.currencies.find((item) => item.id === Number(value))?.code || `币种 #${value}`;
  if (valueLabels[field]) return valueLabels[field][String(value)] || String(value);
  return typeof value === "number" ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 8 }).format(value) : String(value);
}

const statusLabels: Record<ProposalStatus, string> = {
  pending: "待你确认",
  approved: "已批准",
  rejected: "已拒绝",
  conflicted: "已失效",
};

function ProposalCard({
  proposal,
  meta,
  privateMode,
  review,
  busy,
  onReview,
  onCancel,
  onConfirm,
}: {
  proposal: AgentProposal;
  meta: MetaData | undefined;
  privateMode: boolean;
  review: ReviewAction | null;
  busy: boolean;
  onReview: (action: ReviewAction) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <article className="agent-proposal">
      <div className="agent-proposal-head">
        <div>
          <span className="agent-eyebrow">资产 #{proposal.asset.id} · {proposal.asset.code}</span>
          <h4>{proposal.asset.name}</h4>
          {proposal.agentLabel && <small className="agent-source">来自：{proposal.agentLabel}</small>}
          <small>提交于 {displayDate(proposal.createdAt)}</small>
        </div>
        <span className={`agent-status agent-status-${proposal.status}`}>{statusLabels[proposal.status]}</span>
      </div>
      <div className="agent-diff" aria-label={`${proposal.asset.name}的字段变更`}>
        <div className="agent-diff-heading"><span>修改字段</span><span>当前值</span><span>建议值</span></div>
        {proposal.changes.map((change) => (
          <div className="agent-diff-row" key={change.field}>
            <strong>{fieldLabels[change.field] || change.field}</strong>
            <span>{displayFieldValue(change.field, change.before, meta, privateMode)}</span>
            <b>{displayFieldValue(change.field, change.after, meta, privateMode)}</b>
          </div>
        ))}
      </div>
      {proposal.status === "pending" && (
        <>
          <div className="agent-proposal-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => onReview("reject")}><X size={15} /> 拒绝</button>
            <button className="primary-button" type="button" disabled={busy} onClick={() => onReview("approve")}><Check size={15} /> 批准修改</button>
          </div>
          {review && (
            <div className="agent-confirm" role="region" aria-label={review === "approve" ? "确认批准修改" : "确认拒绝修改"}>
              <strong>{review === "approve" ? "确认应用以上修改？" : "确认拒绝这项建议？"}</strong>
              <p>{review === "approve" ? "批准后，网站会核对资产当前值并执行修改。若资产已被其他操作改变，本次批准会失效。" : "拒绝后，此建议不会修改资产。"}</p>
              <div className="agent-confirm-actions">
                <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>返回查看</button>
                <button className={review === "approve" ? "primary-button" : "danger-button"} type="button" disabled={busy} onClick={onConfirm}>
                  {busy ? <RefreshCw className="spin" size={15} /> : review === "approve" ? <Check size={15} /> : <X size={15} />}
                  {busy ? "正在处理" : review === "approve" ? "确认批准" : "确认拒绝"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {proposal.status !== "pending" && (
        <p className="agent-reviewed-at">{proposal.status === "conflicted" ? "资产已有变化，请让 Agent 重新提交建议。" : `处理于 ${displayDate(proposal.reviewedAt)}${proposal.reviewerUsername ? ` · ${proposal.reviewerUsername}` : ""}`}</p>
      )}
    </article>
  );
}

function keyStatus(key: AgentKey) {
  if (key.revokedAt) return { label: "已停用", tone: "inactive" };
  if (new Date(key.expiresAt).getTime() <= Date.now()) return { label: "已过期", tone: "inactive" };
  return { label: "可使用", tone: "active" };
}

export default function AgentPage({ privateMode }: { privateMode: boolean }) {
  const queryClient = useQueryClient();
  const mcpEndpoint = import.meta.env.DEV ? "http://127.0.0.1:8080/mcp" : `${window.location.origin}/mcp`;
  const [reviewing, setReviewing] = useState<{ id: number; action: ReviewAction } | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [keyLabel, setKeyLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [oneTimeKey, setOneTimeKey] = useState<{ id: number; token: string } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [notice, setNotice] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [createKeyError, setCreateKeyError] = useState("");

  const pendingProposals = useQuery({
    queryKey: ["agent-proposals", "pending"],
    queryFn: () => api.get<AgentProposal[]>("/agent/proposals?status=pending&pageSize=100"),
    refetchInterval: 30_000,
  });
  const recentProposals = useQuery({
    queryKey: ["agent-proposals", "recent"],
    queryFn: () => api.get<AgentProposal[]>("/agent/proposals?pageSize=25"),
  });
  const keys = useQuery({ queryKey: ["agent-keys"], queryFn: () => api.get<AgentKey[]>("/agent/keys") });
  const meta = useQuery({ queryKey: ["meta"], queryFn: () => api.get<MetaData>("/meta"), staleTime: 300_000 });

  const reviewMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action: ReviewAction }) => api.post<AgentProposal>(`/agent/proposals/${id}/${action}`),
    onSuccess: (_, variables) => {
      setReviewing(null);
      setNotice(variables.action === "approve" ? "修改已批准并应用到资产。" : "建议已拒绝，资产没有变化。");
      queryClient.invalidateQueries({ queryKey: ["agent-proposals"] });
      if (variables.action === "approve") {
        queryClient.invalidateQueries({ queryKey: ["assets"] });
        queryClient.invalidateQueries({ queryKey: ["accounts"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ["agent-proposals"] }),
  });

  const revokeKey = useMutation({
    mutationFn: (id: number) => api.delete<void>(`/agent/keys/${id}`),
    onSuccess: (_, id) => {
      setRevokingId(null);
      if (oneTimeKey?.id === id) setOneTimeKey(null);
      setNotice("密钥已停用。");
      queryClient.invalidateQueries({ queryKey: ["agent-keys"] });
    },
  });

  const pending = pendingProposals.data || [];
  const history = (recentProposals.data || []).filter((item) => item.status !== "pending");

  async function submitKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = keyLabel.trim();
    if (!label || creatingKey) return;
    setNotice("");
    setCreateKeyError("");
    setCreatingKey(true);
    try {
      const key = await api.post<AgentKey & { token: string }>("/agent/keys", { label, expiresInDays });
      setOneTimeKey({ id: key.id, token: key.token });
      setShowKey(false);
      setKeyLabel("");
      setNotice("密钥已创建。请立即复制，离开此页后无法再次查看完整密钥。");
      queryClient.invalidateQueries({ queryKey: ["agent-keys"] });
    } catch (error) {
      setCreateKeyError(error instanceof Error ? error.message : "请求失败");
    } finally {
      setCreatingKey(false);
    }
  }

  async function copyKey() {
    if (!oneTimeKey) return;
    try {
      await navigator.clipboard.writeText(oneTimeKey.token);
      setNotice("密钥已复制到剪贴板。");
    } catch {
      setShowKey(true);
      setNotice("无法自动复制。请选中显示的密钥手动复制。");
    }
  }

  return (
    <div className="page-stack agent-page">
      <div className="page-head">
        <div><span>ACCESS & APPROVAL</span><h2>Agent 授权</h2><p>让 Agent 查询资产和提出修改建议；每项修改都由你在这里确认。</p></div>
      </div>

      <div className="agent-flow" aria-label="Agent 修改流程">
        <div><span>01</span><strong>查询资产</strong><small>通过授权密钥读取资产信息</small></div>
        <div><span>02</span><strong>提交建议</strong><small>按字段列出拟修改的内容</small></div>
        <div><span>03</span><strong>由你确认</strong><small>批准后网站才会执行修改</small></div>
      </div>

      {notice && <p className="agent-notice" role="status">{notice}</p>}

      <section className="content-panel agent-section" aria-labelledby="agent-proposals-title">
        <div className="content-panel-head">
          <div><h3 id="agent-proposals-title">待确认修改 {pending.length > 0 ? `· ${pending.length}` : ""}</h3><p>逐项核对当前值与建议值，再作决定。</p></div>
          <button className="secondary-button" type="button" onClick={() => { pendingProposals.refetch(); recentProposals.refetch(); }} disabled={pendingProposals.isFetching || recentProposals.isFetching}><RefreshCw className={pendingProposals.isFetching || recentProposals.isFetching ? "spin" : ""} size={15} /> 刷新</button>
        </div>
        {pendingProposals.isLoading && <p className="agent-message" role="status">正在加载修改建议…</p>}
        {pendingProposals.isError && <p className="form-error" role="alert">修改建议加载失败：{pendingProposals.error.message}</p>}
        {!pendingProposals.isLoading && !pendingProposals.isError && pending.length === 0 && <div className="agent-empty"><ShieldCheck size={28} /><strong>暂无待确认修改</strong><span>Agent 提交建议后会显示在这里。</span></div>}
        {reviewMutation.isError && <p className="form-error" role="alert">处理失败：{reviewMutation.error.message}。请刷新后核对资产状态。</p>}
        <div className="agent-proposals-list">
          {pending.map((item) => (
            <ProposalCard
              key={item.id}
              proposal={item}
              meta={meta.data}
              privateMode={privateMode}
              review={reviewing?.id === item.id ? reviewing.action : null}
              busy={reviewMutation.isPending}
              onReview={(action) => { setNotice(""); reviewMutation.reset(); setReviewing({ id: item.id, action }); }}
              onCancel={() => setReviewing(null)}
              onConfirm={() => { if (reviewing?.id === item.id) reviewMutation.mutate(reviewing); }}
            />
          ))}
        </div>
        {recentProposals.isError && <p className="form-error" role="alert">最近记录加载失败：{recentProposals.error.message}</p>}
        {history.length > 0 && <details className="agent-history"><summary>查看最近已处理建议 · {history.length}</summary><div className="agent-proposals-list">{history.map((item) => <ProposalCard key={item.id} proposal={item} meta={meta.data} privateMode={privateMode} review={null} busy={false} onReview={() => {}} onCancel={() => {}} onConfirm={() => {}} />)}</div></details>}
      </section>

      <section className="content-panel agent-section" aria-labelledby="agent-keys-title">
        <div className="content-panel-head"><div><h3 id="agent-keys-title">Agent 密钥</h3><p>每个 Agent 使用独立密钥；你可以随时停用。</p></div><KeyRound size={20} /></div>
        <form className="agent-key-form" onSubmit={submitKey}>
          <label><span>名称</span><input aria-label="密钥名称" value={keyLabel} onChange={(event) => setKeyLabel(event.target.value)} placeholder="例如：我的个人 Agent" maxLength={80} required /></label>
          <label><span>有效期</span><select aria-label="密钥有效期" value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>365 天</option></select></label>
          <button className="primary-button" type="submit" disabled={creatingKey}><KeyRound size={15} /> {creatingKey ? "正在创建" : "创建密钥"}</button>
        </form>
        <div className="agent-connection"><strong>Agent 接入地址</strong><code>{mcpEndpoint}</code><span>在服务端 Agent 客户端选择 Streamable HTTP，并用新建密钥作为 Bearer 授权令牌。</span></div>
        {createKeyError && <p className="form-error" role="alert">创建失败：{createKeyError}</p>}
        {oneTimeKey && <div className="agent-key-reveal" role="region" aria-label="新建 Agent 密钥"><strong>完整密钥仅显示这一次</strong><p>复制后保存在受信任的 Agent 连接设置中。Agent 可读取资产并提交建议，但修改仍需你批准。</p><div className="agent-token-row"><input aria-label="新建密钥" readOnly type={showKey ? "text" : "password"} value={oneTimeKey.token} onFocus={(event) => event.currentTarget.select()} /><button className="secondary-button" type="button" onClick={() => setShowKey((value) => !value)}>{showKey ? "隐藏" : "显示"}</button><button className="primary-button" type="button" onClick={copyKey}><ClipboardCopy size={15} /> 复制</button></div><button className="agent-dismiss" type="button" onClick={() => setOneTimeKey(null)}>我已保存，关闭密钥</button></div>}
        {keys.isLoading && <p className="agent-message" role="status">正在加载密钥…</p>}
        {keys.isError && <p className="form-error" role="alert">密钥列表加载失败：{keys.error.message}</p>}
        {!keys.isLoading && !keys.isError && keys.data?.length === 0 && <p className="agent-message">还没有 Agent 密钥。</p>}
        {revokeKey.isError && <p className="form-error" role="alert">停用失败：{revokeKey.error.message}</p>}
        <div className="agent-key-list">
          {(keys.data || []).map((key) => {
            const status = keyStatus(key);
            return <article className="agent-key-item" key={key.id}><div className="agent-key-info"><div><strong>{key.label}</strong><span className={`agent-status agent-status-${status.tone}`}>{status.label}</span></div><small>前缀 {key.tokenPrefix} · 创建于 {displayDate(key.createdAt)} · 到期 {displayDate(key.expiresAt)}</small><small>上次使用：{displayDate(key.lastUsedAt)}</small></div>{!key.revokedAt && <div className="agent-key-actions">{revokingId === key.id ? <><span>确定停用？</span><button className="secondary-button" type="button" disabled={revokeKey.isPending} onClick={() => setRevokingId(null)}>取消</button><button className="danger-button" type="button" disabled={revokeKey.isPending} onClick={() => revokeKey.mutate(key.id)}>确定停用</button></> : <button className="secondary-button" type="button" disabled={revokeKey.isPending} onClick={() => setRevokingId(key.id)}><Trash2 size={14} /> 停用</button>}</div>}</article>;
          })}
        </div>
      </section>
    </div>
  );
}
