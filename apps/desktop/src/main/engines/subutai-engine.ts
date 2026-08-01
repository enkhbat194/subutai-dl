import { Aria2Service, type Aria2TaskStatus } from './aria2-service';

export type SubutaiTaskStatus = Aria2TaskStatus;

export class SubutaiEngine {
  private readonly directEngine = new Aria2Service();

  async addDownload(options: {
    url: string;
    destination: string;
    filename?: string;
    connections: number;
  }): Promise<string> {
    const directOptions: {
      destination: string;
      filename?: string;
      connections: number;
    } = {
      destination: options.destination,
      connections: options.connections,
    };
    if (options.filename) directOptions.filename = options.filename;
    return this.directEngine.addUri(options.url, directOptions);
  }

  async getStatus(taskId: string): Promise<SubutaiTaskStatus> {
    return this.directEngine.tellStatus(taskId);
  }

  async pause(taskId: string): Promise<void> {
    await this.directEngine.pause(taskId);
  }

  async resume(taskId: string): Promise<void> {
    await this.directEngine.resume(taskId);
  }

  async cancel(taskId: string): Promise<void> {
    await this.directEngine.cancel(taskId);
  }

  async stop(): Promise<void> {
    await this.directEngine.stop();
  }

  getHealth(): {
    available: boolean;
    running: boolean;
    version?: string;
    error?: string;
  } {
    const health = this.directEngine.getHealth();
    const result: {
      available: boolean;
      running: boolean;
      version?: string;
      error?: string;
    } = {
      available: health.available,
      running: health.running,
    };
    if (health.version) result.version = health.version;
    if (health.error) result.error = this.toPublicError(health.error);
    return result;
  }

  private toPublicError(message: string): string {
    return message
      .replaceAll(/aria2c/gi, 'Subutai Engine')
      .replaceAll(/aria2/gi, 'Subutai Engine');
  }
}
