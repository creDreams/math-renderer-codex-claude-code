// Narrow host boundary. These modules must be supplied by Tabby, never bundled.
declare module '@angular/core' {
  export function NgModule(metadata: unknown): (target: Function) => void;
}
declare module 'tabby-terminal' {
  export abstract class TerminalDecorator {
    attach(tab: any): void;
    detach(tab: any): void;
  }
}
declare module 'tabby-core' {
  export abstract class TabContextMenuItemProvider {
    weight: number;
    abstract getItems(tab: any, tabHeader?: boolean): Promise<any[]>;
  }
}
