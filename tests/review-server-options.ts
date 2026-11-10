/** Keep the human CLI default; zero delegates E2E port allocation to the OS. */
export function reviewServerPort(args: readonly string[]): number {
  const index = args.indexOf("--port");
  return index < 0 ? 4175 : parseInt(args[index + 1] ?? "", 10);
}
