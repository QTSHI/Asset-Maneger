import { useQuery } from "@tanstack/react-query";
import { DatabaseBackup } from "lucide-react";
import { api } from "./api";

export interface BackupStatus {
  configured: boolean;
  state: "unconfigured" | "not_run" | "running" | "healthy" | "stale" | "failed";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  ageHours: number | null;
  freshnessHours: number;
  lastError: string | null;
}

const titles: Record<BackupStatus["state"], string> = {
  unconfigured: "等待配置备份",
  not_run: "尚无已验证备份",
  running: "正在备份并验证",
  healthy: "最近备份已验证",
  stale: "备份已过期",
  failed: "备份需要处理",
};
const descriptions: Record<BackupStatus["state"], string> = {
  unconfigured: "请管理员配置每日备份任务，并完成一次备份验证。",
  not_run: "当前数据库尚无通过恢复验证的备份，请管理员运行备份任务。",
  running: "只有独立恢复副本通过检查，才会记录本次备份成功。",
  healthy: "最近快照已通过独立恢复检查；异地副本需由管理员另行保管。",
  stale: "最近验证成功已超过备份有效期限，请管理员检查定时任务。",
  failed: "请管理员检查任务日志；已有备份会保留。",
};

export function BackupStatusCard() {
  const backup = useQuery({
    queryKey: ["backup-status"],
    queryFn: () => api.get<BackupStatus>("/backup/status"),
    refetchInterval: 60_000,
  });
  const status = backup.data;
  const warning = backup.isError || status?.state === "failed" || status?.state === "stale";
  const healthy = !backup.isError && status?.state === "healthy";
  return (
    <article className="status-card">
      <div className={`status-icon ${warning ? "warning" : healthy ? "healthy" : "neutral"}`}>
        <DatabaseBackup />
      </div>
      <div>
        <span>数据库备份</span>
        <h3>{backup.isError ? "状态暂时无法读取" : status ? titles[status.state] : "正在检查备份"}</h3>
        <p>{backup.isError ? "请重试读取备份状态。" : status?.lastError || (status ? descriptions[status.state] : "正在核对最近备份记录。")}</p>
        {status?.lastAttemptAt && <p>最近尝试：{new Date(status.lastAttemptAt).toLocaleString("zh-CN")}</p>}
        {status?.lastSuccessAt && <p>最近验证成功：{new Date(status.lastSuccessAt).toLocaleString("zh-CN")} · {status.ageHours ?? 0} 小时前</p>}
        {status && <p>备份有效期限：{status.freshnessHours} 小时</p>}
        <button className="secondary-button compact-button" disabled={backup.isFetching} onClick={() => void backup.refetch()}>
          {backup.isFetching ? "正在检查" : "重新检查备份状态"}
        </button>
      </div>
      <b className={`status ${warning ? "error" : healthy ? "fresh" : "missing"}`}>
        {backup.isError ? "无法读取" : healthy ? "已验证" : status?.state === "running" ? "备份中" : warning ? "需关注" : "待验证"}
      </b>
    </article>
  );
}
