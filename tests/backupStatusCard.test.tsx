import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupStatusCard } from '../client/src/backupStatusCard';
import { api } from '../client/src/api';

function showCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><BackupStatusCard /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('backup status card', () => {
  it('shows an unverified initial state, rather than claiming a configured directory is healthy', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ configured: true, state: 'not_run', lastAttemptAt: null, lastSuccessAt: null, ageHours: null, freshnessHours: 36, lastError: null });
    showCard();
    expect(await screen.findByText('尚无已验证备份')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查备份状态' })).toBeInTheDocument();
    expect(screen.queryByText('最近备份已验证')).not.toBeInTheDocument();
  });

  it('makes stale backups visible', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ configured: true, state: 'stale', lastAttemptAt: null, lastSuccessAt: '2026-10-17T01:00:00Z', ageHours: 48, freshnessHours: 36, lastError: null });
    showCard();
    expect(await screen.findByText('备份已过期')).toBeInTheDocument();
    expect(screen.getByText(/48 小时前/)).toBeInTheDocument();
    expect(screen.getByText('需关注')).toBeInTheDocument();
  });

  it('shows a retry action when backup status cannot be read', async () => {
    const read = vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('connection failed'))
      .mockResolvedValue({ configured: true, state: 'not_run', lastAttemptAt: null, lastSuccessAt: null, ageHours: null, freshnessHours: 36, lastError: null });
    showCard();
    expect(await screen.findByText('状态暂时无法读取')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查备份状态' })).toBeInTheDocument();
    expect(screen.getByText('无法读取')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新检查备份状态' }));
    expect(await screen.findByText('尚无已验证备份')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
