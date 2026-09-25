export interface PopupBackgroundStatus {
  success?: boolean;
  connected?: boolean;
  serverStatus?: { isRunning?: boolean; port?: number };
}

export interface PopupPingStatus {
  ok: boolean;
  status?: string;
  browserId?: string;
  port?: number;
}

export function isPopupConnectionHealthy(
  background: PopupBackgroundStatus | null | undefined,
  ping: PopupPingStatus | null | undefined,
  browserId: string,
  port: number,
): boolean {
  return Boolean(
    background?.success &&
    background.connected &&
    background.serverStatus?.isRunning === true &&
    background.serverStatus.port === port &&
    ping?.ok &&
    ping.status === 'ok' &&
    ping.browserId === browserId &&
    ping.port === port,
  );
}
