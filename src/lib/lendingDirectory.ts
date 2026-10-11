export const LENDING_DIRECTORY_PAGE_SIZE = 5;

export function lendingDirectoryRange(page: number): [number, number] {
  const start = Math.max(0, Math.floor(page)) * LENDING_DIRECTORY_PAGE_SIZE;
  return [start, start + LENDING_DIRECTORY_PAGE_SIZE - 1];
}