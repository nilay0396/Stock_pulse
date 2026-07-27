declare module "kiteconnect" {
  export type Tick = Record<string, any>;

  export interface Connect {
    setAccessToken(token: string): void;
    generateSession(requestToken: string, apiSecret: string): Promise<{ access_token: string }>;
    getQuote(keys: string[]): Promise<Record<string, any>>;
    getInstruments(exchange?: string): Promise<any[]>;
    getHistoricalData(
      instrumentToken: number,
      interval: string,
      fromDate: string,
      toDate: string,
    ): Promise<any[]>;
  }

  export class KiteConnect implements Connect {
    constructor(params: { api_key: string });
    setAccessToken(token: string): void;
    generateSession(requestToken: string, apiSecret: string): Promise<{ access_token: string }>;
    getQuote(keys: string[]): Promise<Record<string, any>>;
    getInstruments(exchange?: string): Promise<any[]>;
    getHistoricalData(
      instrumentToken: number,
      interval: string,
      fromDate: string,
      toDate: string,
    ): Promise<any[]>;
  }

  export class KiteTicker {
    modeFull: string;
    constructor(params: { api_key: string; access_token: string; reconnect?: boolean; max_retry?: number; max_delay?: number });
    connect(): void;
    disconnect(): void;
    subscribe(tokens: number[]): void;
    unsubscribe(tokens: number[]): void;
    setMode(mode: string, tokens: number[]): void;
    on(event: "connect" | "noreconnect", handler: () => void): void;
    on(event: "ticks", handler: (ticks: Tick[]) => void): void;
    on(event: "reconnect", handler: (count: number, interval: number) => void): void;
    on(event: "disconnect" | "error", handler: (err?: Error) => void): void;
  }
}
