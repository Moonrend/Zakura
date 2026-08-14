declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string);
    scaleViewport: boolean;
    resizeSession: boolean;
    addEventListener(type: string, listener: (event: Event) => void): void;
    disconnect(): void;
  }
}

declare module "@novnc/novnc/core/rfb" {
  export default class RFB {
    constructor(target: HTMLElement, url: string);
    scaleViewport: boolean;
    resizeSession: boolean;
    addEventListener(type: string, listener: (event: Event) => void): void;
    disconnect(): void;
  }
}
