/// <reference types="vite/client" />

declare global {
  interface Window {
    desktop?: {
      getConfig?: () => Promise<{ platform: string; appVersion: string }>;
      startHost?: (args: { port: number }) => Promise<{ serverUrl: string; addresses: string[] }>;
      stopHost?: () => Promise<void>;
      notify?: (args: { title: string; body: string }) => Promise<void>;
      onOpenFileDialog?: () => Promise<string[] | null>;
    };
  }
}

export {};
