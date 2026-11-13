/** 顶栏条数刷新：增删答案 / 资料后通知 Shell 重新拉 stats。 */
export const REFRESH_COUNTS_EVENT = 'kefu:refresh-counts';

export function refreshCounts(): void {
  try {
    window.dispatchEvent(new Event(REFRESH_COUNTS_EVENT));
  } catch {
    /* 忽略 */
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '出了点问题';
}
