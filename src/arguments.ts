export function argumentsFor(args: string[], values: string[], switches: string[] = []) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (Object.hasOwn(flags, name)) throw new Error(`Duplicate option: ${arg}`);
    if (switches.includes(name)) flags[name] = "true";
    else if (values.includes(name) && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
      flags[name] = args[++i];
    } else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  return { flags, positional };
}
