import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { api } from "./api";

interface ArchivedRecord {
  id: number;
  code?: string;
  name?: string | null;
  shares?: number;
  asset_type_name?: string;
  valuation_mode?: string;
  imported_market_value?: number | null;
  kind?: "income" | "expense";
  note?: string | null;
  category_name?: string;
  occurred_on?: string;
  account_name: string | null;
  currency_code: string | null;
  amount?: number;
  archived_at: string;
  linked_cash_flow_id?: number | null;
  can_restore: boolean;
  restore_blocked_reason: string | null;
  flow_restore_blocked_reason?: string | null;
}

export function RecycleBin({ kind, privateMode }: {
  kind: "assets" | "transactions";
  privateMode: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState("");
  const client = useQueryClient();
  const isAsset = kind === "assets";
  const label = isAsset ? "资产回收站" : "收支回收站";
  const path = isAsset ? "/assets" : "/household/transactions";
  const archived = useQuery({
    queryKey: ["recycle-bin", kind],
    queryFn: () => api.get<ArchivedRecord[]>(`${path}/archived`),
    enabled: open,
  });
  const restore = useMutation({
    mutationFn: ({ row, recordOnly }: { row: ArchivedRecord; recordOnly: boolean }) =>
      api.post(`${path}/${row.id}/restore`, recordOnly ? { linked_action: "unlink" } : {}),
    onSuccess: async (_data, { row, recordOnly }) => {
      setRestored(isAsset
        ? `已恢复资产「${row.name || row.code}」`
        : recordOnly && row.linked_cash_flow_id
          ? "已恢复收支记录，原资金流保持原状且已解除关联"
          : row.linked_cash_flow_id ? "已恢复收支记录及关联资金流" : "已恢复收支记录");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["recycle-bin", kind] }),
        client.invalidateQueries({ queryKey: ["assets"] }),
        client.invalidateQueries({ queryKey: ["transactions"] }),
        client.invalidateQueries({ queryKey: ["accounts"] }),
        client.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
    },
  });
  const amount = (row: ArchivedRecord) => {
    if (privateMode) return "••••••";
    const isCurrencyAmount = !isAsset || row.asset_type_name === "cash" || row.valuation_mode === "position_value";
    if (!isCurrencyAmount) return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(row.shares ?? 0)} 份 / 单位`;
    const value = isAsset ? row.valuation_mode === "position_value" ? row.imported_market_value : row.shares : row.amount;
    if (value === null || value === undefined) return "金额待核对";
    if (!row.currency_code || !/^[A-Z]{3}$/.test(row.currency_code)) return `${value}（币种待核对）`;
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: row.currency_code }).format(value);
  };

  return <section className="recycle-bin" aria-label={label}>
    <button className="secondary-button" type="button" aria-expanded={open}
      aria-controls={`recycle-${kind}`} onClick={() => {
        setOpen(!open);
        setRestored("");
        restore.reset();
      }}>
      <Trash2 size={15} /> {open ? `收起${label}` : label}
    </button>
    {open && <div className="content-panel no-padding" id={`recycle-${kind}`}>
      <div className="detail-head"><div><span>误删恢复</span><h3>{label}</h3>
        <p>{isAsset ? "恢复后保留原资产记录；行情和估值按当前数据重新计算。" : "收支可单独恢复；如有关联资金流，请选择一并恢复或只恢复收支。"}</p>
      </div></div>
      {restored && <p className="recycle-feedback" role="status">{restored}</p>}
      {restore.error && <p className="form-error" role="alert">恢复失败：{restore.error.message}</p>}
      {archived.isPending ? <div className="state-card" role="status">正在读取回收站…</div>
        : archived.isError ? <div className="state-card" role="alert">
          <strong>暂时无法读取回收站</strong><span>{archived.error.message}</span>
          <button type="button" onClick={() => archived.refetch()}>重试读取回收站</button>
        </div> : !archived.data?.length ? <div className="state-card">回收站为空</div>
        : <div className="responsive-table"><table>
          <thead><tr><th>记录</th><th>账户</th><th>{isAsset ? "数量 / 原币金额" : "金额"}</th><th>归档时间</th><th>恢复</th></tr></thead>
          <tbody>{archived.data.map((row) => <tr key={row.id}>
            <td data-label="记录"><strong>{isAsset ? row.name || row.code : row.note || row.category_name}</strong>
              <small>{isAsset ? row.code : `${row.occurred_on} · ${row.kind === "income" ? "收入" : "支出"} · ${row.category_name}`}</small></td>
            <td data-label="账户">{row.account_name || "未关联账户"}</td>
            <td data-label={isAsset ? "数量 / 原币金额" : "金额"}>{amount(row)}</td>
            <td data-label="归档时间">{row.archived_at.slice(0, 16).replace("T", " ")}</td>
            <td data-label="恢复"><div className="recycle-actions">
              <button className="secondary-button" type="button"
                disabled={restore.isPending || !row.can_restore || Boolean(row.linked_cash_flow_id && row.flow_restore_blocked_reason)}
                onClick={() => { setRestored(""); restore.mutate({ row, recordOnly: false }); }}>
                <ArchiveRestore size={14} /> {row.linked_cash_flow_id ? "恢复收支及资金流" : isAsset ? "恢复资产" : "恢复收支"}
              </button>
              {!isAsset && row.linked_cash_flow_id && <button className="secondary-button" type="button"
                disabled={restore.isPending || !row.can_restore}
                onClick={() => { setRestored(""); restore.mutate({ row, recordOnly: true }); }}>仅恢复收支</button>}
              {(row.restore_blocked_reason || row.flow_restore_blocked_reason) &&
                <small>{row.restore_blocked_reason || row.flow_restore_blocked_reason}</small>}
              {!isAsset && row.linked_cash_flow_id && <small>仅恢复收支会解除关联，原资金流保持原状。</small>}
            </div></td>
          </tr>)}</tbody>
        </table></div>}
    </div>}
  </section>;
}
