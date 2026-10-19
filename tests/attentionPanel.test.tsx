import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AttentionPanel } from '../client/src/attentionPanel';

const response = (data: unknown, status = 200) => ({
  ok: status < 400, status,
  json: async () => status < 400 ? { data } : { error: { message: data } },
}) as Response;

function show(privateMode = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><AttentionPanel privateMode={privateMode} /></MemoryRouter></QueryClientProvider>);
}

const issue = (id: number) => ({
  id: `asset:${id}:cash_stale`, kind: 'cash_stale', severity: 'medium',
  title: `待核对 ${id}`, description: '请核对实际余额。', actionLabel: '确认现金余额',
  href: `/assets?asset=${id}`, assetId: id, assetName: `私有资产 ${id}`, accountName: '家庭账户',
});
const data = (items: ReturnType<typeof issue>[]) => ({
  asOf: '2026-10-19T00:00:00.000Z', total: items.length,
  counts: { high: 0, medium: items.length, low: 0 }, items,
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('attention panel', () => {
  it('shows request failure with retry instead of an empty or healthy checklist', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1
      ? response('资产服务暂时不可用', 503) : response(data([issue(7)]))));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('资产服务暂时不可用');
    expect(screen.queryByText(/本次未发现/)).not.toBeInTheDocument();
    expect(screen.queryByText('0 项')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试读取待核对清单' }));
    expect(await screen.findByText('待核对 7')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '确认现金余额' })).toHaveAttribute('href', '/assets?asset=7');
  });

  it('keeps the list compact and expands the remaining prioritized issues', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(data([issue(1), issue(2), issue(3), issue(4)]))));
    show();
    const expand = await screen.findByRole('button', { name: '展开其余 1 项' });
    expect(screen.queryByText('待核对 4')).not.toBeInTheDocument();
    fireEvent.click(expand);
    expect(screen.getByText('待核对 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起清单' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '收起清单' }));
    expect(screen.queryByText('待核对 4')).not.toBeInTheDocument();
  });

  it('hides asset and account names in privacy mode while preserving useful action links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(data([issue(9)]))));
    show(true);
    expect(await screen.findByText('资产记录 · 信息已隐藏')).toBeInTheDocument();
    expect(screen.queryByText(/私有资产/)).not.toBeInTheDocument();
    expect(screen.queryByText(/家庭账户/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '确认现金余额' })).toHaveAttribute('href', '/assets?asset=9');
  });
});
