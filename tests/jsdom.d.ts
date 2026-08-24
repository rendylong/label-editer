declare module 'jsdom' {
  interface JSDOMOptions {
    url?: string
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions)
    readonly window: Window & typeof globalThis
  }
}
