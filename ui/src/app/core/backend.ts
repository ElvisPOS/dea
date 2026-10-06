import { ExecResult, Fleet, LogFile, Me } from './models';

/** Thrown when the session has expired: the app goes back to the login page. */
export class Unauthorized extends Error {
  constructor() {
    super('not logged in');
  }
}

/** What a terminal needs from its socket: a real WebSocket, or the mock's fake shell. */
export interface TermSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
}

/**
 * Everything the UI asks the server. HttpBackend talks to dea-server; MockBackend
 * (npm run mock) serves sample fleets so the UI can be checked without servers.
 */
export abstract class Backend {
  abstract login(user: string, password: string): Promise<void>;
  abstract logout(): Promise<void>;
  abstract me(): Promise<Me>;
  abstract fleet(): Promise<Fleet>;
  abstract forgetAgent(key: string): Promise<void>;
  abstract forgetStore(id: string): Promise<void>;
  abstract exec(keys: string[], cmd: string, timeout: number): Promise<ExecResult[]>;
  abstract logs(key: string): Promise<LogFile[]>;
  /** Streams a .tar.gz of the given files (null = all), reporting bytes received. */
  abstract downloadLogs(key: string, paths: string[] | null, progress: (bytes: number) => void): Promise<{ name: string; blob: Blob }>;
  abstract vncCheck(key: string): Promise<void>;
  abstract openTerminal(key: string, cols: number, rows: number): TermSocket;
  /** The VNC WebSocket URL, or null when screens are not available (mock). */
  abstract vncUrl(key: string): string | null;
}
