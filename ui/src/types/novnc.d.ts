// Minimal typing for noVNC (MPL-2.0), which ships no type definitions.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string } });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    sendCredentials(credentials: { username?: string; password?: string }): void;
    sendCtrlAltDel(): void;
    focus(): void;
    disconnect(): void;
    addEventListener(type: string, listener: (e: CustomEvent<any>) => void): void;
  }
}
