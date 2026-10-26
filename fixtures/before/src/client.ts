export interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
  retries?: number;
}

export type RequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export enum LogLevel {
  Debug,
  Info,
  Warn,
  Error,
}

function buildUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}

export class Client {
  readonly options: ClientOptions;
  private connected = false;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  request(method: RequestMethod, path: string): string {
    return `${method} ${buildUrl(this.options.baseUrl, path)}`;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
