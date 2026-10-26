export interface ClientOptions {
  baseUrl: string;
  retries?: number;
  userAgent?: string;
}

export type RequestMethod = 'GET' | 'POST' | 'PUT';

export enum LogLevel {
  Debug,
  Info,
  Warn,
  Error,
  Fatal,
}

// Internal helper rewritten; it is not exported, so this is not an API change.
function buildUrl(base: string, path: string): string {
  const url = new URL(path, base.endsWith('/') ? base : base + '/');
  return url.toString();
}

export class Client {
  readonly options: ClientOptions;
  private connected = false;
  private connectCount = 0;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    this.connected = true;
    this.connectCount++;
    return Promise.resolve();
  }

  request(method: RequestMethod, path: string): string {
    return `${method} ${buildUrl(this.options.baseUrl, path)}`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ping(): boolean {
    return this.connected && this.connectCount > 0;
  }
}
