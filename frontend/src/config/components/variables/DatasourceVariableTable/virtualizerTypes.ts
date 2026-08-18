interface VirtualItemIndexLike {
  index: number;
}

interface VirtualItemRenderLike extends VirtualItemIndexLike {
  key: string | number | bigint;
  size: number;
  start: number;
}

export interface VirtualizerIndexLike {
  getVirtualItems: () => VirtualItemIndexLike[];
}

export interface VirtualizerRenderLike extends VirtualizerIndexLike {
  getTotalSize: () => number;
  getVirtualItems: () => VirtualItemRenderLike[];
}
