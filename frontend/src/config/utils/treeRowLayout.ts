interface TreeIndentOptions {
  stepRem?: number;
  baseRem?: number;
}

const DEFAULT_STEP_REM = 1.2;
const DEFAULT_BASE_REM = 0.75;

function toIndentRem(depth: number, options?: TreeIndentOptions): number {
  const stepRem = options?.stepRem ?? DEFAULT_STEP_REM;
  const baseRem = options?.baseRem ?? DEFAULT_BASE_REM;
  return depth * stepRem + baseRem;
}

export function treePaddingLeft(depth: number, options?: TreeIndentOptions): string {
  return `${toIndentRem(depth, options)}rem`;
}

export function treePaddingLeftWithOffset(
  depth: number,
  offset: string,
  options?: TreeIndentOptions,
): string {
  return `calc(${treePaddingLeft(depth, options)} + ${offset})`;
}
