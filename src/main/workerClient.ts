import { BrowserWindow } from 'electron';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ImportProgress, JobProgress } from '@shared/types';
import type { AppPaths } from './paths';

type WorkerRole = 'metadata' | 'query' | 'import';

interface PendingRequest {
  role: WorkerRole;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class DatabaseWorkerClient {
  private readonly workers = new Map<WorkerRole, Worker>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly jobStates = new Map<string, JobProgress>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly paths: AppPaths,
    private readonly mainWindow: BrowserWindow
  ) {
    this.startWorker('metadata');
  }

  invoke<T>(action: string, payload?: unknown): Promise<T> {
    const role = roleForAction(action);
    const worker = this.workers.get(role) ?? this.startWorker(role);
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { role, resolve: resolve as (value: unknown) => void, reject });
      try {
        worker.postMessage({ id, action, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  cancelCurrentJob(): Promise<void> {
    return Promise.all(Array.from(this.workers.keys()).map((role) => this.cancelRole(role))).then(() => undefined);
  }

  cancelImportJob(): Promise<void> {
    return this.cancelRole('import');
  }

  cancelJob(jobId: string): Promise<void> {
    const role = jobId.split(':')[0] as WorkerRole;
    if (role !== 'metadata' && role !== 'query' && role !== 'import') return Promise.resolve();
    return this.cancelRole(role);
  }

  getJobState(jobId: string): JobProgress | null {
    return this.jobStates.get(jobId) ?? null;
  }

  close(): void {
    this.closed = true;
    for (const worker of this.workers.values()) void worker.terminate();
    this.workers.clear();
    this.rejectAll(new Error('DB worker가 닫혔습니다.'));
  }

  private startWorker(role: WorkerRole): Worker {
    const worker = new Worker(path.join(__dirname, 'dbWorker.js'), {
      workerData: { paths: this.paths, role }
    });
    this.workers.set(role, worker);

    worker.on('message', (message: any) => {
      if (message.type === 'progress') {
        if (!this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('import:progress', message.progress as ImportProgress);
        }
        return;
      }

      if (message.type === 'jobProgress') {
        const progress = message.progress as JobProgress;
        this.jobStates.set(progress.jobId, progress);
        if (!this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('job:progress', progress);
        }
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(errorMessage(message.error)));
    });

    worker.on('error', (error) => {
      this.rejectRole(role, error);
    });

    worker.on('exit', (code) => {
      if (this.workers.get(role) === worker) this.workers.delete(role);
      if (!this.closed && code !== 0) {
        this.rejectRole(role, new Error(`DB worker가 종료되었습니다. 역할: ${role}, 코드: ${code}`));
      }
    });

    return worker;
  }

  private cancelRole(role: WorkerRole): Promise<void> {
    const worker = this.workers.get(role);
    if (!worker) return Promise.resolve();
    const id = this.nextId++;

    return new Promise<void>((resolve) => {
      const hardCancelTimer = setTimeout(() => {
        if (this.workers.get(role) === worker) {
          this.rejectRole(role, new Error('작업이 중지되었습니다.'));
          this.workers.delete(role);
          void worker.terminate().finally(() => {
            if (!this.closed) this.startWorker(role);
            resolve();
          });
          return;
        }
        resolve();
      }, 1500);
      hardCancelTimer.unref?.();

      this.pending.set(id, {
        role,
        resolve: () => {
          clearTimeout(hardCancelTimer);
          resolve();
        },
        reject: () => {
          clearTimeout(hardCancelTimer);
          resolve();
        }
      });

      try {
        worker.postMessage({ id, action: 'cancelCurrentJob' });
      } catch {
        clearTimeout(hardCancelTimer);
        this.pending.delete(id);
        resolve();
      }
    });
  }

  private rejectRole(role: WorkerRole, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.role !== role) continue;
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function roleForAction(action: string): WorkerRole {
  if (action === 'getState' || action === 'exploreTree' || action === 'listDocuments' || action === 'getDocument') return 'metadata';
  if (action === 'deleteCorpus') return 'metadata';
  if (action === 'importDefault' || action === 'importSources' || action === 'rebuildCorpus') return 'import';
  return 'query';
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    const maybe = value as { message?: unknown; error?: unknown };
    if (typeof maybe.message === 'string' && maybe.message.trim()) return maybe.message;
    if (typeof maybe.error === 'string' && maybe.error.trim()) return maybe.error;
    try {
      return JSON.stringify(value);
    } catch {
      return '작업에 실패했습니다.';
    }
  }
  return '작업에 실패했습니다.';
}
