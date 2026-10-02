/** Arguments shared by the profile runner and its isolated scenario regressions. */
export function scenarioArguments(file: string): string[] {
  return [file.endsWith("_test.ts") ? "test" : "run", "--config=deno.runtime.json", "-A", file];
}
