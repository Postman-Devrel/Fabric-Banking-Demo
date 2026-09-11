import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PairedRunReport } from './types.js';

export interface ReportSummary {
  id: string;
  createdAt: string;
  completedAt?: string;
  model: string;
  verified: boolean;
  replayable: boolean;
  state: string;
}

export class ReportStore {
  readonly directory: string;
  constructor(directory: string, private readonly maxReports: number) { this.directory = resolve(directory); }

  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid report ID');
    return join(this.directory, `${id}.json`);
  }

  async save(report: PairedRunReport): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.path(report.id);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    await this.prune();
  }

  async get(id: string): Promise<PairedRunReport | undefined> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as PairedRunReport; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<ReportSummary[]> {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    const reports = await Promise.all(names.map(async name => {
      const report = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as PairedRunReport;
      return {
        id: report.id, createdAt: report.createdAt, model: report.model, verified: report.verified,
        replayable: report.replayable, state: report.state,
        ...(report.completedAt ? { completedAt: report.completedAt } : {})
      };
    }));
    return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async prune(): Promise<void> {
    const files = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    const withTime = await Promise.all(files.map(async name => ({ name, mtime: (await stat(join(this.directory, name))).mtimeMs })));
    withTime.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(withTime.slice(this.maxReports).map(file => unlink(join(this.directory, file.name))));
  }
}
