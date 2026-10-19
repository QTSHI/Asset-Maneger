import { useId, useState } from "react";
import { Download } from "lucide-react";

export function ExportButton({ kind, month, privateMode = false, disabled = false }: {
  kind: "accounts" | "assets" | "transactions";
  month?: string;
  privateMode?: boolean;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const feedbackId = useId();
  const label = kind === "accounts" ? "导出账户 CSV" : kind === "assets" ? "导出持仓 CSV"
    : month ? "导出本月收支 CSV" : "导出全部收支 CSV";
  const scope = kind === "accounts" ? "仅包含未归档账户"
    : kind === "assets" ? "仅包含未归档账户中的在用持仓；原币字段及缓存行情，缺失值留空"
    : `${month ? `${month} 的` : "全部日期的"}未归档收支；保留记账时汇率`;

  async function download() {
    setError("");
    setFinished(false);
    if (privateMode && !window.confirm("隐私模式只隐藏页面金额，CSV 文件会包含真实财务数据。确认下载并妥善保管文件吗？")) return;
    setPending(true);
    let objectUrl: string | undefined;
    try {
      const token = window.__USER__?.token || localStorage.getItem("sso_token") || "";
      const query = kind === "transactions" && month ? `?month=${encodeURIComponent(month)}` : "";
      const response = await fetch(`/api/v2/exports/${kind}.csv${query}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "text/csv", ...(token ? { "X-Auth-Token": token } : {}) },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error?.message || `请求失败 (${response.status})`);
      }
      if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/csv")) {
        throw new Error("未收到 CSV 文件，请确认登录状态后重试");
      }
      objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      const suffix = kind === "transactions" ? month || "all-dates" : "active";
      anchor.download = `stone-wealth-${kind}-${suffix}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setFinished(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "下载失败，请稍后重试");
    } finally {
      if (objectUrl) {
        // Give the browser time to start consuming the blob before releasing it.
        const downloadedUrl = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(downloadedUrl), 1000);
      }
      setPending(false);
    }
  }

  return <span className="export-action">
    <button className="secondary-button" type="button" onClick={download}
      disabled={disabled || pending} aria-busy={pending} title={scope}
      aria-describedby={feedbackId}>
      <Download size={15} aria-hidden="true" /> {pending ? "正在导出…" : label}
    </button>
    <span id={feedbackId} className="export-feedback">
      {error ? <small className="form-error" role="alert">导出失败：{error}</small>
        : finished ? <small role="status">下载已准备好；文件包含真实数据，请妥善保管。</small>
        : <small>{scope}</small>}
    </span>
  </span>;
}
