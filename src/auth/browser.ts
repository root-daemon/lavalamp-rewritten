import { execFile } from 'node:child_process';

export async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'linux'
        ? 'xdg-open'
        : undefined;
  if (command === undefined) {
    return false;
  }
  return new Promise((resolve) => {
    execFile(command, [url], (error) => resolve(error === null));
  });
}
