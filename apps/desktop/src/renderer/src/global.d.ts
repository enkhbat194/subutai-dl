import type { SubutaiDesktopApi } from '@subutai/shared';

declare global {
  interface Window {
    subutai: SubutaiDesktopApi;
  }
}

export {};
