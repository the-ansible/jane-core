import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class JsonlWriter {
  private currentHour: string = '';
  private currentPath: string = '';
  private eventsWritten: number = 0;
  private readonly baseDir: string;

  constructor(baseDir: string = '/agent/data/events/live') {
    this.baseDir = baseDir;
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getHourKey(date: Date = new Date()): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    return `${y}-${m}-${d}-${h}`;
  }

  write(event: unknown): string {
    const hourKey = this.getHourKey();

    if (hourKey !== this.currentHour) {
      this.currentHour = hourKey;
      this.currentPath = join(this.baseDir, `${hourKey}.jsonl`);
    }

    const line = JSON.stringify(event) + '\n';
    appendFileSync(this.currentPath, line, 'utf-8');
    this.eventsWritten++;

    return this.currentPath;
  }

  getStats() {
    return {
      currentFile: this.currentPath,
      currentHour: this.currentHour,
      eventsWritten: this.eventsWritten,
    };
  }
}
