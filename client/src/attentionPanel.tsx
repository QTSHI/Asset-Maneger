import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertCircle, ChevronDown, RefreshCw } from 'lucide-react';
import { api } from './api';
import './attentionPanel.css';

interface AttentionItem {
  id: string;
  kind: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  assetId?: number;
  accountId?: number;
  assetName?: string;
  accountName?: string;
}

interface AttentionData {
  asOf: string;
  total: number;
  counts: { high: number; medium: number; low: number };
  items: AttentionItem[];
}

export function AttentionPanel({ privateMode }: { privateMode: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const checklist = useQuery({
    queryKey: ['attention'],
    queryFn: () => api.get<AttentionData>('/attention'),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const data = checklist.data;
  const items = expanded ? data?.items : data?.items.slice(0, 3);
  const asOf = data?.asOf ? new Date(data.asOf) : null;

  return <section className="attention-panel" aria-label="待核对清单">
    <div className="attention-heading">
      <div><h3><AlertCircle size={17} /> 待核对清单{data && !checklist.isError && <span>{data.total} 项</span>}</h3>
        <p>先处理影响估值的缺失数据，再核对余额与同步。</p></div>
      <button className="secondary-button" type="button" disabled={checklist.isFetching}
        aria-label="刷新待核对清单" onClick={() => checklist.refetch()}>
        <RefreshCw size={14} className={checklist.isFetching ? 'spin' : ''} /><span>刷新</span>
      </button>
    </div>
    {checklist.isPending ? <p className="attention-state" role="status">正在检查资产数据…</p>
      : checklist.isError ? <div className="attention-state attention-error" role="alert">
        <strong>待核对清单暂时无法读取</strong><span>{checklist.error.message}</span>
        <button className="secondary-button" type="button" onClick={() => checklist.refetch()}>重试读取待核对清单</button>
      </div>
      : data && <>
        {data.total === 0 ? <p className="attention-state">本次未发现上述待核对项。请继续定期与账户原始记录核对。</p>
          : <ul className="attention-items">{items?.map((item) => <li key={item.id}>
            <span className={`attention-priority ${item.severity}`}>{item.severity === 'high' ? '优先处理' : '需要核对'}</span>
            <div className="attention-content"><strong>{item.title}</strong>
              <small>{privateMode ? item.assetId ? '资产记录 · 信息已隐藏' : '账户记录 · 信息已隐藏'
                : [item.assetName, item.accountName].filter(Boolean).join(' · ')}</small>
              <p>{item.description}</p></div>
            <Link to={item.href}>{item.actionLabel}<span aria-hidden="true"> →</span></Link>
          </li>)}</ul>}
        <div className="attention-footer">
          {asOf && Number.isFinite(asOf.getTime()) && <small>检查时间：{asOf.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</small>}
          {data.total > 3 && <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? '收起清单' : `展开其余 ${data.total - 3} 项`}<ChevronDown size={14} className={expanded ? 'rotated' : ''} />
          </button>}
        </div>
      </>}
  </section>;
}
