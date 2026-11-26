// 本机无网络时的最小 Node.js 类型声明；仅覆盖后端编译所用 API。
declare module 'node:child_process' {
  export type ChildProcessWithoutNullStreams = any;
  export function spawn(command: string, args?: string[], options?: any): ChildProcessWithoutNullStreams;
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): any;
    digest(encoding: 'hex'): string;
  };
  export function randomUUID(): string;
}

declare module 'node:buffer' {
  export class Buffer extends Uint8Array {
    static from(value: string | Uint8Array): Buffer;
    static concat(values: Uint8Array[]): Buffer;
    static byteLength(value: string, encoding?: string): number;
    toString(encoding?: string): string;
  }
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function realpathSync(path: string): string;
  export function statSync(path: string): { size: number; isFile(): boolean };
}

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export class StatementSync {
    all(...values: unknown[]): unknown[];
    get(...values: unknown[]): unknown;
    run(...values: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function realpath(path: string): Promise<string>;
  export function rm(path: string, options?: any): Promise<void>;
  export function stat(path: string): Promise<{ size: number; isFile(): boolean }>;
  export function writeFile(path: string, data: string, encoding?: 'utf8'): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
  export function pathToFileURL(path: string): URL;
}

declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly execPath: string;
  readonly platform: string;
  readonly argv: string[];
  stdout: { write(data: string): boolean };
  stderr: { write(data: string): boolean };
  exitCode?: number;
  kill?(pid: number, signal?: string): void;
};
